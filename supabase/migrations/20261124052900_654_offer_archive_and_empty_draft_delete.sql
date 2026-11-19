-- Retire offers from new work without deleting immutable versions or links.
begin;

alter table public.service_offers
  add column archived_at timestamptz,
  add column archived_by uuid references public.profiles(id);

create table public.service_offer_archive_events_v10 (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null,
  client_id uuid not null,
  action text not null check (action in ('archive','restore','delete_empty_draft')),
  actor_id uuid not null references public.profiles(id),
  occurred_at timestamptz not null default now(),
  version_count integer not null check (version_count>=0),
  service_name text not null
);
create index service_offer_archive_events_v10_client_idx
  on public.service_offer_archive_events_v10(client_id,occurred_at desc);
alter table public.service_offer_archive_events_v10 enable row level security;
create policy service_offer_archive_events_v10_read
  on public.service_offer_archive_events_v10 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.service_offer_archive_events_v10 from public,anon,authenticated;
grant select on public.service_offer_archive_events_v10 to authenticated,service_role;

create function public.guard_archived_offer_new_use_v10()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare v_offer_id uuid; v_client_id uuid; v_archived_at timestamptz;
begin
  if tg_table_name='service_offer_versions' then
    v_offer_id:=new.offer_id; v_client_id:=new.client_id;
  elsif tg_table_name='service_offer_signoffs' then
    select v.offer_id,v.client_id into v_offer_id,v_client_id
      from public.service_offer_versions v where v.id=new.offer_version_id;
  elsif tg_table_name='client_campaigns' then
    if new.offer_version_id is null then return new; end if;
    select v.offer_id,v.client_id into v_offer_id,v_client_id
      from public.service_offer_versions v where v.id=new.offer_version_id;
  elsif tg_table_name='campaign_manifest_offers' then
    select v.offer_id,v.client_id into v_offer_id,v_client_id
      from public.service_offer_versions v where v.id=new.offer_version_id;
  end if;
  -- Serialize a new use with archive/restore so neither can pass an old read.
  select o.archived_at into v_archived_at from public.service_offers o
    where o.id=v_offer_id and o.client_id=v_client_id for update;
  if v_archived_at is not null then
    raise exception 'This offer is archived. Restore it before creating a version, signoff or campaign binding.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger guard_archived_offer_version_v10
  before insert on public.service_offer_versions
  for each row execute function public.guard_archived_offer_new_use_v10();
create trigger guard_archived_offer_signoff_v10
  before insert on public.service_offer_signoffs
  for each row execute function public.guard_archived_offer_new_use_v10();
create trigger guard_archived_offer_campaign_v10
  before insert or update of offer_version_id on public.client_campaigns
  for each row execute function public.guard_archived_offer_new_use_v10();
create trigger guard_archived_offer_manifest_v10
  before insert on public.campaign_manifest_offers
  for each row execute function public.guard_archived_offer_new_use_v10();

