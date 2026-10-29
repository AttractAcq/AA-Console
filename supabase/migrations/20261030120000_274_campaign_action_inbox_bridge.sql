-- B008: a campaign action is one exact-version Inbox request. The source
-- approval remains the authority; the Inbox mirrors it and adds an AAL2
-- human decision event. All external-effect switches remain unchanged.

create or replace function public.campaign_action_inbox_payload_v6(
  p_action public.campaign_action_approvals
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_account text;
  v_budget jsonb;
  v_preview jsonb;
  v_blocker text := 'The exact reviewable action payload has not been attached.';
  v_spec jsonb;
begin
  v_account := case p_action.action_key
    when 'google_ad_build' then p_action.scope->'approved_spec'->>'google_ads_customer_id'
    when 'meta_ad_build' then p_action.scope->>'ad_account'
    when 'budget_change' then p_action.scope->>'ad_set_external_id'
    when 'page_deploy' then concat_ws('/', p_action.scope->>'owner', p_action.scope->>'repository')
    else null end;
  if v_account = '' then v_account := null; end if;
  v_budget := case p_action.action_key
    when 'meta_ad_build' then jsonb_build_object(
      'daily_budget', p_action.scope->'daily_budget')
    when 'budget_change' then jsonb_build_object(
      'current_daily_budget', p_action.scope->'current_daily_budget',
      'proposed_daily_budget', p_action.scope->'proposed_daily_budget',
      'currency', p_action.scope->'currency',
      'multiple_of_current', p_action.scope->'multiple_of_current')
    else null end;
  v_preview := jsonb_build_object(
    'action_key', p_action.action_key,
    'campaign_id', p_action.campaign_id,
    'manifest_id', p_action.manifest_id,
    'destination', p_action.destination,
    'scope', p_action.scope);

  -- Google Ads builds already carry their full approved JSON specification,
  -- including all headlines, descriptions, paths, keyword research and the
  -- exact customer ID. Recompute its hash; an arbitrary scope is not enough.
  if p_action.action_key = 'google_ad_build' then
    v_spec := p_action.scope->'approved_spec';
    if jsonb_typeof(v_spec) = 'object'
      and nullif(v_account, '') is not null
      and p_action.destination = 'google_ads:customers/' || v_account
      and encode(sha256(convert_to(v_spec::text, 'UTF8')), 'hex')
        = p_action.artifact_version_hash then
      v_blocker := null;
    end if;
  end if;

  return jsonb_build_object(
    'client_id', p_action.client_id,
    'source_system', 'aa_console',
    'source_kind', 'campaign_action',
    'source_id', p_action.id,
    'source_version', p_action.request_hash,
    'title', initcap(replace(p_action.action_key, '_', ' ')),
    'artifact_hash', case when p_action.artifact_version_hash ~ '^[0-9a-f]{64}$'
      then p_action.artifact_version_hash else null end,
    'preview', v_preview,
    'destination', p_action.destination,
    'account_ref', v_account,
    'budget', v_budget,
    'scope', p_action.scope,
    'owner_role', 'admin_or_active_client_manager',
    'expires_at', p_action.requested_at + interval '7 days',
    'preview_blocker', v_blocker,
    'owning_path', '/clients/' || p_action.client_id::text ||
      '/delivery/approval-inbox?tab=campaign-actions');
end;
$$;
revoke all on function public.campaign_action_inbox_payload_v6(
  public.campaign_action_approvals) from public, anon, authenticated, service_role;

create or replace function public.register_campaign_action_inbox_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.register_approval_request_v6(
    public.campaign_action_inbox_payload_v6(new));
  return new;
end;
$$;
revoke all on function public.register_campaign_action_inbox_v6()
  from public, anon, authenticated, service_role;
create trigger campaign_action_inbox_register_v6
  after insert on public.campaign_action_approvals
  for each row execute function public.register_campaign_action_inbox_v6();

create or replace function public.attach_campaign_page_inbox_evidence_v6(
  p_snapshot public.campaign_page_approval_snapshots
) returns uuid language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_action public.campaign_action_approvals%rowtype;
  v_base jsonb;
  v_request_id uuid;
begin
  select * into v_action from public.campaign_action_approvals
    where id = p_snapshot.approval_id;
  if not found or v_action.action_key <> 'page_deploy'
    or v_action.client_id <> p_snapshot.client_id
    or v_action.artifact_version_hash <> p_snapshot.rendered_sha256
    or v_action.scope->>'page_id' is distinct from p_snapshot.page_id::text
    or v_action.scope->>'revision_id' is distinct from p_snapshot.revision_id::text
    or v_action.scope->>'site_repository_id' is distinct from p_snapshot.site_repository_id::text
    or v_action.scope->>'site_path' is distinct from p_snapshot.site_path
    or v_action.scope->>'rendered_sha256' is distinct from p_snapshot.rendered_sha256
    or encode(sha256(convert_to(p_snapshot.rendered_html, 'UTF8')), 'hex')
      <> p_snapshot.rendered_sha256 then
    raise exception 'Page snapshot does not match its exact action request.';
  end if;
  v_base := public.campaign_action_inbox_payload_v6(v_action);
  v_request_id := public.register_approval_request_v6(v_base);
  perform public.attach_approval_evidence_v6(
    v_request_id,
    v_action.request_hash,
    'campaign_page_approval_snapshots:' || p_snapshot.approval_id::text,
    jsonb_build_object(
      'artifact_hash', p_snapshot.rendered_sha256,
      'preview', (v_base->'preview') || jsonb_build_object(
        'rendered_html', p_snapshot.rendered_html,
        'rendered_sha256', p_snapshot.rendered_sha256,
        'page_id', p_snapshot.page_id,
        'revision_id', p_snapshot.revision_id,
        'site_repository_id', p_snapshot.site_repository_id,
        'site_path', p_snapshot.site_path),
      'destination', v_action.destination,
      'account_ref', v_base->'account_ref',
      'budget', v_base->'budget',
      'scope', v_action.scope));
  return v_request_id;
end;
$$;
revoke all on function public.attach_campaign_page_inbox_evidence_v6(
  public.campaign_page_approval_snapshots)
  from public, anon, authenticated, service_role;

create or replace function public.attach_campaign_page_inbox_evidence_trigger_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.attach_campaign_page_inbox_evidence_v6(new);
  return new;
end;
$$;
revoke all on function public.attach_campaign_page_inbox_evidence_trigger_v6()
  from public, anon, authenticated, service_role;
create trigger campaign_page_inbox_evidence_v6
  after insert on public.campaign_page_approval_snapshots
  for each row execute function public.attach_campaign_page_inbox_evidence_trigger_v6();

create or replace function public.record_campaign_action_inbox_decision_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_request_id uuid;
  v_payload jsonb;
begin
  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    if new.decided_by is distinct from auth.uid() or new.decided_at is null then
      raise exception 'The source decision must identify the signed-in human.';
    end if;
    -- Existing source role, client and supersession checks still run in the
    -- owning RPC. This trigger also covers privileged direct table writes.
    v_payload := public.campaign_action_inbox_payload_v6(old);
    v_request_id := public.register_approval_request_v6(v_payload);
    perform public.record_approval_decision_v6(
      v_request_id, new.status, v_payload->>'artifact_hash',
      'campaign_action_approvals:' || old.id::text,
      new.rejection_reason);
  end if;
  return new;
end;
$$;
revoke all on function public.record_campaign_action_inbox_decision_v6()
  from public, anon, authenticated, service_role;
create trigger campaign_action_inbox_decision_v6
  after update of status on public.campaign_action_approvals
  for each row execute function public.record_campaign_action_inbox_decision_v6();

-- Old pending source rows become visible. Their preview stays blocked unless
-- the adapter can prove exact bytes/specification from existing immutable
-- data. Prior decisions are historical source facts, not fabricated AAL2
-- Inbox decisions.
do $$
declare
  v_action public.campaign_action_approvals%rowtype;
  v_snapshot public.campaign_page_approval_snapshots%rowtype;
begin
  for v_action in select * from public.campaign_action_approvals
    where status = 'pending'
  loop
    perform public.register_approval_request_v6(
      public.campaign_action_inbox_payload_v6(v_action));
  end loop;
  for v_snapshot in select s.* from public.campaign_page_approval_snapshots s
    join public.campaign_action_approvals a on a.id = s.approval_id
    where a.status = 'pending'
  loop
    perform public.attach_campaign_page_inbox_evidence_v6(v_snapshot);
  end loop;
end;
$$;

select public.lock_down_definer_functions();
