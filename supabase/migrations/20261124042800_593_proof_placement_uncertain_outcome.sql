-- A Business Profile POST with an unknown result is not a failed POST. Hold
-- it for account inspection; a second automatic POST can create a duplicate.
begin;

alter table public.proof_placements
  drop constraint if exists proof_placements_status_check;
alter table public.proof_placements
  add constraint proof_placements_status_check check (status in (
    'drafted','awaiting_approval','approved','queued','placing',
    'awaiting_manual_placement','bound','placed','verified','failed',
    'uncertain','rejected','retraction_required','retracted'));
alter table public.proof_placement_events
  drop constraint if exists proof_placement_events_event_check;
alter table public.proof_placement_events
  add constraint proof_placement_events_event_check check (event in (
    'drafted','requested','approved','rejected','queued','claimed','bound',
    'placed','verified','cited','failed','uncertain','retraction_required','retracted'));
insert into public.proof_placement_transitions(from_status,to_status,note)
values ('placing','uncertain','The provider effect may have occurred; inspect before another attempt.')
on conflict (from_status,to_status) do nothing;

create function public.record_proof_placement_uncertain_v8(
  p_placement_id uuid,p_reason text,p_external_id text default null,
  p_external_url text default null)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare v public.proof_placements%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the proof placer may record an uncertain effect.'
      using errcode='42501';
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null
    or length(p_reason)>1000
    or (p_external_id is not null and p_external_id !~
      '^accounts/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/localPosts/[A-Za-z0-9_-]+$')
    or (p_external_url is not null and p_external_url !~ '^https://') then
    raise exception 'Uncertain placement evidence is incomplete.' using errcode='23514';
  end if;
  update public.proof_placements set status='uncertain',lease_until=null,
    last_error=p_reason,external_id=p_external_id,external_url=p_external_url
    where id=p_placement_id and status='placing'
      and destination_key='google_business_profile'
    returning * into v;
  if not found then
    raise exception 'Only an active Business Profile placement can become uncertain.'
      using errcode='23514';
  end if;
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,detail,external_ref)
  values (v.id,v.client_id,'uncertain','agent',p_reason,
    coalesce(p_external_id,p_external_url));
end $$;
revoke all on function public.record_proof_placement_uncertain_v8(uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_proof_placement_uncertain_v8(uuid,text,text,text)
  to service_role;

create or replace function public.reap_stale_proof_placement_claims()
returns integer language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service may reap placements.' using errcode='42501';
  end if;
  with stale as (
    update public.proof_placements set status='uncertain',lease_until=null,
      last_error='The attempt stopped without recording an outcome. Inspect the destination before another attempt.'
    where status='placing' and (lease_until is null or lease_until<now())
    returning id,client_id)
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,detail)
  select id,client_id,'uncertain','system',
    'The lease expired with no confirmed provider outcome.' from stale;
  get diagnostics v_count=row_count;
  return v_count;
end $$;
revoke all on function public.reap_stale_proof_placement_claims()
  from public,anon,authenticated,service_role;
grant execute on function public.reap_stale_proof_placement_claims()
  to service_role;
select public.lock_down_definer_functions();
commit;
