-- STAGING ONLY: reconcile the alternate-stamped 260 catalog before 261–272.
-- This is deliberately outside supabase/migrations on main. The isolated
-- workspace generator copies it between historical alias 260 and canonical 261.
-- Applied alternate 259/260 bytes are unavailable. This file repairs the
-- observed catalog; it does not claim exact historical SQL equivalence.
-- It must run only after the fresh read-only P01–P20 + full-history guard.

begin;

-- Lock external-action claiming before changing the false capability flag.
lock table public.campaign_action_executors in share row exclusive mode;
lock table public.client_engine_settings in share row exclusive mode;
lock table public.clients, auth.users in share row exclusive mode;
lock table public.client_campaigns, public.campaign_manifest_versions,
           public.google_ads_build_sheets, public.google_ads_copy,
           public.google_ads_builds, public.campaign_action_approvals,
           public.campaign_action_executions, public.client_integrations
  in share row exclusive mode;

create temporary table _aa_staging_identity_before on commit drop as
select (select count(*) from public.clients) as client_count,
       (select md5(coalesce(string_agg(id::text, ',' order by id), ''))
          from public.clients) as client_ids_md5,
       (select count(*) from auth.users) as auth_user_count,
       (select md5(coalesce(string_agg(id::text, ',' order by id), ''))
          from auth.users) as auth_user_ids_md5;

do $guard$
declare n integer;
begin
  if (select count(*) from supabase_migrations.schema_migrations) <> 277
     or not exists (select 1 from supabase_migrations.schema_migrations
                     where version = '20261025240000'
                       and name = '259_which_client_a_message_belongs_to')
     or not exists (select 1 from supabase_migrations.schema_migrations
                     where version = '20261025250000'
                       and name = '260_building_the_google_campaign')
     or exists (select 1 from supabase_migrations.schema_migrations
                 where version in ('20261025233000', '20261025235000')) then
    raise exception 'Staging history changed; stop the 260 correction';
  end if;
  if (select client_count from _aa_staging_identity_before) <> 1
     or (select auth_user_count from _aa_staging_identity_before) <> 5 then
    raise exception 'Retained staging identities changed; stop the 260 correction';
  end if;
  if (select count(*) from public.client_campaigns) <> 0
     or (select count(*) from public.campaign_manifest_versions) <> 0
     or (select count(*) from public.google_ads_build_sheets) <> 0
     or (select count(*) from public.google_ads_copy) <> 0
     or (select count(*) from public.google_ads_builds) <> 0
     or (select count(*) from public.campaign_action_approvals) <> 0
     or (select count(*) from public.campaign_action_executions) <> 0
     or (select count(*) from public.client_integrations) <> 0 then
    raise exception 'Affected rows exist; a row-preserving backfill is required';
  end if;
  if (select count(*) from public.client_engine_settings
        where campaign_actions_enabled) <> 0 then
    raise exception 'Campaign-action switch is enabled';
  end if;
  if (select count(*) from public.campaign_action_executors
        where action_key = 'google_ad_build' and supported) <> 1 then
    raise exception 'Unexpected Google build capability state';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public'
                and ((table_name = 'google_ads_build_sheets' and column_name = 'manifest_id')
                  or (table_name = 'google_ads_builds' and column_name = 'approved_spec')
                  or (table_name = 'client_integrations' and column_name = 'google_ads_customer_id'))) then
    raise exception 'A reviewed 260 column already exists; refresh catalog plan';
  end if;
  select count(*) into n from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
   where c.relname in ('google_ads_builds','google_ads_copy')
     and k.conname in ('google_ads_builds_approval_id_fkey',
                      'google_ads_builds_campaign_id_fkey',
                      'google_ads_builds_sheet_id_fkey',
                      'google_ads_copy_campaign_id_fkey');
  if n <> 4 then
    raise exception 'Expected four old simple Google foreign keys, found %', n;
  end if;
end $guard$;

-- First state change: stop the unsupported external action while DDL proceeds.
update public.campaign_action_executors
   set supported = false,
       executor_module = 'google_ads_studio',
       note = 'Staging 260 reconciliation: no verified Google Ads build handler or real-account probe exists.'
 where action_key = 'google_ad_build';

