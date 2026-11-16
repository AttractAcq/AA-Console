-- A lead magnet approval is for one file hash, one delivery route and exact
-- words. The initial card is blocked until the runtime downloads and hashes
-- the stored bytes. Existing historical approvals are labelled legacy and
-- are not retroactively represented as AAL2 decisions.
begin;
alter table public.lead_magnet_approvals
  add column inbox_enforced_v6 boolean not null default false;
alter table public.lead_magnet_approvals
  alter column inbox_enforced_v6 set default true;

create function public.enforce_new_lead_magnet_inbox_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    new.inbox_enforced_v6 := true;
  elsif new.inbox_enforced_v6 is distinct from old.inbox_enforced_v6 then
    raise exception 'The lead magnet Inbox cohort is immutable.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger lead_magnet_inbox_cohort_insert_v6
  before insert on public.lead_magnet_approvals
  for each row execute function public.enforce_new_lead_magnet_inbox_v6();
create trigger lead_magnet_inbox_cohort_update_v6
  before update of inbox_enforced_v6 on public.lead_magnet_approvals
  for each row execute function public.enforce_new_lead_magnet_inbox_v6();

create function public.lead_magnet_inbox_preview_v6(
  p_approval public.lead_magnet_approvals)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'approval_id',p_approval.id,'client_id',p_approval.client_id,
    'magnet_id',m.id,'magnet_name',m.name,'objective',m.objective,
    'audience',m.audience,'format',m.format,'campaign_id',m.campaign_id,
    'offer_version_id',m.offer_version_id,
    'magnet_version_id',v.id,'version',v.version,
    'storage_bucket','client-media','storage_path',v.storage_path,
    'content_sha256',v.content_sha256,'file_bytes',v.file_bytes,
    'media_type',v.media_type,'delivery_channel',v.delivery_channel,
    'delivery_subject',v.delivery_subject,'delivery_body',v.delivery_body,
    'recipient_rule','Only people who opted in through a bound capture endpoint'
  ) from public.lead_magnet_versions v
    join public.lead_magnets m on m.id = v.magnet_id and m.client_id = v.client_id
  where v.id = p_approval.magnet_version_id and v.client_id = p_approval.client_id;
$$;
create function public.lead_magnet_inbox_scope_v6(
  p_approval public.lead_magnet_approvals)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'client_id',v.client_id,'approval_id',p_approval.id,
    'magnet_version_id',v.id,'content_sha256',v.content_sha256,
    'delivery_channel',v.delivery_channel,
    'recipient_scope','consented_opt_ins','payload_hash',p_approval.payload_hash
  ) from public.lead_magnet_versions v
  where v.id = p_approval.magnet_version_id and v.client_id = p_approval.client_id;
$$;
create function public.register_lead_magnet_inbox_v6(
  p_approval public.lead_magnet_approvals)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare v_preview jsonb; v_scope jsonb;
begin
  v_preview := public.lead_magnet_inbox_preview_v6(p_approval);
  v_scope := public.lead_magnet_inbox_scope_v6(p_approval);
  if v_preview is null or v_scope is null then
    raise exception 'The lead magnet version is missing.' using errcode = '23514';
  end if;
  return public.register_approval_request_v6(jsonb_build_object(
    'client_id',p_approval.client_id,'source_system','aa_console',
    'source_kind','lead_magnet','source_id',p_approval.id::text,
    'source_version',p_approval.payload_hash,
    'title','Lead magnet: ' || (v_preview->>'magnet_name') ||
      ' · version ' || (v_preview->>'version'),
    'artifact_hash',p_approval.payload_hash,'preview',v_preview,
    'destination','lead_magnet:' || (v_preview->>'delivery_channel'),
    'scope',v_scope,'owner_role','admin_or_active_client_manager',
    'requested_by',case when auth.role() = 'authenticated' then auth.uid() else null end,
    'requester_kind',case when auth.role() = 'authenticated' and auth.uid() is not null
      then 'human' when auth.role() = 'service_role' then 'service' else 'unknown' end,
    'requester_ref',case when auth.role() = 'service_role'
      then 'lead_magnet_approvals:' || p_approval.id::text else null end,
    'expires_at',now() + interval '7 days',
    'preview_blocker','Stored file bytes have not been independently verified for this exact approval.',
    'owning_path','/clients/' || p_approval.client_id::text ||
      '/delivery/lead-magnet-studio?magnet=' || (v_preview->>'magnet_id')
  ));
end $$;
create function public.register_lead_magnet_inbox_trigger_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.inbox_enforced_v6 then
    perform public.register_lead_magnet_inbox_v6(new);
  end if;
  return new;
end $$;
create trigger lead_magnet_inbox_request_v6
  after insert on public.lead_magnet_approvals
  for each row execute function public.register_lead_magnet_inbox_trigger_v6();

create function public.lead_magnet_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  r public.approval_requests_v6%rowtype;
  a public.lead_magnet_approvals%rowtype;
  v public.lead_magnet_versions%rowtype;
  e public.approval_request_evidence_v6%rowtype;
