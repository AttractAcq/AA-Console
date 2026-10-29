-- G03: building the Google campaign the sheet specifies.
--
-- Migration 243 derives a build sheet and always lists `keyword_research` as
-- missing, because the system has not done any. `google_ad_build` has been
-- unsupported since 230 with the note that no adapter exists. This adds the
-- adapter, and the gate in front of it.
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
-- descriptions of ninety. A person or the copywriter fills it, and the
-- request refuses without it by name.
--
-- EVERYTHING IS CREATED PAUSED
--
-- The same rule as Meta, for the same reason, and the adapter has no code
-- path that sets a campaign, ad group or ad to ENABLED. Spend starts when a
-- person switches it on in Google Ads.
--
-- WHAT IS NOT PROVEN
--
-- No client has a Google Ads credential, and the API needs a developer token
-- Google issues on application as well as OAuth per account. The adapter is
-- written against the real endpoints and gated on the credential existing;
-- the acceptance gate is a paused campaign appearing in a real account with
-- its resource names recorded, not this migration existing.

-- ---------------------------------------------------------------------------
-- The copy Google will actually accept
-- ---------------------------------------------------------------------------

-- A check constraint may not contain a subquery, so the per-element limit
-- goes through an immutable helper. Enforcing it in the table rather than in
-- the caller is the point: a build that discovers a thirty-one character
-- headline at Google has already created a budget, a campaign and an ad
-- group.
create or replace function public.all_within_length(p_values text[], p_max integer)
returns boolean language sql immutable
set search_path = pg_catalog, public as $fn$
  select coalesce(bool_and(length(v) between 1 and p_max), false)
    from unnest(coalesce(p_values, '{}'::text[])) v;
$fn$;

create table if not exists public.google_ads_copy (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid not null references public.client_campaigns(id) on delete cascade,
  -- Google's own limits.
  headlines text[] not null check (
    array_length(headlines, 1) between 3 and 15
    and public.all_within_length(headlines, 30)),
  descriptions text[] not null check (
    array_length(descriptions, 1) between 2 and 4
    and public.all_within_length(descriptions, 90)),
  final_url text not null check (final_url ~ '^https?://'),
  path1 text check (path1 is null or length(path1) <= 15),
  path2 text check (path2 is null or length(path2) <= 15),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (campaign_id)
);

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
  campaign_id uuid not null references public.client_campaigns(id) on delete cascade,
  approval_id uuid not null unique
    references public.campaign_action_approvals(id) on delete cascade,
  sheet_id uuid references public.google_ads_build_sheets(id) on delete set null,

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
  updated_at timestamptz not null default now()
);

comment on table public.google_ads_builds is
  'One build of one approved Google campaign, with the resource names it created. Partial builds keep what they made, because the alternative is orphaned objects nobody can find.';

alter table public.google_ads_builds enable row level security;
drop policy if exists google_ads_builds_read on public.google_ads_builds;
create policy google_ads_builds_read on public.google_ads_builds
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.google_ads_builds to authenticated;
grant all on public.google_ads_builds to service_role;

drop trigger if exists google_ads_builds_updated_at on public.google_ads_builds;
create trigger google_ads_builds_updated_at before update on public.google_ads_builds
  for each row execute function public.set_updated_at();

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
  v_approval public.campaign_action_approvals%rowtype;
  v_hash text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service can request a campaign action.';
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
  if array_length(v_sheet.missing, 1) > 0 then
    -- Named, because `keyword_research` is always one of them and a person
    -- has to go and do it in Google's own tools.
    raise exception 'The build sheet is still missing: %. Fill those in before asking to build.',
      array_to_string(v_sheet.missing, ', ');
  end if;

  select * into v_copy from public.google_ads_copy where campaign_id = p_campaign_id;
  if not found then
    raise exception 'This campaign has no approved ad copy. Google will not create an ad without headlines and descriptions.';
  end if;

  if not exists (select 1 from public.client_integrations i
                  where i.client_id = v_campaign.client_id
                    and i.provider = 'google_ads' and i.status = 'connected') then
    raise exception 'This client has no connected Google Ads account, so an approval would authorise something that cannot happen.';
  end if;

  -- Bound to the sheet and the copy together: changing either is a different
  -- campaign from the one somebody read.
  v_hash := encode(sha256(convert_to(
    v_sheet.plan_hash || '|' ||
    encode(sha256(convert_to(
      array_to_string(v_copy.headlines, '~') || '|' ||
      array_to_string(v_copy.descriptions, '~') || '|' || v_copy.final_url, 'UTF8')), 'hex'),
    'UTF8')), 'hex');

  select * into v_approval from public.request_campaign_action_approval_v6(
    v_manifest.id,
    'google_ad_build:' || p_campaign_id::text || ':' || v_hash,
    'google_ad_build',
    'Google Ads search campaign',
    v_hash,
    jsonb_build_object(
      'sheet_id', v_sheet.id,
      'sheet_version', v_sheet.version,
      'derived', v_sheet.derived,
      'headlines', v_copy.headlines,
      'descriptions', v_copy.descriptions,
      'final_url', v_copy.final_url,
      'requested_by', p_actor));
  return v_approval.id;
