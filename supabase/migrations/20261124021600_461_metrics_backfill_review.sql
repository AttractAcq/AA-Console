-- A one-off metrics pull consumes provider quota. Freeze its dates, surfaces
-- and credential versions in a client Inbox card before any job is queued.
begin;

create table public.metrics_backfill_reviews_v6 (
 id uuid primary key default gen_random_uuid(),
 client_id uuid not null references public.clients(id) on delete cascade,
 since_day date not null,
 until_day date not null,
 surface text not null check(surface in ('paid','organic','both')),
 request_token uuid not null default gen_random_uuid(),
 accounts_snapshot jsonb not null,
 source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 applied_at timestamptz,
 applied_by uuid references auth.users(id),
 jobs_created integer not null default 0 check(jobs_created between 0 and 2),
 created_at timestamptz not null default now()
);
alter table public.metrics_backfill_reviews_v6 enable row level security;
revoke all on public.metrics_backfill_reviews_v6 from public,anon,authenticated,service_role;

create function public.metrics_backfill_accounts_v6(p_client_id uuid,p_surface text)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object(
   'surface',s.surface,'provider',s.provider,'integration_id',i.id,
   'credential_version_hash',encode(sha256(convert_to(i.credential_secret_id::text,'UTF8')),'hex'),
   'account_label',i.credential_label,'access_level',i.access_level,
   'recorded_expiry',i.token_expires_at,'grant_request_id',g.canonical_request_id)
   order by s.surface),'[]'::jsonb)
 from (values ('paid','meta'),('organic','instagram')) s(surface,provider)
 join public.client_integrations i on i.client_id=p_client_id and i.provider=s.provider
 join lateral (select q.* from public.integration_grant_reviews_v6 q
   where q.integration_id=i.id order by q.request_epoch desc limit 1) g on true
 where (p_surface='both' or s.surface=p_surface)
   and public.integration_usable(p_client_id,s.provider) is true
   and g.applied_at is not null
   and public.integration_grant_source_state_v6(g.canonical_request_id)='source_decided';
$$;
revoke all on function public.metrics_backfill_accounts_v6(uuid,text)
 from public,anon,authenticated,service_role;

create function public.metrics_backfill_preview_v6(q public.metrics_backfill_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'action','pull_metrics_history',
   'since',q.since_day,'until',q.until_day,'surface',q.surface,
   'request_token',q.request_token,'accounts',q.accounts_snapshot,
   'consequence','Queue a one-off read against the named client provider accounts and their API quotas');
$$;
create function public.metrics_backfill_hash_v6(q public.metrics_backfill_reviews_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.metrics_backfill_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.metrics_backfill_scope_v6(q public.metrics_backfill_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'review_id',q.id,
  'request_token',q.request_token,'content_hash',q.source_hash,
  'effect','queue_metrics_backfill','surfaces',q.surface,
  'since',q.since_day,'until',q.until_day);
$$;

create function public.metrics_backfill_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.metrics_backfill_reviews_v6%rowtype;
  d public.approval_decision_events_v6%rowtype; accounts jsonb;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'metrics_backfill'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_access_client(r.client_id))
  then return 'unverified'; end if;
 select * into q from public.metrics_backfill_reviews_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 select * into d from public.approval_decision_events_v6
  where request_id=r.id order by event_order desc limit 1;
 if q.applied_at is not null then
  if d.decision='approved' and d.actor_aal='aal2' and d.actor_id=q.applied_by
   and d.artifact_hash=q.source_hash and q.jobs_created=
    (case when q.surface='both' then 2 else 1 end)
   then return 'source_decided'; end if;
  return 'source_held';
 end if;
 accounts:=public.metrics_backfill_accounts_v6(q.client_id,q.surface);
 if accounts is distinct from q.accounts_snapshot
  or r.artifact_hash is distinct from q.source_hash
  or q.source_hash is distinct from public.metrics_backfill_hash_v6(q)
  or r.source_version is distinct from q.source_hash||':'||q.request_token::text
  or r.preview is distinct from public.metrics_backfill_preview_v6(q)
  or r.scope is distinct from public.metrics_backfill_scope_v6(q)
  or r.destination is distinct from 'client:metrics:'||q.client_id::text||':'||q.surface
  then return 'superseded'; end if;
 if r.expires_at<=now() then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.request_metrics_backfill_review_v6(
 p_client_id uuid,p_since date,p_until date,p_surface text default 'both')
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.metrics_backfill_reviews_v6%rowtype; accounts jsonb;
  normalized_surface text:=coalesce(p_surface,'both');
