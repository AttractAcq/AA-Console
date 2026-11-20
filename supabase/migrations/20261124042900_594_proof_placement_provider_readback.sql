-- An exact Business Profile GET is a separate observation from a POST receipt.
-- It never retries a placement, changes its status, or proves media bytes.
begin;

create table public.proof_placement_provider_reads_v8 (
  id uuid primary key default gen_random_uuid(),
  placement_id uuid not null references public.proof_placements(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  job_id uuid not null references public.agent_jobs(id) on delete restrict,
  external_id text not null,
  account_ref text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  result text not null check (result in
    ('live_exact_text','live_media_unverified','nonlive','mismatch','not_found','unavailable')),
  provider_state text,
  observed_summary_sha256 text check (observed_summary_sha256 is null
    or observed_summary_sha256 ~ '^[0-9a-f]{64}$'),
  provider_url text,
  checked_at timestamptz not null default clock_timestamp(),
  check (result not in ('not_found','unavailable')
    or (provider_state is null and observed_summary_sha256 is null and provider_url is null)),
  check (result not in ('live_exact_text','live_media_unverified')
    or (provider_state='LIVE' and observed_summary_sha256 is not null))
);
create index proof_placement_provider_reads_v8_latest
  on public.proof_placement_provider_reads_v8(placement_id,checked_at desc,id desc);
create unique index proof_placement_provider_reads_v8_one_per_job
  on public.proof_placement_provider_reads_v8(job_id);
alter table public.proof_placement_provider_reads_v8 enable row level security;
create policy proof_placement_provider_reads_v8_scoped_read
  on public.proof_placement_provider_reads_v8 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.proof_placement_provider_reads_v8
  from public,anon,authenticated,service_role;
grant select on public.proof_placement_provider_reads_v8 to authenticated,service_role;
create trigger proof_placement_provider_reads_v8_append_only
  before update or delete on public.proof_placement_provider_reads_v8
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger proof_placement_provider_reads_v8_no_truncate
  before truncate on public.proof_placement_provider_reads_v8
  for each statement execute function public.reject_approval_ledger_mutation_v6();

create view public.proof_placement_provider_read_latest_v8
with (security_invoker=true) as
select distinct on (placement_id)
  id,placement_id,client_id,job_id,external_id,account_ref,payload_hash,
  result,provider_state,observed_summary_sha256,provider_url,checked_at
from public.proof_placement_provider_reads_v8
order by placement_id,checked_at desc,id desc;
revoke all on public.proof_placement_provider_read_latest_v8
  from public,anon,authenticated,service_role;
grant select on public.proof_placement_provider_read_latest_v8
  to authenticated,service_role;

insert into public.agents
  (agent_key,name,initials,domain,description,requires_upstream,config,paused)
values ('proof_placement_reconciler','Proof Placement Readback','PR','proof',
  'Reads one recorded Business Profile post ID without making another placement.',
  '{}','{}',false)
on conflict (agent_key) do nothing;
create unique index proof_placement_one_active_read_job_v8
  on public.agent_jobs(input_id)
  where agent_key='proof_placement_reconciler'
    and input_table='proof_placements' and input_id is not null
    and status in ('queued','claimed','running','paused');

create function public.request_proof_placement_readback_v8(p_placement_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.proof_placements%rowtype; v_job uuid;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A provisioned AAL2 owner must request provider readback.'
      using errcode='42501';
  end if;
  select * into p from public.proof_placements where id=p_placement_id for update;
  if p.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(p.client_id),false)) then
    raise exception 'Only the client approval owner may request provider readback.'
      using errcode='42501';
  end if;
  if p.destination_key<>'google_business_profile'
    or p.status not in ('uncertain','placed','verified')
    or coalesce(p.external_id,'') !~
      '^accounts/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/localPosts/[A-Za-z0-9_-]+$' then
    raise exception 'A recorded Business Profile post ID is required.'
      using errcode='23514';
  end if;
  select id into v_job from public.agent_jobs where agent_key='proof_placement_reconciler'
    and input_table='proof_placements' and input_id=p.id
    and status in ('queued','claimed','running','paused')
    order by created_at desc limit 1;
  if v_job is not null then return v_job; end if;
  insert into public.agent_jobs
    (agent_key,client_id,input_table,input_id,params,created_by)
  values ('proof_placement_reconciler',p.client_id,'proof_placements',p.id,
    jsonb_build_object('external_id',p.external_id),auth.uid())
    on conflict do nothing returning id into v_job;
  if v_job is null then
    select id into v_job from public.agent_jobs where agent_key='proof_placement_reconciler'
      and input_table='proof_placements' and input_id=p.id
      and status in ('queued','claimed','running','paused')
      order by created_at desc limit 1;
  end if;
  return v_job;