begin
  select * into r from public.approval_requests_v6 where id = p_request_id;
  if not found or r.source_system <> 'aa_console' or r.source_kind <> 'lead_magnet'
    or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into a from public.lead_magnet_approvals
    where id = r.source_id::uuid and client_id = r.client_id;
  if not found then return 'cancelled'; end if;
  select * into v from public.lead_magnet_versions
    where id = a.magnet_version_id and client_id = a.client_id;
  if not found or not a.inbox_enforced_v6
    or a.payload_hash is distinct from r.source_version
    or a.payload_hash is distinct from r.artifact_hash
    or a.payload_hash is distinct from public.lead_magnet_payload_hash_v6(v.id)
    or r.preview is distinct from public.lead_magnet_inbox_preview_v6(a)
    or r.scope is distinct from public.lead_magnet_inbox_scope_v6(a)
    or r.destination is distinct from ('lead_magnet:' || v.delivery_channel)
    then return 'superseded'; end if;
  if a.status <> 'pending' then return 'source_decided'; end if;
  if exists (select 1 from public.lead_magnet_versions newer
    where newer.magnet_id = v.magnet_id and newer.version > v.version)
    then return 'superseded'; end if;
  select * into e from public.approval_request_evidence_v6
    where request_id = r.id;
  if e.id is not null and (e.artifact_hash is distinct from a.payload_hash
    or e.preview->>'verified_content_sha256' is distinct from v.content_sha256
    or e.preview->>'verified_file_bytes' is distinct from v.file_bytes::text
    or e.scope is distinct from r.scope) then return 'source_held'; end if;
  return 'pending';
end $$;

create function public.attest_lead_magnet_bytes_v6(
  p_approval_id uuid,p_sha256 text,p_file_bytes bigint)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  a public.lead_magnet_approvals%rowtype;
  v public.lead_magnet_versions%rowtype;
  r public.approval_requests_v6%rowtype;
  e public.approval_request_evidence_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only a trusted byte verifier may attest the file.' using errcode = '42501';
  end if;
  select * into a from public.lead_magnet_approvals
    where id = p_approval_id for update;
  if not found or a.status <> 'pending' or not a.inbox_enforced_v6 then
    raise exception 'The approval is no longer awaiting byte verification.'
      using errcode = '23514';
  end if;
  select * into v from public.lead_magnet_versions
    where id = a.magnet_version_id and client_id = a.client_id;
  if not found or v.content_sha256 is distinct from p_sha256
    or v.file_bytes is distinct from p_file_bytes then
    raise exception 'Downloaded bytes do not match the version under review.'
      using errcode = '23514';
  end if;
  select * into r from public.approval_requests_v6
    where source_system = 'aa_console' and source_kind = 'lead_magnet'
      and source_id = a.id::text and source_version = a.payload_hash
      and client_id = a.client_id;
  if not found or public.lead_magnet_source_state_v6(r.id) <> 'pending' then
    raise exception 'The exact lead magnet request is stale or missing.'
      using errcode = '23514';
  end if;
  select * into e from public.approval_request_evidence_v6
    where request_id = r.id;
  if e.id is not null then
    if e.artifact_hash = a.payload_hash
      and e.preview->>'verified_content_sha256' = p_sha256
      and e.preview->>'verified_file_bytes' = p_file_bytes::text
      and e.scope = r.scope then return r.id; end if;
    raise exception 'Existing byte evidence differs from this file.'
      using errcode = '23514';
  end if;
  perform public.attach_approval_evidence_v6(
    r.id,r.source_version,'lead_magnet_bytes:' || a.id::text,
    jsonb_build_object('artifact_hash',a.payload_hash,
      'preview',r.preview || jsonb_build_object(
        'verified_content_sha256',p_sha256,
        'verified_file_bytes',p_file_bytes,
        'verified_at',now()),
      'destination',r.destination,'account_ref',r.account_ref,
      'budget',r.budget,'scope',r.scope));
  return r.id;
end $$;

revoke all on function public.lead_magnet_inbox_preview_v6(public.lead_magnet_approvals)
  from public,anon,authenticated,service_role;
revoke all on function public.enforce_new_lead_magnet_inbox_v6()
  from public,anon,authenticated,service_role;
revoke all on function public.lead_magnet_inbox_scope_v6(public.lead_magnet_approvals)
  from public,anon,authenticated,service_role;
revoke all on function public.register_lead_magnet_inbox_v6(public.lead_magnet_approvals)
  from public,anon,authenticated,service_role;
revoke all on function public.register_lead_magnet_inbox_trigger_v6()
  from public,anon,authenticated,service_role;
revoke all on function public.lead_magnet_source_state_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.lead_magnet_source_state_v6(uuid)
  to authenticated,service_role;
revoke all on function public.attest_lead_magnet_bytes_v6(uuid,text,bigint)
  from public,anon,authenticated;
grant execute on function public.attest_lead_magnet_bytes_v6(uuid,text,bigint)
  to service_role;
select public.lock_down_definer_functions();
commit;