begin
 if auth.role()<>'authenticated' or auth.uid() is null
  or not (coalesce(public.is_admin(),false) or
    auth.uid()=public.active_video_approval_manager(p_client_id)) then
  raise exception 'A provisioned client approval owner must request this metrics pull.' using errcode='42501'; end if;
 if p_since is null or p_until is null or p_since>p_until or p_until>current_date
  or (p_until-p_since)+1>public.max_backfill_days()
  or normalized_surface not in ('paid','organic','both') then
  raise exception 'Choose a valid metrics window and surface.' using errcode='22023'; end if;
 accounts:=public.metrics_backfill_accounts_v6(p_client_id,normalized_surface);
 if jsonb_array_length(accounts)<>(case when normalized_surface='both' then 2 else 1 end) then
  raise exception 'Each requested surface needs a current reviewed provider credential.'
    using errcode='23514'; end if;
 select * into q from public.metrics_backfill_reviews_v6
  where client_id=p_client_id and since_day=p_since and until_day=p_until
   and surface=normalized_surface and applied_at is null
  order by created_at desc limit 1;
 if q.id is not null and q.accounts_snapshot=accounts
  and public.metrics_backfill_source_state_v6(q.canonical_request_id)='pending'
  then return q.canonical_request_id; end if;
 insert into public.metrics_backfill_reviews_v6
  (client_id,since_day,until_day,surface,accounts_snapshot,source_hash)
 values(p_client_id,p_since,p_until,normalized_surface,accounts,repeat('0',64))
 returning * into q;
 update public.metrics_backfill_reviews_v6
  set source_hash=public.metrics_backfill_hash_v6(q) where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',p_client_id,'source_system','aa_console','source_kind','metrics_backfill',
  'source_id',q.id::text,'source_version',q.source_hash||':'||q.request_token::text,
  'title','Pull '||normalized_surface||' metrics history, '||p_since||' to '||p_until,
  'artifact_hash',q.source_hash,'preview',public.metrics_backfill_preview_v6(q),
  'destination','client:metrics:'||p_client_id::text||':'||normalized_surface,
  'scope',public.metrics_backfill_scope_v6(q),'owner_role','admin',
  'requested_by',auth.uid(),'requester_kind','human',
  'expires_at',now()+interval '1 day',
  'owning_path','/clients/'||p_client_id::text||'/account/integrations'));
 update public.metrics_backfill_reviews_v6 set canonical_request_id=q.canonical_request_id
  where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.guard_metrics_backfill_job_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.metrics_backfill_reviews_v6%rowtype; rid text;
begin
 if new.agent_key<>'metrics_ingest' then return new; end if;
 if new.params->>'backfill' is distinct from 'true' then
  if current_setting('aa.metrics_scheduler',true) is distinct from 'on' then
   raise exception 'Only the scheduler may queue an ordinary metrics pull.'
    using errcode='42501';
  end if;
  return new;
 end if;
 rid:=current_setting('aa.metrics_backfill_review_id',true);
 if rid is null or rid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception 'A reviewed one-off pull is required.' using errcode='42501'; end if;
 select * into q from public.metrics_backfill_reviews_v6
  where id=rid::uuid and client_id=new.client_id for update;
 if q.id is null or q.applied_at is null
  or new.params->>'surface' not in ('paid','organic')
  or (q.surface<>'both' and q.surface<>new.params->>'surface')
  or q.since_day::text is distinct from new.params->>'since'
  or q.until_day::text is distinct from new.params->>'until'
  or q.jobs_created>=(case when q.surface='both' then 2 else 1 end)
  then raise exception 'The metrics job does not match its exact approval.' using errcode='42501'; end if;
 update public.metrics_backfill_reviews_v6 set jobs_created=jobs_created+1 where id=q.id;
 return new;