-- The Inbox must show archive as a source hold before the signoff attempt.
create or replace function public.service_offer_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare r public.approval_requests_v6%rowtype;
  v public.service_offer_versions%rowtype; o public.service_offers%rowtype;
  s public.secondary_offer_sources_v7%rowtype; v_claim jsonb;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if not found or r.source_system<>'aa_console' or r.source_kind<>'service_offer'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  if r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into v from public.service_offer_versions where id=r.source_id::uuid;
  if not found then return 'cancelled'; end if;
  if v.client_id is distinct from r.client_id
    or v.content_hash is distinct from r.source_version
    or v.content_hash is distinct from r.artifact_hash
    or public.service_offer_approval_preview_v6(v) is distinct from r.preview
    or r.scope is distinct from jsonb_build_object(
      'client_id',v.client_id,'offer_id',v.offer_id,
      'offer_version_id',v.id,'version',v.version,'content_hash',v.content_hash)
    then return 'superseded'; end if;
  if exists(select 1 from public.service_offer_versions newer
    where newer.offer_id=v.offer_id and newer.version>v.version) then return 'superseded'; end if;
  select * into o from public.service_offers where id=v.offer_id and client_id=v.client_id;
  if o.archived_at is not null then return 'source_held'; end if;
  if o.kind='secondary' then
    select * into s from public.secondary_offer_sources_v7
      where offer_id=o.id and client_id=o.client_id;
    if not found or not public.opportunity_approval_current_v6(s.opportunity_id)
      or public.opportunity_approval_hash_v6(s.opportunity_id) is distinct from s.opportunity_hash
      or public.opportunity_approval_preview_v6(s.opportunity_id) is distinct from s.opportunity_snapshot
      then return 'source_held'; end if;
  elsif exists(select 1 from public.main_offer_sources_v7 main where main.offer_id=o.id)
    and not coalesce(public.main_offer_source_current_v7(o.id),false) then
    return 'source_held';
  end if;
  if exists(select 1 from public.service_offer_signoffs signed
    where signed.offer_version_id=v.id) then return 'source_decided'; end if;
  for v_claim in select value from jsonb_array_elements(v.claims) loop
    if v_claim->>'kind'='quantified' and
      (coalesce(v_claim->>'proof_asset_id','') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not exists(select 1 from public.client_proof_assets proof
        where proof.id::text=v_claim->>'proof_asset_id'
          and proof.client_id=v.client_id and proof.usage_rights='approved'
          and (proof.expires_on is null or proof.expires_on>=current_date)))
      then return 'source_held'; end if;
  end loop;
  return 'pending';
end $$;

create function public.set_service_offer_archived_v10(p_offer_id uuid,p_archive boolean)
returns public.service_offers language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare result public.service_offers%rowtype; versions integer;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'A provisioned client operator is required.' using errcode='42501'; end if;
  select * into result from public.service_offers where id=p_offer_id for update;
  if not found or not (coalesce(public.is_admin(),false) or
    coalesce(auth.uid()=public.active_video_approval_manager(result.client_id),false)) then
    raise exception 'The offer or its client operator is unavailable.' using errcode='42501'; end if;
  if (result.archived_at is not null)=p_archive then return result; end if;
  select count(*) into versions from public.service_offer_versions where offer_id=p_offer_id;
  update public.service_offers set archived_at=case when p_archive then now() else null end,
    archived_by=case when p_archive then auth.uid() else null end
    where id=p_offer_id returning * into result;
  insert into public.service_offer_archive_events_v10
    (offer_id,client_id,action,actor_id,version_count,service_name)
    values(p_offer_id,result.client_id,case when p_archive then 'archive' else 'restore' end,
      auth.uid(),versions,result.service_name);
  return result;
end $$;

create function public.delete_empty_service_offer_v10(p_offer_id uuid)
returns void language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare offer_row public.service_offers%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'A provisioned client operator is required.' using errcode='42501'; end if;
  select * into offer_row from public.service_offers where id=p_offer_id for update;
  if not found or not (coalesce(public.is_admin(),false) or
    coalesce(auth.uid()=public.active_video_approval_manager(offer_row.client_id),false)) then
    raise exception 'The offer or its client operator is unavailable.' using errcode='42501'; end if;
  if exists(select 1 from public.service_offer_versions where offer_id=p_offer_id)
    or exists(select 1 from public.opportunity_links
      where offer_id=p_offer_id and campaign_id is not null) then
    raise exception 'Only an unversioned, unlinked draft may be deleted. Archive this offer instead.'
      using errcode='23514'; end if;
  insert into public.service_offer_archive_events_v10
    (offer_id,client_id,action,actor_id,version_count,service_name)
    values(p_offer_id,offer_row.client_id,'delete_empty_draft',auth.uid(),0,
      offer_row.service_name);
  delete from public.service_offers where id=p_offer_id;
end $$;

revoke all on function public.set_service_offer_archived_v10(uuid,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.set_service_offer_archived_v10(uuid,boolean)
  to authenticated;
revoke all on function public.delete_empty_service_offer_v10(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.delete_empty_service_offer_v10(uuid)
  to authenticated;
select public.lock_down_definer_functions();
commit;