-- G03 prerequisite: record the exact Google build specification and its gate.
--
-- Migration 243 derives a build sheet and always lists `keyword_research` as
-- missing, because the system has not done any. `google_ad_build` has been
-- unsupported since 230 with the note that no adapter exists. This migration
-- adds schema and approval binding for a later adapter. It does not add a
-- runtime handler or enable claiming this action. A sheet generated by the
-- current agent cannot be requested as a build: it still lacks research.
--
-- WHAT THE SHEET DOES NOT CONTAIN, WHICH TOOK READING IT TO NOTICE
--
-- `DerivedSheet.ads` carries `headline_source` and `description_source` --
-- where the copy should come from -- and a count. It does not carry copy.
-- Google will not create a responsive search ad without real headlines and
-- descriptions, each inside its own character limit, so a build from the
-- sheet alone would fail at the last call with everything else already
-- created.
--
-- So the copy is its own table, with the limits enforced here rather than
-- discovered at Google: fifteen headlines of thirty characters, four
-- descriptions of ninety. A later copy workflow must fill it, and the
-- request refuses without it by name. This migration adds no copy editor.
--
-- A later handler must create everything paused and validate the exact
-- approved specification immediately before its first external call. There
-- is no such handler in this migration or this repository state.
--
-- WHAT IS NOT PROVEN
--
-- No client has a Google Ads credential, and the API needs a developer token
-- Google issues on application as well as OAuth per account. A connected
-- integration metadata row is not proof of usable credentials or API access.
-- The acceptance gate for a later handler is a paused campaign appearing in
-- a real account with its resource names recorded.

-- ---------------------------------------------------------------------------
-- Bind new sheets to the package they were derived for
-- ---------------------------------------------------------------------------

-- Existing 243 sheets cannot prove which manifest they describe. Keep them
-- readable for a hand build, but never infer lineage from created_at or the
-- latest manifest. The NOT VALID check accepts those existing rows while
-- requiring every post-260 insert to name a manifest.
alter table public.google_ads_build_sheets
  add column manifest_id uuid;

alter table public.google_ads_build_sheets
  add constraint google_ads_build_sheets_manifest_required_260
    check (manifest_id is not null) not valid,
  add constraint google_ads_build_sheets_manifest_identity_260
    foreign key (manifest_id, campaign_id, client_id)
    references public.campaign_manifest_versions(id, campaign_id, client_id)
    on delete cascade,
  add constraint google_ads_build_sheets_build_identity_260
    unique (id, campaign_id, client_id);

comment on column public.google_ads_build_sheets.manifest_id is
  'Exact immutable campaign manifest used to derive this sheet. Null means a pre-260 sheet with unknown lineage; it cannot authorize an automated build.';

alter table public.campaign_action_approvals
  add constraint campaign_action_approvals_build_identity_260
    unique (id, campaign_id, client_id);

-- The old signature has no manifest identity. It must fail closed after 260
-- rather than attaching a stale derivation to whatever package is newest at
-- recording time. The runtime now calls the explicit five-argument RPC.
create or replace function public.record_google_ads_sheet_v6(
  p_campaign_id uuid, p_derived jsonb, p_missing text[], p_job_id uuid default null)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $fn$
begin
  raise exception 'A Google build sheet now requires the manifest id captured before derivation. Use record_google_ads_sheet_for_manifest_v6.';
end $fn$;

