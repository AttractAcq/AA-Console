-- B014: one execution-time credential eligibility contract.
-- A warning is not revocation. An expiring grant remains usable only while
-- its recorded expiry is in the future. Known expiry blocks even when the
-- last health writer has not yet changed the status to error.
-- Provider identity, destination and scope checks are additional gates in
-- their respective adapters; a status label alone never proves those facts.

create or replace function public.usable_integration_statuses()
returns text[] language sql immutable set search_path = pg_catalog, public
as $$ select array['connected', 'active', 'expiring']::text[] $$;

comment on function public.usable_integration_statuses() is
  'Allowed status labels. expiring additionally requires a known future expiry. This list alone is not credential or provider capability proof.';

create or replace function public.integration_state_eligible(
  p_status text, p_expires_at timestamptz)
returns boolean language sql stable set search_path = pg_catalog, public
as $$
  select coalesce(
    p_status = any(public.usable_integration_statuses())
    and (p_expires_at > now()
         or (p_expires_at is null and p_status in ('connected', 'active'))),
    false)
$$;

comment on function public.integration_state_eligible(text, timestamptz) is
  'Time-sensitive state gate. A known expiry must be strictly in the future; expiring without a known expiry fails closed. No status proves account identity or scope.';

revoke all on function public.integration_state_eligible(text, timestamptz) from public, anon;
grant execute on function public.integration_state_eligible(text, timestamptz) to authenticated, service_role;

-- Count all rows for this client/provider, not just eligible rows. Existing
-- callers identify a provider but not a particular integration ID, so a
-- second row would make the token/account pairing ambiguous. Vault existence
-- and nonblank plaintext are checked without returning either to the caller.
create or replace function public.integration_usable(p_client_id uuid, p_provider text)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, vault
as $$
  select case
    when not public.may_advance_slot(p_client_id) then null
    else (
      select count(*) = 1
         and count(*) filter (
           where public.integration_state_eligible(i.status, i.token_expires_at)
             and i.credential_secret_id is not null
             and nullif(btrim(v.decrypted_secret), '') is not null
         ) = 1
        from public.client_integrations i
        left join vault.decrypted_secrets v on v.id = i.credential_secret_id
       where i.client_id = p_client_id and i.provider = p_provider
    )
  end
$$;

comment on function public.integration_usable(uuid, text) is
  'True only for exactly one matching provider row with an eligible nonexpired state and a present nonblank Vault secret. Null for an inaccessible client. Provider/account/scope adapters still gate execution.';

create or replace function public.integration_secret(p_client_id uuid, p_provider text)
returns text language sql stable security definer
set search_path = pg_catalog, public, vault
as $$
  select case
    when count(*) = 1
     and count(*) filter (
       where public.integration_state_eligible(i.status, i.token_expires_at)
         and i.credential_secret_id is not null
         and nullif(btrim(v.decrypted_secret), '') is not null
     ) = 1
    then max(v.decrypted_secret)
    else null
  end
    from public.client_integrations i
    left join vault.decrypted_secrets v on v.id = i.credential_secret_id
   where i.client_id = p_client_id and i.provider = p_provider
$$;

comment on function public.integration_secret(uuid, text) is
  'Service-only credential read. Returns no token for error, revoked, expired, unknown-expiry expiring, missing Vault secret, or ambiguous client/provider rows.';

revoke all on function public.integration_usable(uuid, text) from public, anon;
grant execute on function public.integration_usable(uuid, text) to authenticated, service_role;
revoke all on function public.integration_secret(uuid, text) from public, anon, authenticated;
grant execute on function public.integration_secret(uuid, text) to service_role;

create or replace function public.enqueue_metrics_ingest_jobs(p_days integer default 7)
returns integer language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_count integer;
  v_since date := current_date - greatest(coalesce(p_days, 7), 1);
  v_until date := current_date;
