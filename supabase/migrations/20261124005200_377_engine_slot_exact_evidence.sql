-- Complete the existing slot-event request with trusted single-file bytes,
-- exact copy, slot timing and a named destination account. Video and
-- multi-file formats retain their distinct held review paths.
begin;
create function public.engine_slot_exact_package_v6(p_slot_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare s public.content_slots%rowtype;
  a public.client_media_assets%rowtype;
  o storage.objects%rowtype;
  v_copy jsonb;
  v_account text;
  v_count integer;
  v_provider text;
begin
  select * into s from public.content_slots where id=p_slot_id;
  if s.id is null or s.stage::text not in
    ('awaiting_approval','scheduled','published') or s.asset_id is null
    then return null; end if;
  select * into a from public.client_media_assets
    where id=s.asset_id and client_id=s.client_id;
  if a.id is null or a.media_type not in ('image','text')
    or a.content_format <> 'single' or s.format <> 'single'
    or a.render_path is not null or a.archived_at is not null
    or a.delivery_bytes_sha256 !~ '^[0-9a-f]{64}$'
    or nullif(btrim(coalesce(a.usage_rights,'')),'') is null
    or a.review_status not in ('pending','approved')
    or a.storage_path not like s.client_id::text||'/%'
    then return null; end if;
  select * into o from storage.objects
    where bucket_id='client-media' and name=a.storage_path;
  if o.id is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',pc.id,'platform',pc.platform,'version',pc.version,
    'caption',pc.caption,'hashtags',pc.hashtags,'alt_text',pc.alt_text,
    'link_url',pc.link_url,'first_comment',pc.first_comment,
    'cta',pc.cta,'source',pc.source) order by pc.platform::text,pc.id),'[]'::jsonb)
    into v_copy from public.post_copy pc where pc.asset_id=a.id;
  if v_copy='[]'::jsonb or not exists(select 1 from public.post_copy pc
    where pc.asset_id=a.id and pc.platform=s.platform
      and nullif(btrim(coalesce(pc.caption,'')),'') is not null)
    then return null; end if;
  v_provider := case s.platform::text when 'facebook' then 'meta'
    when 'instagram' then 'instagram' else null end;
  if v_provider is null then return null; end if;
  select count(*)::integer,
    max(case when v_provider='meta' then i.meta_page_id
      else i.credential_label end)
    into v_count,v_account from public.client_integrations i
    where i.client_id=s.client_id and i.provider=v_provider
      and public.integration_state_eligible(i.status,i.token_expires_at);
  if v_count<>1 or nullif(btrim(coalesce(v_account,'')),'') is null
    then return null; end if;
  return jsonb_build_object(
    'client_id',s.client_id,
    'slot',jsonb_build_object('id',s.id,'asset_id',s.asset_id,
      'platform',s.platform,'scheduled_at',s.scheduled_at,
      'format',s.format,'idea_id',s.idea_id,'brief_id',s.brief_id,
      'attempts',s.attempts),
    'asset',jsonb_build_object('id',a.id,'client_id',a.client_id,
      'title',a.title,'media_type',a.media_type,'content_format',a.content_format,
      'storage_path',a.storage_path,'file_sha256',a.delivery_bytes_sha256,
      'usage_rights',a.usage_rights,'intake_source',a.intake_source,
      'brief_id',a.brief_id,'source_asset_id',a.source_asset_id),
    'storage',jsonb_build_object('bucket','client-media','object_id',o.id,
      'version',o.version,'updated_at',o.updated_at),
    'post_copy',v_copy,
    'provider',v_provider,'account_ref',v_account,
    'consequence','Approve this asset and create one scheduled organic post. Publication requires a separate exact-version decision.');
end $$;

create function public.engine_slot_exact_hash_v6(p_slot_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(public.engine_slot_exact_package_v6(p_slot_id)::text,
    'UTF8')),'hex');
$$;

create function public.engine_slot_exact_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone='UTC' as $$
declare r public.approval_requests_v6%rowtype;
  e public.approval_request_evidence_v6%rowtype;
  p jsonb;
  h text;
  v_state text;