create or replace function public.record_google_ads_sheet_for_manifest_v6(
  p_campaign_id uuid, p_manifest_id uuid, p_derived jsonb,
  p_missing text[], p_job_id uuid default null)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare
  v_campaign public.client_campaigns%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_version integer;
  v_hash text;
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a build sheet.';
  end if;
  if p_derived is null or jsonb_typeof(p_derived) <> 'object' or p_missing is null then
    raise exception 'A derived sheet and its explicit missing list are required.';
  end if;

  -- create_campaign_manifest_v6 locks the same campaign row. A new package
  -- cannot be committed between this check and the sheet insert.
  select * into v_campaign from public.client_campaigns
   where id = p_campaign_id for update;
  if not found then raise exception 'No such campaign.'; end if;
  if v_campaign.acquisition_mode <> 'paid' or v_campaign.paid_platform <> 'google' then
    raise exception 'That campaign is not a paid Google campaign.';
  end if;
  select * into v_manifest from public.campaign_manifest_versions
   where id = p_manifest_id and campaign_id = p_campaign_id
     and client_id = v_campaign.client_id;
  if not found then raise exception 'That campaign manifest does not match this campaign and client.'; end if;
  if v_manifest.acquisition_mode <> 'paid' or v_manifest.paid_platform <> 'google' then
    raise exception 'The captured package is not a paid Google package.';
  end if;
  if exists (select 1 from public.campaign_manifest_versions newer
              where newer.campaign_id = p_campaign_id
                and newer.version > v_manifest.version) then
    raise exception 'The campaign package changed during sheet derivation. Derive again from the latest package.';
  end if;

  -- Include the exact manifest and the missing list. A replan or completed
  -- research must produce a new immutable sheet even if other fields match.
  v_hash := encode(sha256(convert_to(jsonb_build_object(
    'manifest_id', p_manifest_id,
    'derived', p_derived,
    'missing', p_missing)::text, 'UTF8')), 'hex');
  select id into v_id from public.google_ads_build_sheets
   where campaign_id = p_campaign_id and manifest_id = p_manifest_id
     and plan_hash = v_hash
   order by version desc limit 1;
  if v_id is not null then return v_id; end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.google_ads_build_sheets where campaign_id = p_campaign_id;
  insert into public.google_ads_build_sheets (
    campaign_id, client_id, manifest_id, version, derived, missing,
    plan_hash, created_by_job_id)
  values (
    p_campaign_id, v_campaign.client_id, p_manifest_id, v_version,
    p_derived, p_missing, v_hash, p_job_id)
  returning id into v_id;
  return v_id;
end $fn$;

revoke all on function public.record_google_ads_sheet_for_manifest_v6(
  uuid, uuid, jsonb, text[], uuid) from public, anon, authenticated;