begin
  insert into public.agent_jobs (agent_key, client_id, params)
  select 'metrics_ingest', i.client_id,
         jsonb_build_object('surface', s.surface, 'since', v_since, 'until', v_until)
    from public.client_integrations i
    join (values ('meta', 'paid'), ('instagram', 'organic')) as s(provider, surface)
      on s.provider = i.provider
   where i.ingest_enabled is true
     and public.integration_usable(i.client_id, i.provider) is true
     and not exists (
       select 1 from public.agent_jobs j
        where j.agent_key = 'metrics_ingest'
          and j.client_id = i.client_id
          and j.params->>'surface' = s.surface
          and j.status in ('queued', 'claimed', 'running')
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.enqueue_metrics_ingest_jobs(integer) is
  'Queues only integrations eligible for credential read at scheduling time. The runtime checks again before provider access, so expiry after queueing fails closed.';

revoke all on function public.enqueue_metrics_ingest_jobs(integer) from public, anon, authenticated;
grant execute on function public.enqueue_metrics_ingest_jobs(integer) to service_role;

-- The view used by Account -> Integrations must show the same eligibility
-- decision as the execution gate. Existing columns retain their order; the
-- row ID is appended so the UI can pair health with the right integration.
create or replace view public.integration_health with (security_invoker = true) as
select
  i.client_id,
  c.name as client_name,
  i.provider,
  i.status,
  i.ingest_enabled,
  i.token_expires_at,
  i.health_detail,
  i.last_checked_at,
  coalesce(public.integration_usable(i.client_id, i.provider), false)
    and public.integration_state_eligible(i.status, i.token_expires_at) as usable,
  case
    when i.credential_secret_id is null then 'No credential'
    when i.status not in ('connected', 'active', 'expiring') then 'Not working'
    when i.token_expires_at is not null and i.token_expires_at <= now() then 'Expired'
    when i.status = 'expiring' and i.token_expires_at is null then 'Expiry unknown'
    when coalesce(public.integration_usable(i.client_id, i.provider), false) is not true then 'Not usable'
    when i.status = 'expiring' or
         (i.token_expires_at is not null and i.token_expires_at < now() + interval '7 days')
      then 'Expiring soon'
    when i.last_checked_at is null then 'Never checked'
    else 'Working'
  end as headline,
  i.id as integration_id
from public.client_integrations i
left join public.clients c on c.id = i.client_id;

comment on view public.integration_health is
  'Provider rows with the same credential eligibility as execution, an expiry warning, and row identity. A status label alone is not proof of provider account or scope health.';

grant select on public.integration_health to authenticated;


-- One-off backfill uses the same provider-neutral gate as scheduling and execution.
create or replace function public.request_metrics_backfill(
  p_client_id uuid,
  p_since date,
  p_until date,
  -- Null means both surfaces this system knows how to pull.
  p_surface text default null
)
returns setof uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
  v_job uuid;
  v_queued integer := 0;
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  if p_since is null or p_until is null then
    raise exception 'A backfill needs both ends of the window.' using errcode = 'P0001';
  end if;
  if p_since > p_until then
    raise exception 'The window starts after it ends: % to %.', p_since, p_until using errcode = 'P0001';
  end if;
  if p_until > current_date then
    raise exception 'That window ends in the future. The last day there can be data for is %.', current_date
      using errcode = 'P0001';
  end if;
  if (p_until - p_since) + 1 > max_backfill_days() then
    -- Stated rather than clamped. A request silently cut to 400 days looks
    -- like a complete backfill and is not one, and the person would find
    -- out months later from a chart with a hole in it.
    raise exception 'That is % days. One backfill may ask for at most %: split it into several.',
      (p_until - p_since) + 1, max_backfill_days() using errcode = 'P0001';
  end if;
  if p_surface is not null and p_surface not in ('paid', 'organic') then
    raise exception 'Unknown surface "%". It is paid, organic, or nothing for both.', p_surface
      using errcode = 'P0001';
  end if;

  for r in
    select p_client_id as client_id, s.surface, s.provider
      from (values ('meta', 'paid'), ('instagram', 'organic')) as s(provider, surface)
     where (p_surface is null or s.surface = p_surface)
       -- Deliberately ignore ingest_enabled: a one-off backfill must not arm
       -- the daily schedule. Eligibility is the same credential gate used
       -- by the runtime, including the actual expiry and Vault presence.
       and public.integration_usable(p_client_id, s.provider) is true
  loop
    -- Not the same window twice. The daily job's own guard is "any job in
    -- flight for this surface", which would block a backfill behind the
    -- morning pull; this one is per window, so asking for September while
    -- today's job runs is allowed and asking for September twice is not.
    if exists (
      select 1 from agent_jobs j
       where j.agent_key = 'metrics_ingest'
         and j.client_id = p_client_id
         and j.params->>'surface' = r.surface
         and (j.params->>'since')::date = p_since
         and (j.params->>'until')::date = p_until
         and j.status in ('queued', 'paused', 'claimed', 'running')
    ) then
      continue;
    end if;

    insert into agent_jobs (agent_key, client_id, created_by, params)
    values ('metrics_ingest', p_client_id, auth.uid(),
            jsonb_build_object('surface', r.surface, 'since', p_since, 'until', p_until,
                               'backfill', true))
    returning id into v_job;

    v_queued := v_queued + 1;
    return next v_job;
  end loop;

  if v_queued = 0 then
    -- Naming which of the two it is, because they want different actions:
    -- connect a credential, or wait.
    if not exists (
      select 1 from (values ('meta', 'paid'), ('instagram', 'organic')) as s(provider, surface)
       where (p_surface is null or s.surface = p_surface)
         and public.integration_usable(p_client_id, s.provider) is true
    ) then
      raise exception 'This client has no usable integration to pull % from.',
        coalesce(p_surface, 'either surface') using errcode = 'P0001';
    end if;
    raise exception 'That exact window is already being pulled.' using errcode = 'P0001';
  end if;

  return;
end;
$$;

comment on function public.request_metrics_backfill(uuid, date, date, text) is
  'Queues a bounded one-off metrics pull only when the same current credential eligibility gate as runtime allows it. The daily ingest switch remains irrelevant.';


-- Google Ads account binding and its due view may not use a stricter label-only test.
create or replace function public.request_campaign_google_build_v6(
  p_campaign_id uuid, p_actor uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare
  v_campaign public.client_campaigns%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_sheet public.google_ads_build_sheets%rowtype;
  v_copy public.google_ads_copy%rowtype;
  v_integration public.client_integrations%rowtype;
  v_integration_count integer;
  v_approval public.campaign_action_approvals%rowtype;
  v_spec jsonb;
  v_hash text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service can request a campaign action.';
  end if;
  if p_actor is null or not exists
    (select 1 from public.profiles p where p.id = p_actor) then
    raise exception 'A known requesting actor is required.';
  end if;
  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  if not found then raise exception 'No such campaign.'; end if;
  if v_campaign.acquisition_mode <> 'paid' or v_campaign.paid_platform <> 'google' then
    raise exception 'That campaign is not a paid Google campaign.';
  end if;

  select * into v_manifest from public.campaign_manifest_versions
   where campaign_id = p_campaign_id order by version desc limit 1;
  if not found then raise exception 'This campaign has no package.'; end if;

  select * into v_sheet from public.google_ads_build_sheets
   where campaign_id = p_campaign_id order by version desc limit 1;
  if not found then
    raise exception 'Derive the build sheet before asking to build it.';
  end if;
  if v_sheet.client_id <> v_campaign.client_id then
    raise exception 'The latest build sheet belongs to another client.';
  end if;
  if v_sheet.manifest_id is distinct from v_manifest.id then
    raise exception 'The latest build sheet has no lineage to the current campaign package. Derive a new sheet for this package.';
  end if;
  if coalesce(array_length(v_sheet.missing, 1), 0) > 0 then
    -- Named, because `keyword_research` is always one of them and a person
    -- has to go and do it in Google's own tools.
    raise exception 'The build sheet is still missing: %. Fill those in before asking to build.',
      array_to_string(v_sheet.missing, ', ');
  end if;

  select * into v_copy from public.google_ads_copy where campaign_id = p_campaign_id;
  if not found then
    raise exception 'This campaign has no ad copy. Google will not create an ad without headlines and descriptions.';
  end if;

  select count(*) into v_integration_count
    from public.client_integrations i
   where i.client_id = v_campaign.client_id
     and i.provider = 'google_ads' and public.integration_usable(i.client_id, i.provider) is true
     and i.google_ads_customer_id is not null;
  if v_integration_count <> 1 then
    raise exception 'A Google build needs exactly one currently usable integration with a recorded, exact Google Ads customer id; found %.',
      v_integration_count;
  end if;
  select * into v_integration from public.client_integrations i
   where i.client_id = v_campaign.client_id
     and i.provider = 'google_ads' and public.integration_usable(i.client_id, i.provider) is true
     and i.google_ads_customer_id is not null;

  -- A request is not useful until an installed, tested runtime handler can
  -- consume it. The current sheet generator cannot reach this check anyway:
  -- its missing list always contains keyword_research.
  if not exists (select 1 from public.campaign_action_executors e
                  where e.action_key = 'google_ad_build' and e.supported) then
    raise exception 'No Google Ads build handler is enabled. The sheet remains a hand-build plan; do not ask a human to approve an action the runtime cannot perform.';
  end if;

  -- The JSONB document is the exact version the person sees, including both
  -- display paths and the selected destination. Arrays retain boundaries.
  v_spec := public.google_ads_build_spec_v6(v_sheet, v_copy) || jsonb_build_object(
    'integration_id', v_integration.id,
    'google_ads_customer_id', v_integration.google_ads_customer_id);
  v_hash := encode(sha256(convert_to(v_spec::text, 'UTF8')), 'hex');

  -- The requester is not part of the reviewed build specification. Keeping
  -- actor identity in scope would make a second authorized person collide
  -- with the same campaign/spec idempotency key. The approval itself is one
  -- exact action regardless of who asks for it again.
  select * into v_approval from public.request_campaign_action_approval_v6(
    v_manifest.id,
    'google_ad_build:' || p_campaign_id::text || ':' || v_hash,
    'google_ad_build',
    'google_ads:customers/' || v_integration.google_ads_customer_id,
    v_hash,
    jsonb_build_object(
      'approved_spec', v_spec,
      'sheet_id', v_sheet.id,
      'copy_id', v_copy.id,
      'integration_id', v_integration.id));
  return v_approval.id;
end $fn$;

create or replace function public.start_google_build_v6(p_execution_id uuid)
returns public.google_ads_builds language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare
  x public.campaign_action_executions%rowtype;
  a public.campaign_action_approvals%rowtype;
  v_sheet public.google_ads_build_sheets%rowtype;
  v_copy public.google_ads_copy%rowtype;
  v_integration public.client_integrations%rowtype;
  v_spec jsonb;
  v_hash text;
  b public.google_ads_builds%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may build a Google campaign.';
  end if;
  if not exists (select 1 from public.campaign_action_executors e
                  where e.action_key = 'google_ad_build' and e.supported) then
    raise exception 'No Google Ads build handler is enabled.';
  end if;
  select * into x from public.campaign_action_executions where id = p_execution_id;
  if not found then raise exception 'No such execution.'; end if;
  select * into a from public.campaign_action_approvals where id = x.approval_id;
  if not found then raise exception 'The execution has no approval.'; end if;
  if a.action_key <> 'google_ad_build' then
    raise exception 'That approval is a %, not a Google build.', a.action_key;
  end if;
  if a.status <> 'approved' then
    raise exception 'That build is %, not approved.', a.status;
  end if;
  if x.status <> 'executing' or x.action_key <> a.action_key
     or x.client_id <> a.client_id or x.campaign_id <> a.campaign_id
     or x.manifest_id <> a.manifest_id
     or x.artifact_version_hash <> a.artifact_version_hash
     or x.lease_until is null or x.lease_until <= now() then
    raise exception 'The execution no longer matches the exact approved build.';
  end if;
  if exists (select 1 from public.campaign_manifest_versions m
              join public.campaign_manifest_versions newer
                on newer.campaign_id = m.campaign_id and newer.version > m.version
             where m.id = a.manifest_id) then
    raise exception 'The campaign package changed after this was approved. Ask again.';
  end if;
  if not exists (select 1 from public.client_engine_settings s
                  where s.client_id = a.client_id
                    and s.campaign_actions_enabled) then
    raise exception 'External campaign actions are off for this client.';
  end if;

  select * into v_sheet from public.google_ads_build_sheets
   where id = nullif(a.scope->>'sheet_id', '')::uuid;
  if not found then raise exception 'That approval names no build sheet.'; end if;
  if v_sheet.campaign_id <> a.campaign_id or v_sheet.client_id <> a.client_id then
    raise exception 'That approval names a build sheet for another campaign or client.';
  end if;
  if v_sheet.manifest_id is distinct from a.manifest_id then
    raise exception 'That build sheet was not derived from the approved campaign package.';
  end if;
  if exists (select 1 from public.google_ads_build_sheets s
              where s.campaign_id = a.campaign_id and s.version > v_sheet.version) then
    raise exception 'The build sheet changed after this was approved. Ask again.';
  end if;
  if coalesce(array_length(v_sheet.missing, 1), 0) > 0 then
    raise exception 'The approved build sheet is still missing: %.',
      array_to_string(v_sheet.missing, ', ');
  end if;
  select * into v_copy from public.google_ads_copy where campaign_id = a.campaign_id;
  if not found then raise exception 'The ad copy has been removed since this was approved.'; end if;
  if v_copy.id::text is distinct from a.scope->>'copy_id'
     or v_copy.client_id <> a.client_id then
    raise exception 'The ad copy changed identity after this was approved. Ask again.';
  end if;
  select * into v_integration from public.client_integrations i
   where i.id = nullif(a.scope->>'integration_id', '')::uuid
     and i.client_id = a.client_id
     and i.provider = 'google_ads' and public.integration_usable(i.client_id, i.provider) is true
     and i.google_ads_customer_id is not null;
  if not found then
    raise exception 'The approved Google Ads account is no longer usable.';
  end if;

  v_spec := public.google_ads_build_spec_v6(v_sheet, v_copy) || jsonb_build_object(
    'integration_id', v_integration.id,
    'google_ads_customer_id', v_integration.google_ads_customer_id);
  v_hash := encode(sha256(convert_to(v_spec::text, 'UTF8')), 'hex');
  if v_hash <> a.artifact_version_hash
     or a.scope->'approved_spec' is distinct from v_spec
     or a.destination <> ('google_ads:customers/' || v_integration.google_ads_customer_id) then
    raise exception 'The sheet, ad copy or destination changed after this was approved. Ask again.';
  end if;

  insert into public.google_ads_builds (
    client_id, campaign_id, approval_id, sheet_id, approved_spec, attempts)
  values (a.client_id, a.campaign_id, a.id, v_sheet.id, v_spec, 1)
  on conflict (approval_id) do update
    set attempts = google_ads_builds.attempts + 1,
        status = 'building',
        last_error = null
    where google_ads_builds.approved_spec = excluded.approved_spec
      and google_ads_builds.status <> 'built'
  returning * into b;
  if not found then
    raise exception 'This approval is already built or an earlier attempt used a different specification.';
  end if;
  return b;
end $fn$;

create or replace view public.google_ads_build_due with (security_invoker = true) as
select
  c.id as campaign_id,
  c.client_id,
  c.name,
  s.id as sheet_id,
  s.version as sheet_version,
  s.manifest_id as sheet_manifest_id,
  s.missing,
  (cp.campaign_id is not null) as has_copy,
  coalesce((select e.supported from public.campaign_action_executors e
             where e.action_key = 'google_ad_build'), false) as action_supported,
  b.id as build_id,
  b.status as build_status,
  b.campaign_resource,
  b.ad_group_resource,
  b.keyword_count,
  b.last_error,
  case
    when c.acquisition_mode <> 'paid' or c.paid_platform <> 'google'
      then 'This is not a paid Google campaign.'
    when s.id is null then 'No build sheet has been derived yet.'
    when s.manifest_id is null or s.manifest_id is distinct from m.id
      then 'The latest sheet is not bound to the current campaign package. Derive a new sheet.'
    when coalesce(array_length(s.missing, 1), 0) > 0
      then 'The sheet is still missing: ' || array_to_string(s.missing, ', ') || '.'
    when cp.campaign_id is null
      then 'No ad copy. Google will not create an ad without headlines and descriptions.'
    when b.status = 'failed'
      then 'The build failed: ' || coalesce(b.last_error, 'no error recorded') || '.'
    when b.status = 'built' then null
    when b.id is not null then 'Building.'
    when not coalesce((select e.supported from public.campaign_action_executors e
                        where e.action_key = 'google_ad_build'), false)
      then 'No runtime handler performs google_ad_build. The sheet is for a hand build until an adapter is verified.'
    when (select count(*) from public.client_integrations i
           where i.client_id = c.client_id
             and i.provider = 'google_ads' and public.integration_usable(i.client_id, i.provider) is true
             and i.google_ads_customer_id is not null) <> 1
      then 'Exactly one currently usable Google Ads integration with an exact customer id is required.'
    else null
  end as blocker
from public.client_campaigns c
left join lateral (
  select m2.id from public.campaign_manifest_versions m2
   where m2.campaign_id = c.id order by m2.version desc limit 1) m on true
left join lateral (
  select * from public.google_ads_build_sheets s2
   where s2.campaign_id = c.id order by s2.version desc limit 1) s on true
left join public.google_ads_copy cp on cp.campaign_id = c.id
left join lateral (
  -- A completed build of an earlier sheet/package is historical evidence,
  -- not a build of the current sheet. Read only the build and its immutable
  -- snapshot here: ordinary client users can see builds but approval RLS
  -- hides approval rows from them in this security_invoker view.
  select b2.* from public.google_ads_builds b2
   where b2.campaign_id = c.id and b2.client_id = c.client_id
     and b2.sheet_id = s.id and s.manifest_id = m.id
     and b2.approved_spec->>'sheet_id' = s.id::text
     and b2.approved_spec->>'sheet_manifest_id' = m.id::text
   order by b2.created_at desc limit 1) b on true
where c.archived_at is null;


-- Google Business profile execution readiness uses the same gate.
create or replace view public.profile_change_due with (security_invoker = true) as
select
  c.id as change_id, c.client_id, 'google_business'::text as surface,
  'google'::text as platform, c.field, c.current_value, c.proposed_value,
  c.status, c.attempts, c.applied_at, c.last_error,
  f.writable,
  case
    when c.status = 'applied' then null
    when c.status = 'rejected' then coalesce('Rejected: ' || c.rejection_reason, 'Rejected.')
    when c.status in ('drafted', 'awaiting_approval') then 'Waiting for a person to approve it.'
    when f.writable is not true
      then 'No adapter may write this field. ' || coalesce(f.note, '')
    when not exists (select 1 from public.client_integrations i
                      where i.client_id = c.client_id and i.provider = 'google_business'
                        and public.integration_usable(i.client_id, i.provider) is true)
      then 'No currently usable Google Business integration for this client, so nothing can be written. This adapter has never run against a real profile.'
    when c.status = 'failed'
      then 'Failed after ' || c.attempts::text || ' attempts: ' ||
           coalesce(c.last_error, 'no error recorded') || '.'
    else null
  end as blocker
from public.google_profile_changes c
left join public.profile_field_support f
  on f.surface = 'google_business' and f.platform = 'google' and f.field = c.field
union all
select
  m.id, m.client_id, 'meta', m.platform, m.field, m.current_value, m.proposed_value,
  m.status, m.attempts, m.applied_at, m.last_error,
  f.writable,
  case
    when m.status = 'applied' then null
    when m.status = 'rejected' then coalesce('Rejected: ' || m.rejection_reason, 'Rejected.')
    when m.status = 'drafted' then 'Waiting for a person to approve it.'
    when f.writable is not true
      then 'No adapter may write this field. ' || coalesce(f.note, '')
    when m.status = 'failed'
      then 'Failed: ' || coalesce(m.last_error, 'no error recorded') || '.'
    else null
  end as blocker
from public.meta_profile_changes m
left join public.profile_field_support f
  on f.surface = 'meta' and f.platform = m.platform and f.field = m.field;
