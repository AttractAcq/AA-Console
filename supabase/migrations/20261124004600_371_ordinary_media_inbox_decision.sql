-- An ordinary single-file asset gains human approval only from its exact
-- AAL2 Inbox decision. Engine-owned slots and video retain separate gates.
begin;
create table public.ordinary_media_signoffs_v6 (
  asset_id uuid primary key references public.client_media_assets(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  approved_request_id uuid not null unique references public.approval_requests_v6(id),
  approved_hash text not null check (approved_hash ~ '^[0-9a-f]{64}$'),
  approved_by uuid not null references public.profiles(id),
  approved_at timestamptz not null default now(),
  foreign key(asset_id,client_id) references public.client_media_assets(id,client_id)
);
alter table public.ordinary_media_signoffs_v6 enable row level security;
create policy ordinary_media_signoffs_read_v6
  on public.ordinary_media_signoffs_v6 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.ordinary_media_signoffs_v6
  from public,anon,authenticated,service_role;
grant select on public.ordinary_media_signoffs_v6 to authenticated,service_role;
create trigger ordinary_media_signoffs_immutable_v6
  before update or delete on public.ordinary_media_signoffs_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();

create or replace function public.ordinary_media_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare r public.approval_requests_v6%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  a public.client_media_assets%rowtype;
  s public.ordinary_media_signoffs_v6%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if r.id is null or r.source_system <> 'aa_console'
    or r.source_kind <> 'ordinary_media'
    or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where id=r.source_id::uuid and client_id=r.client_id
      and canonical_request_id=r.id;
  if q.id is null then return 'cancelled'; end if;
  select * into a from public.client_media_assets
    where id=q.asset_id and client_id=q.client_id;
  if a.id is null then return 'cancelled'; end if;
  h := public.ordinary_media_review_hash_v6(q);
  if h is null or q.source_hash is distinct from h
    or r.artifact_hash is distinct from h
    or r.source_version is distinct from h||':'||q.request_token::text
    or r.preview is distinct from public.ordinary_media_review_preview_v6(q)
    or r.scope is distinct from public.ordinary_media_review_scope_v6(q)
    or r.destination is distinct from 'creative_source:'||a.id::text
    then return 'superseded'; end if;
  if a.media_type not in ('image','text') or a.content_format <> 'single'
    or a.render_path is not null or a.edit_stage <> 'review_ready'
    or a.archived_at is not null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null
    or exists(select 1 from public.content_slots cs
      where cs.asset_id=a.id and cs.stage='awaiting_approval')
    then return 'source_held'; end if;
  select * into s from public.ordinary_media_signoffs_v6 where asset_id=a.id;
  if a.human_approved_at is not null then
    if s.asset_id=a.id and s.approved_request_id=r.id and s.approved_hash=h
      then return 'source_decided'; end if;
    return 'source_held';
  end if;
  if s.asset_id is not null then
    if s.approved_request_id=r.id and s.approved_hash=h then return 'pending'; end if;
    return 'source_held';
  end if;
  if a.review_status not in ('pending','approved') then return 'source_held'; end if;
  return 'pending';
end $$;

create function public.guard_ordinary_media_human_approval_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare s public.ordinary_media_signoffs_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
begin
  if new.human_approved_at is null or old.human_approved_at is not null
    or new.media_type not in ('image','text') or new.content_format <> 'single'
    or exists(select 1 from public.content_slots cs
      where cs.asset_id=new.id and cs.stage='awaiting_approval')
    then return new; end if;
  select * into s from public.ordinary_media_signoffs_v6 where asset_id=new.id;
  select * into r from public.approval_requests_v6
    where id=s.approved_request_id and client_id=new.client_id
      and source_system='aa_console' and source_kind='ordinary_media';
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  if s.asset_id is null or r.id is null or s.approved_by is distinct from auth.uid()
    or d.decision is distinct from 'approved' or d.actor_aal <> 'aal2'
    or d.actor_id is distinct from auth.uid()
    or d.artifact_hash is distinct from s.approved_hash
    or public.ordinary_media_review_source_state_v6(r.id) <> 'pending'
    then raise exception 'Approve this exact creative in Approval Inbox.'
      using errcode='42501'; end if;
  return new;
end $$;
create trigger ordinary_media_human_approval_guard_v6
  before update of human_approved_at on public.client_media_assets
  for each row execute function public.guard_ordinary_media_human_approval_v6();

create function public.approve_ordinary_media_inbox_v6(
  p_review_id uuid,p_request_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone='UTC' as $$
declare q public.ordinary_media_review_requests_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 human must approve creative.'
      using errcode='42501'; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where id=p_review_id for update;
  if q.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(q.client_id),false))
    then raise exception 'The creative decision owner is unavailable.'
      using errcode='42501'; end if;
  h := public.ordinary_media_review_hash_v6(q);
  select * into r from public.approval_requests_v6
    where id=p_request_id and id=q.canonical_request_id
      and client_id=q.client_id and source_system='aa_console'
      and source_kind='ordinary_media' and source_id=q.id::text
      and artifact_hash=h;
  if r.id is null or public.ordinary_media_review_source_state_v6(r.id)<>'pending'
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=r.id and i.status='pending' and i.preview_blocker is null) then
    raise exception 'Review the current creative file in Approval Inbox.'
      using errcode='23514'; end if;
  perform public.record_approval_decision_v6(r.id,'approved',h,
    'ordinary_media:'||q.id::text||':'||q.request_token::text);
  insert into public.ordinary_media_signoffs_v6
    (asset_id,client_id,approved_request_id,approved_hash,approved_by)
    values(q.asset_id,q.client_id,r.id,h,auth.uid());
  perform public.review_media_asset(q.asset_id,'approved'::public.review_status);
  return q.asset_id;
end $$;

create function public.reject_ordinary_media_inbox_v6(
  p_review_id uuid,p_request_id uuid,p_reason text)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone='UTC' as $$
declare q public.ordinary_media_review_requests_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A rejection reason is required.' using errcode='22023'; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where id=p_review_id for update;
  if q.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(q.client_id),false))
    then raise exception 'The creative decision owner is unavailable.'
      using errcode='42501'; end if;
  h := public.ordinary_media_review_hash_v6(q);
  select * into r from public.approval_requests_v6
    where id=p_request_id and id=q.canonical_request_id
      and client_id=q.client_id and source_system='aa_console'
      and source_kind='ordinary_media' and source_id=q.id::text
      and artifact_hash=h;
  if r.id is null or public.ordinary_media_review_source_state_v6(r.id)<>'pending'
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=r.id and i.status='pending' and i.preview_blocker is null) then
    raise exception 'This creative version is no longer reviewable.'
      using errcode='23514'; end if;
  perform public.record_approval_decision_v6(r.id,'rejected',h,
    'ordinary_media_rejection:'||q.id::text||':'||q.request_token::text,p_reason);
  perform public.review_media_asset(q.asset_id,'rejected'::public.review_status,p_reason);
  return q.asset_id;
end $$;

revoke all on function public.guard_ordinary_media_human_approval_v6()
  from public,anon,authenticated,service_role;
revoke all on function public.approve_ordinary_media_inbox_v6(uuid,uuid)
  from public,anon,service_role;
grant execute on function public.approve_ordinary_media_inbox_v6(uuid,uuid)
  to authenticated;
revoke all on function public.reject_ordinary_media_inbox_v6(uuid,uuid,text)
  from public,anon,service_role;
grant execute on function public.reject_ordinary_media_inbox_v6(uuid,uuid,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;