begin
  v_state:=public.approval_source_state_v6(p_request_id);
  if v_state not in ('pending','source_decided') then return v_state; end if;
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if r.id is null or r.source_kind <> 'engine_slot' then return 'unverified'; end if;
  select * into e from public.approval_request_evidence_v6 where request_id=r.id;
  if e.id is null then return 'source_held'; end if;
  p:=public.engine_slot_exact_package_v6(r.source_id::uuid);
  h:=public.engine_slot_exact_hash_v6(r.source_id::uuid);
  if p is null then return 'superseded'; end if;
  if e.artifact_hash is distinct from h
    or e.preview->'exact_package' is distinct from p
    or e.account_ref is distinct from p->>'account_ref'
    or e.destination is distinct from r.destination
    or e.scope is distinct from r.scope
    then return 'superseded'; end if;
  return v_state;
end $$;

create function public.request_engine_slot_exact_review_v6(p_slot_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare s public.content_slots%rowtype;
  r public.approval_requests_v6%rowtype;
  e public.slot_events%rowtype;
  p jsonb;
  h text;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must prepare Engine review.'
      using errcode='42501'; end if;
  select * into s from public.content_slots where id=p_slot_id for update;
  if s.id is null or not public.can_access_client(s.client_id) then
    raise exception 'Engine slot unavailable for this client.'
      using errcode='42501'; end if;
  if (select count(*) from public.slot_events
    where slot_id=s.id and to_stage::text='awaiting_approval')<>1 then
    raise exception 'The Engine slot has no unique approval entry.'
      using errcode='23514'; end if;
  select * into e from public.slot_events
    where slot_id=s.id and to_stage::text='awaiting_approval';
  select * into r from public.approval_requests_v6
    where client_id=s.client_id and source_system='aa_console'
      and source_kind='engine_slot' and source_id=s.id::text
      and source_version=e.id::text for update;
  if r.id is null or public.approval_source_state_v6(r.id)<>'pending'
    or r.expires_at<=now() then
    raise exception 'The current Engine approval entry is unavailable.'
      using errcode='23514'; end if;
  p:=public.engine_slot_exact_package_v6(s.id);
  h:=public.engine_slot_exact_hash_v6(s.id);
  if p is null or h is null then
    raise exception 'Engine review needs trusted single-file bytes, rights, copy and a destination account.'
      using errcode='23514'; end if;
  perform public.attach_approval_evidence_v6(r.id,r.source_version,
    'engine_slot:'||e.id::text,jsonb_build_object(
      'artifact_hash',h,'preview',r.preview||jsonb_build_object('exact_package',p),
      'destination',r.destination,'account_ref',p->>'account_ref',
      'scope',r.scope));
  return r.id;
end $$;

create function public.guard_engine_slot_exact_package_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare r public.approval_requests_v6%rowtype;
begin
  if old.stage::text <> 'awaiting_approval'
    or new.stage::text <> 'scheduled' then return new; end if;
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 human must approve the Engine slot.'
      using errcode='42501'; end if;
  select * into r from public.approval_requests_v6
    where client_id=old.client_id and source_system='aa_console'
      and source_kind='engine_slot' and source_id=old.id::text
      and source_version=(select e.id::text from public.slot_events e
        where e.slot_id=old.id and e.to_stage::text='awaiting_approval'
        limit 1);
  if r.id is null or public.engine_slot_exact_source_state_v6(r.id)<>'pending'
    then raise exception 'The exact Engine media, copy or destination changed.'
      using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.guard_engine_slot_exact_package_v6()
  from public,anon,authenticated,service_role;
create trigger engine_slot_exact_package_guard_v6
  before update of stage on public.content_slots
  for each row execute function public.guard_engine_slot_exact_package_v6();

revoke all on function public.engine_slot_exact_package_v6(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.engine_slot_exact_hash_v6(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.engine_slot_exact_source_state_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.engine_slot_exact_source_state_v6(uuid)
  to authenticated,service_role;
revoke all on function public.request_engine_slot_exact_review_v6(uuid)
  from public,anon,service_role;
grant execute on function public.request_engine_slot_exact_review_v6(uuid)
  to authenticated;
select public.lock_down_definer_functions();
commit;