end $$;
create trigger metrics_backfill_job_review_v6 before insert on public.agent_jobs
 for each row execute function public.guard_metrics_backfill_job_v6();

create or replace function public.enqueue_metrics_ingest_jobs(p_days integer default 7)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer;
 v_since date:=current_date-greatest(coalesce(p_days,7),1);
 v_until date:=current_date;
begin
 perform set_config('aa.metrics_scheduler','on',true);
 insert into public.agent_jobs(agent_key,client_id,params)
 select 'metrics_ingest',i.client_id,
  jsonb_build_object('surface',s.surface,'since',v_since,'until',v_until)
 from public.client_integrations i
 join (values ('meta','paid'),('instagram','organic')) s(provider,surface)
  on s.provider=i.provider
 where i.ingest_enabled is true
  and public.integration_usable(i.client_id,i.provider) is true
  and not exists(select 1 from public.agent_jobs j
   where j.agent_key='metrics_ingest' and j.client_id=i.client_id
    and j.params->>'surface'=s.surface and j.status in ('queued','claimed','running'));
 get diagnostics v_count=row_count;
 perform set_config('aa.metrics_scheduler','',true);
 return v_count;
end $$;
revoke all on function public.enqueue_metrics_ingest_jobs(integer)
 from public,anon,authenticated;
grant execute on function public.enqueue_metrics_ingest_jobs(integer) to service_role;

create function public.decide_metrics_backfill_review_v6(
 p_review_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid[] language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.metrics_backfill_reviews_v6%rowtype; jobs uuid[];
begin
 if auth.role()<>'authenticated' or auth.uid() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2'
  or not coalesce(public.is_admin(),false) then
  raise exception 'A provisioned AAL2 admin must decide a metrics backfill.' using errcode='42501'; end if;
 select * into q from public.metrics_backfill_reviews_v6 where id=p_review_id for update;
 if q.id is null or q.canonical_request_id is distinct from p_request_id
  or q.applied_at is not null or public.metrics_backfill_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 x where x.id=p_request_id
   and x.status='pending' and x.preview_blocker is null) then
  raise exception 'Review the current exact backfill in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null then
  raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,q.source_hash,
  'metrics_backfill:'||q.id::text||':'||q.request_token::text,p_reason);
 if not p_approved then return '{}'::uuid[]; end if;
 update public.metrics_backfill_reviews_v6 set applied_at=now(),applied_by=auth.uid()
  where id=q.id;
 perform set_config('aa.metrics_backfill_review_id',q.id::text,true);
 select array_agg(x) into jobs from public.request_metrics_backfill(q.client_id,
  q.since_day,q.until_day,case when q.surface='both' then null else q.surface end) x;
 perform set_config('aa.metrics_backfill_review_id','',true);
 if cardinality(jobs) is distinct from (case when q.surface='both' then 2 else 1 end) then
  raise exception 'The exact reviewed metrics jobs were not all queued.' using errcode='23514'; end if;
 return jobs;
end $$;

revoke all on function public.request_metrics_backfill_review_v6(uuid,date,date,text)
 from public,anon,authenticated,service_role;
grant execute on function public.request_metrics_backfill_review_v6(uuid,date,date,text) to authenticated;
revoke all on function public.decide_metrics_backfill_review_v6(uuid,uuid,boolean,text)
 from public,anon,authenticated,service_role;
grant execute on function public.decide_metrics_backfill_review_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_metrics_backfill_job_v6()
 from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