end $fn$;

comment on function public.request_campaign_google_build_v6(uuid, uuid) is
  'Asks to build the Google campaign the sheet specifies, refusing while the sheet has missing items, while there is no ad copy, or while no account is connected. Bound to the sheet and the copy together.';

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
  v_hash text;
  b public.google_ads_builds%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may build a Google campaign.';
  end if;
  select * into x from public.campaign_action_executions where id = p_execution_id;
  if not found then raise exception 'No such execution.'; end if;
  select * into a from public.campaign_action_approvals where id = x.approval_id;
  if a.action_key <> 'google_ad_build' then
    raise exception 'That approval is a %, not a Google build.', a.action_key;
  end if;
  if a.status <> 'approved' then
    raise exception 'That build is %, not approved.', a.status;
  end if;

  select * into v_sheet from public.google_ads_build_sheets
   where id = nullif(a.scope->>'sheet_id', '')::uuid;
  if not found then raise exception 'That approval names no build sheet.'; end if;
  select * into v_copy from public.google_ads_copy where campaign_id = a.campaign_id;
  if not found then raise exception 'The ad copy has been removed since this was approved.'; end if;

  -- Re-hashed immediately before the first write. A sheet re-derived or copy
  -- edited after the yes is a different campaign.
  v_hash := encode(sha256(convert_to(
    v_sheet.plan_hash || '|' ||
    encode(sha256(convert_to(
      array_to_string(v_copy.headlines, '~') || '|' ||
      array_to_string(v_copy.descriptions, '~') || '|' || v_copy.final_url, 'UTF8')), 'hex'),
    'UTF8')), 'hex');
  if v_hash <> a.artifact_version_hash then
    raise exception 'The sheet or the ad copy changed after this was approved. Ask again.';
  end if;

  insert into public.google_ads_builds (
    client_id, campaign_id, approval_id, sheet_id, attempts)
  values (a.client_id, a.campaign_id, a.id, v_sheet.id, 1)
  on conflict (approval_id) do update set attempts = google_ads_builds.attempts + 1
  returning * into b;
  return b;
end $fn$;

comment on function public.start_google_build_v6(uuid) is
  'Opens the build record for one approved Google campaign, re-hashing the sheet and the copy immediately before the first external write. One record per approval, however many attempts.';

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
   where id = p_build_id;
  if not found then raise exception 'No such build.'; end if;
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
  update public.google_ads_builds
     set status = case when p_error is null then 'built' else 'failed' end,
         built_at = case when p_error is null then now() else built_at end,
         last_error = p_error
   where id = p_build_id returning * into b;
  if not found then raise exception 'No such build.'; end if;

  if p_error is null then
    -- Recorded on the campaign so Attribution OS can join Google spend to
    -- the operational campaign without anybody binding ids by hand.
    update public.client_campaigns
       set ad_campaign_id = ad_campaign_id
     where id = b.campaign_id;
  end if;
end $fn$;

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
  s.missing,
  (cp.campaign_id is not null) as has_copy,
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
    when array_length(s.missing, 1) > 0
      then 'The sheet is still missing: ' || array_to_string(s.missing, ', ') || '.'
    when cp.campaign_id is null
      then 'No ad copy. Google will not create an ad without headlines and descriptions.'
    when not exists (select 1 from public.client_integrations i
                      where i.client_id = c.client_id
                        and i.provider = 'google_ads' and i.status = 'connected')
      then 'No connected Google Ads account for this client. This adapter has never run against a real account.'
    when b.status = 'failed'
      then 'The build failed: ' || coalesce(b.last_error, 'no error recorded') || '.'
    when b.status = 'built' then null
    when b.id is not null then 'Building.'
    else null
  end as blocker
from public.client_campaigns c
left join lateral (
  select * from public.google_ads_build_sheets s2
   where s2.campaign_id = c.id order by s2.version desc limit 1) s on true
left join public.google_ads_copy cp on cp.campaign_id = c.id
left join lateral (
  select * from public.google_ads_builds b2
   where b2.campaign_id = c.id order by b2.created_at desc limit 1) b on true
where c.archived_at is null;

comment on view google_ads_build_due is
  'Per Google campaign, what stands between the sheet and a built campaign. The sheet''s own missing list is read out, because keyword_research is always on it and a person has to go and do it.';

grant select on google_ads_build_due to authenticated;

update public.campaign_action_executors
   set supported = true,
       executor_module = 'google_ads_studio',
       note = 'Creates the paused Google search campaign the build sheet specifies, from the sheet and the approved ad copy, re-hashing both immediately before the first write. Nothing is created enabled. Needs a connected Google Ads account and a developer token Google issues on application; this adapter has never run against a real account.'
 where action_key = 'google_ad_build';

select lock_down_definer_functions();
