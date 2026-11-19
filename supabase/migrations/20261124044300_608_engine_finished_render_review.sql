-- A finished single-file render is the Engine asset under review. Preserve
-- the exact packet for source-only files so existing decisions keep their hash.
begin;
create or replace function public.engine_slot_exact_package_v6(p_slot_id uuid)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare s public.content_slots%rowtype;
  a public.client_media_assets%rowtype;
  o storage.objects%rowtype;
  v_copy jsonb;
  v_account text;
  v_count integer;
  v_provider text;
  v_path text;
begin
  select * into s from public.content_slots where id=p_slot_id;
  if s.id is null or s.stage::text not in
    ('awaiting_approval','scheduled','published') or s.asset_id is null
    then return null; end if;
  select * into a from public.client_media_assets
    where id=s.asset_id and client_id=s.client_id;
  v_path:=coalesce(nullif(btrim(a.render_path),''),a.storage_path);
  if a.id is null or a.media_type not in ('image','text')
    or a.content_format <> 'single' or s.format <> 'single'
    or a.archived_at is not null
    or a.delivery_bytes_sha256 !~ '^[0-9a-f]{64}$'
    or nullif(btrim(coalesce(a.usage_rights,'')),'') is null
    or a.review_status not in ('pending','approved')
    or a.storage_path not like s.client_id::text||'/%'
    or v_path not like s.client_id::text||'/%'
    then return null; end if;
  select * into o from storage.objects
    where bucket_id='client-media' and name=v_path;
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
      'brief_id',a.brief_id,'source_asset_id',a.source_asset_id)
      || case when nullif(btrim(a.render_path),'') is not null
        then jsonb_build_object('render_path',v_path) else '{}'::jsonb end,
    'storage',jsonb_build_object('bucket','client-media','object_id',o.id,
      'version',o.version,'updated_at',o.updated_at),
    'post_copy',v_copy,
    'provider',v_provider,'account_ref',v_account,
    'consequence','Approve this asset and create one scheduled organic post. Publication requires a separate exact-version decision.');
end $$;

create or replace function public.decide_engine_slot_inbox_v6(
  p_slot_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare s public.content_slots%rowtype;
  r public.approval_requests_v6%rowtype;
  e public.approval_request_evidence_v6%rowtype;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A provisioned AAL2 human must decide the Engine slot.'
      using errcode='42501'; end if;
  if p_approved is null or (not p_approved
    and nullif(btrim(coalesce(p_reason,'')),'') is null) then
    raise exception 'A decision and rejection reason are required.'
      using errcode='22023'; end if;
  select * into s from public.content_slots where id=p_slot_id for update;
  if s.id is null or s.stage::text<>'awaiting_approval' then
    raise exception 'Engine slot is no longer awaiting review.'
      using errcode='23514'; end if;
  select * into r from public.approval_requests_v6
    where id=p_request_id and client_id=s.client_id
      and source_system='aa_console' and source_kind='engine_slot'
      and source_id=s.id::text for update;
  if r.id is null or not public.can_review_approval_request_v6(s.client_id,r.owner_role)
    then raise exception 'The exact Engine request or reviewer is unavailable.'
      using errcode='42501'; end if;
  -- Freeze the rows consulted by the live package check through the source
  -- transition; a concurrent edit cannot change the reviewed bytes or copy.
  perform 1 from public.client_media_assets where id=s.asset_id for update;
  perform 1 from storage.objects o join public.client_media_assets a
    on o.bucket_id='client-media'
      and o.name=coalesce(nullif(btrim(a.render_path),''),a.storage_path)
    where a.id=s.asset_id for share of o;
  perform 1 from public.post_copy where asset_id=s.asset_id for share;
  perform 1 from public.client_integrations i
    where i.client_id=s.client_id and i.provider in ('meta','instagram')
    for share;
  select * into e from public.approval_request_evidence_v6
    where request_id=r.id;
  if e.id is null or public.engine_slot_exact_source_state_v6(r.id)<>'pending'
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=r.id and i.status='pending' and i.preview_blocker is null)
    then raise exception 'Review the current exact Engine package in Approval Inbox.'
      using errcode='23514'; end if;
  perform public.record_approval_decision_v6(r.id,
    case when p_approved then 'approved' else 'rejected' end,
    e.artifact_hash,
    case when p_approved then 'engine_slot:' else 'engine_slot_rejection:' end
      ||r.source_version,p_reason);
  if p_approved then
    perform public.approve_slot(s.id);
  else
    perform public.reject_slot(s.id,p_reason);
  end if;
  return s.id;
end $$;

select public.lock_down_definer_functions();
commit;