end $$;
revoke all on function public.request_proof_placement_readback_v8(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.request_proof_placement_readback_v8(uuid)
  to authenticated;

create function public.proof_placement_readback_target_v8(
  p_placement_id uuid,p_client_id uuid,p_job_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare p public.proof_placements%rowtype; v_account text;
begin
  if auth.role() is distinct from 'service_role' then return null; end if;
  select * into p from public.proof_placements
    where id=p_placement_id and client_id=p_client_id;
  if p.id is null or p.destination_key<>'google_business_profile'
    or p.status not in ('uncertain','placed','verified')
    or coalesce(p.external_id,'') !~
      '^accounts/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/localPosts/[A-Za-z0-9_-]+$'
    or not exists(select 1 from public.agent_jobs j where j.id=p_job_id
      and j.agent_key='proof_placement_reconciler'
      and j.client_id=p.client_id and j.input_table='proof_placements'
      and j.input_id=p.id and j.status='running') then return null; end if;
  select account_ref into v_account from public.client_proof_destinations
    where client_id=p.client_id and destination_key=p.destination_key;
  if v_account is null
    or v_account !~ '^accounts/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+$'
    or not starts_with(p.external_id,v_account || '/localPosts/')
    or public.proof_placement_payload_hash_v6(p.artifact_version_id,p.proof_id,
      p.asset_id,p.destination_key) is distinct from p.payload_hash then return null; end if;
  return jsonb_build_object('placement_id',p.id,'client_id',p.client_id,
    'external_id',p.external_id,'account_ref',v_account,
    'payload_hash',p.payload_hash,'media_required',p.asset_id is not null,
    'artifact_version_id',p.artifact_version_id,'proof_id',p.proof_id,
    'asset_id',p.asset_id);
end $$;
revoke all on function public.proof_placement_readback_target_v8(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.proof_placement_readback_target_v8(uuid,uuid,uuid)
  to service_role;

create function public.record_proof_placement_provider_read_v8(
  p_placement_id uuid,p_client_id uuid,p_job_id uuid,p_external_id text,
  p_account_ref text,p_payload_hash text,p_result text,p_provider_state text,
  p_observed_summary_sha256 text,p_provider_url text)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare target jsonb; v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the readback worker may record a provider observation.'
      using errcode='42501';
  end if;
  target:=public.proof_placement_readback_target_v8(p_placement_id,p_client_id,p_job_id);
  if target is null or target->>'external_id' is distinct from p_external_id
    or target->>'account_ref' is distinct from p_account_ref
    or target->>'payload_hash' is distinct from p_payload_hash
    or p_result not in ('live_exact_text','live_media_unverified','nonlive',
      'mismatch','not_found','unavailable')
    or (p_result='live_exact_text' and (target->>'media_required')::boolean)
    or (p_result='live_media_unverified' and not (target->>'media_required')::boolean)
    or (p_provider_url is not null and p_provider_url !~ '^https://') then
    raise exception 'Provider readback target or result changed.' using errcode='23514';
  end if;
  insert into public.proof_placement_provider_reads_v8
    (placement_id,client_id,job_id,external_id,account_ref,payload_hash,
      result,provider_state,observed_summary_sha256,provider_url)
  values (p_placement_id,p_client_id,p_job_id,p_external_id,p_account_ref,p_payload_hash,
    p_result,p_provider_state,p_observed_summary_sha256,p_provider_url)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.record_proof_placement_provider_read_v8(
  uuid,uuid,uuid,text,text,text,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_proof_placement_provider_read_v8(
  uuid,uuid,uuid,text,text,text,text,text,text,text)
  to service_role;
select public.lock_down_definer_functions();
commit;