grant execute on function public.record_google_ads_sheet_for_manifest_v6(
  uuid, uuid, jsonb, text[], uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Copy fields a later Google adapter will need
-- ---------------------------------------------------------------------------

-- A check constraint may not contain a subquery, so the per-element limit
-- goes through an immutable helper. Enforcing it in the table rather than in
-- the caller is the point: a build that discovers a thirty-one character
-- headline at Google has already created a budget, a campaign and an ad
-- group.
create or replace function public.all_within_length(p_values text[], p_max integer)
returns boolean language sql immutable
set search_path = pg_catalog, public as $fn$
  select coalesce(bool_and(v is not null and length(v) between 1 and p_max), false)
    from unnest(coalesce(p_values, '{}'::text[])) v;
$fn$;

create table if not exists public.google_ads_copy (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid not null,
  -- Google's own limits.
  headlines text[] not null check (
    array_length(headlines, 1) between 3 and 15
    and public.all_within_length(headlines, 30)),
  descriptions text[] not null check (
    array_length(descriptions, 1) between 2 and 4
    and public.all_within_length(descriptions, 90)),
  final_url text not null check (final_url ~ '^https?://'),
  path1 text check (path1 is null or length(path1) between 1 and 15),
  path2 text check (path2 is null or length(path2) between 1 and 15),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (campaign_id),
  foreign key (campaign_id, client_id)
    references public.client_campaigns(id, client_id) on delete cascade
);

-- The alternate 260 created this table with weaker display-path checks
-- and a single-column campaign FK. Every row is absent at the preflight gate.
alter table public.google_ads_copy
  drop constraint google_ads_copy_campaign_id_fkey,
  drop constraint google_ads_copy_path1_check,
  drop constraint google_ads_copy_path2_check,
  add constraint google_ads_copy_campaign_id_client_id_fkey
    foreign key (campaign_id, client_id)
    references public.client_campaigns(id, client_id) on delete cascade,
  add constraint google_ads_copy_path1_check
    check (path1 is null or length(path1) between 1 and 15),
  add constraint google_ads_copy_path2_check
    check (path2 is null or length(path2) between 1 and 15);

comment on table public.google_ads_copy is
  'The headlines and descriptions a responsive search ad needs, inside Google''s own character limits. The build sheet names where copy should come from; this is the copy.';

alter table public.google_ads_copy enable row level security;
drop policy if exists google_ads_copy_read on public.google_ads_copy;
create policy google_ads_copy_read on public.google_ads_copy
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.google_ads_copy to authenticated;
grant all on public.google_ads_copy to service_role;

-- ---------------------------------------------------------------------------
-- What was built
-- ---------------------------------------------------------------------------

create table if not exists public.google_ads_builds (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid not null,
  approval_id uuid not null unique,
  -- A build must retain its exact sheet while it exists. Deferred NO ACTION
  -- blocks deleting that sheet alone, while a campaign/client cascade can
  -- delete both records in one transaction without trigger-order failures.
  sheet_id uuid not null,
  -- Immutable input snapshot for the later handler. The handler must consume
  -- this rather than re-reading mutable copy after the approval was checked.
  approved_spec jsonb not null check (jsonb_typeof(approved_spec) = 'object'),

  -- Google addresses everything by resource name, so those are what is worth
  -- keeping: `customers/123/campaigns/456`.
  customer_id text,
  budget_resource text,
  campaign_resource text,
  ad_group_resource text,
  ad_resources text[] not null default '{}',
  keyword_count integer not null default 0,
  negative_count integer not null default 0,

  status text not null default 'building' check (status in (
    'building', 'built', 'failed')),
  attempts integer not null default 0,
  built_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (campaign_id, client_id)
    references public.client_campaigns(id, client_id) on delete cascade,
  foreign key (approval_id, campaign_id, client_id)
    references public.campaign_action_approvals(id, campaign_id, client_id)
    on delete cascade,
  foreign key (sheet_id, campaign_id, client_id)
    references public.google_ads_build_sheets(id, campaign_id, client_id)
    on delete no action deferrable initially deferred
);

-- The alternate build table is empty. Tighten it to the exact
-- approved identity and replace its old simple foreign keys.
alter table public.google_ads_builds
  add column approved_spec jsonb;
alter table public.google_ads_builds
  alter column sheet_id set not null,
  alter column approved_spec set not null,
  drop constraint google_ads_builds_approval_id_fkey,
  drop constraint google_ads_builds_campaign_id_fkey,
  drop constraint google_ads_builds_sheet_id_fkey,
  add constraint google_ads_builds_approved_spec_check
    check (jsonb_typeof(approved_spec) = 'object'),
  add constraint google_ads_builds_campaign_id_client_id_fkey
    foreign key (campaign_id, client_id)
    references public.client_campaigns(id, client_id) on delete cascade,
  add constraint google_ads_builds_approval_id_campaign_id_client_id_fkey
    foreign key (approval_id, campaign_id, client_id)
    references public.campaign_action_approvals(id, campaign_id, client_id)
    on delete cascade,
  add constraint google_ads_builds_sheet_id_campaign_id_client_id_fkey
    foreign key (sheet_id, campaign_id, client_id)
    references public.google_ads_build_sheets(id, campaign_id, client_id)
    on delete no action deferrable initially deferred;

comment on table public.google_ads_builds is
  'One build of one approved Google campaign, with the resource names it created. Partial builds keep what they made, because the alternative is orphaned objects nobody can find.';

create or replace function public.guard_google_ads_build_identity_v6()
returns trigger language plpgsql
set search_path = pg_catalog, public as $fn$
begin
  if old.client_id is distinct from new.client_id
     or old.campaign_id is distinct from new.campaign_id
     or old.approval_id is distinct from new.approval_id
     or old.sheet_id is distinct from new.sheet_id
     or old.approved_spec is distinct from new.approved_spec then
    raise exception 'A Google build cannot change its approved identity or specification.';
  end if;
  return new;
end $fn$;

drop trigger if exists google_ads_build_identity_v6 on public.google_ads_builds;
create trigger google_ads_build_identity_v6
  before update on public.google_ads_builds
  for each row execute function public.guard_google_ads_build_identity_v6();

alter table public.google_ads_builds enable row level security;
drop policy if exists google_ads_builds_read on public.google_ads_builds;
create policy google_ads_builds_read on public.google_ads_builds
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.google_ads_builds to authenticated;
grant all on public.google_ads_builds to service_role;

drop trigger if exists google_ads_builds_updated_at on public.google_ads_builds;
create trigger google_ads_builds_updated_at before update on public.google_ads_builds
  for each row execute function public.set_updated_at();

-- JSONB keeps array boundaries, nulls and field names unambiguous. In
-- particular, joining headlines with a character would let two different
-- arrays have the same bytes, and omitting the display paths would let copy
-- change without invalidating the human decision.
create or replace function public.google_ads_build_spec_v6(
  p_sheet public.google_ads_build_sheets,
  p_copy public.google_ads_copy)
returns jsonb language sql stable strict
set search_path = pg_catalog, public as $fn$
  select jsonb_build_object(
    'schema', 'google_ads_build_spec_v1',
    'client_id', (p_sheet).client_id,
    'campaign_id', (p_sheet).campaign_id,
    'sheet_manifest_id', (p_sheet).manifest_id,
    'sheet_id', (p_sheet).id,
    'sheet_version', (p_sheet).version,
    'sheet_plan_hash', (p_sheet).plan_hash,
    'sheet_derived', (p_sheet).derived,
    'sheet_missing', (p_sheet).missing,
    'copy_id', (p_copy).id,
    'headlines', (p_copy).headlines,
    'descriptions', (p_copy).descriptions,
    'final_url', (p_copy).final_url,
    'path1', (p_copy).path1,
    'path2', (p_copy).path2);
$fn$;

revoke all on function public.google_ads_build_spec_v6(
  public.google_ads_build_sheets, public.google_ads_copy) from public, anon, authenticated;
grant execute on function public.google_ads_build_spec_v6(
  public.google_ads_build_sheets, public.google_ads_copy) to service_role;

-- A Google account needs its own destination identity. The human-friendly
-- credential label is not an account binding, and a "connected" row alone
-- does not establish that the runtime can use Google Ads.
alter table public.client_integrations
  add column google_ads_customer_id text
    check (google_ads_customer_id is null or google_ads_customer_id ~ '^[0-9]{10}$');

comment on column public.client_integrations.google_ads_customer_id is
  'Exact ten-digit Google Ads customer id, without separators. A request binds this destination, but the action remains unsupported until a runtime handler and a real account probe exist.';

-- ---------------------------------------------------------------------------
-- Asking
-- ---------------------------------------------------------------------------

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
     and i.provider = 'google_ads' and i.status = 'connected'
     and i.google_ads_customer_id is not null;
  if v_integration_count <> 1 then
    raise exception 'A Google build needs exactly one connected integration with a recorded, exact Google Ads customer id; found %.',
      v_integration_count;
  end if;
  select * into v_integration from public.client_integrations i
   where i.client_id = v_campaign.client_id
     and i.provider = 'google_ads' and i.status = 'connected'
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

comment on function public.request_campaign_google_build_v6(uuid, uuid) is
  'Asks for an exact-version Google build approval only after keyword research, ad copy, a unique exact account binding and an enabled runtime handler exist. Migration 260 leaves that handler unsupported.';

revoke all on function public.request_campaign_google_build_v6(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.request_campaign_google_build_v6(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Doing it
-- ---------------------------------------------------------------------------

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
     and i.provider = 'google_ads' and i.status = 'connected'
     and i.google_ads_customer_id is not null;
  if not found then
    raise exception 'The approved Google Ads account is no longer connected.';
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

comment on function public.start_google_build_v6(uuid) is
  'Opens a build only for an enabled handler and a still-current exact approval; snapshots every reviewed field and destination. One record per approval, however many attempts.';

revoke all on function public.start_google_build_v6(uuid) from public, anon, authenticated;
grant execute on function public.start_google_build_v6(uuid) to service_role;

create or replace function public.record_google_build_progress_v6(
  p_build_id uuid, p_patch jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $fn$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record build progress.';
  end if;
  -- Recorded step by step rather than once at the end: a build that fails
  -- halfway has created real objects, and the resource names are the only
  -- way anybody finds them again.
  update public.google_ads_builds
     set customer_id = coalesce(p_patch->>'customer_id', customer_id),
         budget_resource = coalesce(p_patch->>'budget_resource', budget_resource),
         campaign_resource = coalesce(p_patch->>'campaign_resource', campaign_resource),
         ad_group_resource = coalesce(p_patch->>'ad_group_resource', ad_group_resource),
         ad_resources = case
           when p_patch ? 'ad_resources'
           then coalesce(array(select jsonb_array_elements_text(p_patch->'ad_resources')), ad_resources)
           else ad_resources end,
         keyword_count = coalesce((p_patch->>'keyword_count')::int, keyword_count),
         negative_count = coalesce((p_patch->>'negative_count')::int, negative_count)
   where id = p_build_id and status = 'building';
  if not found then raise exception 'No build is currently building with that id.'; end if;
end $fn$;

revoke all on function public.record_google_build_progress_v6(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_google_build_progress_v6(uuid, jsonb) to service_role;

create or replace function public.record_google_build_finished_v6(
  p_build_id uuid, p_error text default null)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare b public.google_ads_builds%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may finish a build.';
  end if;
  select * into b from public.google_ads_builds where id = p_build_id for update;
  if not found then raise exception 'No such build.'; end if;
  if b.status <> 'building' then
    raise exception 'This build is %, not building.', b.status;
  end if;
  if p_error is null and
     (nullif(btrim(coalesce(b.campaign_resource, '')), '') is null
      or nullif(btrim(coalesce(b.ad_group_resource, '')), '') is null
      or coalesce(array_length(b.ad_resources, 1), 0) = 0) then
    raise exception 'A successful build must record its Google campaign, ad group and ad resource names.';
  end if;
  if p_error is not null and nullif(btrim(p_error), '') is null then
    raise exception 'A failed build needs a nonempty error.';
  end if;
  update public.google_ads_builds
     set status = case when p_error is null then 'built' else 'failed' end,
         built_at = case when p_error is null then now() else built_at end,
         last_error = case when p_error is null then null else btrim(p_error) end
   where id = p_build_id;
end $fn$;

comment on function public.record_google_build_finished_v6(uuid, text) is
  'Marks the internal Google build record complete only with external resource names. This does not bind spend attribution: client_campaigns.ad_campaign_id is a legacy internal UUID, not a Google Ads campaign resource. A later verified attribution binding is required.';

revoke all on function public.record_google_build_finished_v6(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_google_build_finished_v6(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- What is stopping a build
-- ---------------------------------------------------------------------------

drop view if exists google_ads_build_due;

create view google_ads_build_due with (security_invoker = true) as
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
             and i.provider = 'google_ads' and i.status = 'connected'
             and i.google_ads_customer_id is not null) <> 1
      then 'Exactly one connected Google Ads integration with an exact customer id is required.'
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
  -- The alternate table receives approved_spec as a late ADD COLUMN. Select
  -- explicitly in reviewed 260 order so pg_get_viewdef and downstream catalog
  -- evidence match a clean canonical replay despite physical attnum order.
  select b2.id, b2.client_id, b2.campaign_id, b2.approval_id,
         b2.sheet_id, b2.approved_spec, b2.customer_id,
         b2.budget_resource, b2.campaign_resource, b2.ad_group_resource,
         b2.ad_resources, b2.keyword_count, b2.negative_count,
         b2.status, b2.attempts, b2.built_at, b2.last_error,
         b2.created_at, b2.updated_at
    from public.google_ads_builds b2
   where b2.campaign_id = c.id and b2.client_id = c.client_id
     and b2.sheet_id = s.id and s.manifest_id = m.id
     and b2.approved_spec->>'sheet_id' = s.id::text
     and b2.approved_spec->>'sheet_manifest_id' = m.id::text
   order by b2.created_at desc limit 1) b on true
where c.archived_at is null;

comment on view google_ads_build_due is
  'Per Google campaign, what stands between its latest manifest-bound sheet and a built campaign. Earlier completed builds remain historical and cannot hide a current blocker. A normal derived sheet names keyword_research as missing; even a complete sheet remains blocked while no runtime handler exists.';

grant select on google_ads_build_due to authenticated;

update public.campaign_action_executors
   set supported = false,
       executor_module = 'google_ads_studio',
       note = 'Migration 260 prepares the exact Google Ads build specification and approval binding, but no runtime action handler or verified account probe exists. Normal sheets still lack keyword research. Do not claim google_ad_build until a paused real-account build and exact-version checks pass.'
 where action_key = 'google_ad_build';

select lock_down_definer_functions();

-- No identity row may be added, removed or replaced in this transaction.
do $guard$
begin
  if (select count(*) from public.clients) <>
       (select client_count from _aa_staging_identity_before)
     or (select md5(coalesce(string_agg(id::text, ',' order by id), ''))
           from public.clients) <>
       (select client_ids_md5 from _aa_staging_identity_before)
     or (select count(*) from auth.users) <>
       (select auth_user_count from _aa_staging_identity_before)
     or (select md5(coalesce(string_agg(id::text, ',' order by id), ''))
           from auth.users) <>
       (select auth_user_ids_md5 from _aa_staging_identity_before) then
    raise exception 'Staging client/Auth identities changed during correction';
  end if;
  if exists (select 1 from public.campaign_action_executors
              where action_key = 'google_ad_build' and supported) then
    raise exception 'Google build capability unexpectedly enabled';
  end if;
end $guard$;

commit;
