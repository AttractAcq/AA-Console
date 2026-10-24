-- Google Ads, starting with the half that can be proven this month.
--
-- There is no Google Ads adapter in this repository at all — `campaign_action_executors`
-- has said exactly that since migration 230, and it stays saying it. What can
-- be built without an account is the sheet: every object a paid-Google
-- campaign would need, written out from its own package, for somebody with
-- Ads Manager access to create by hand.
--
-- This is deliberately the same shape `meta_build_sheet` already has, and for
-- the same reason it gives: the sheet is wanted precisely when the automated
-- path is unavailable, so it must not depend on a credential. It reads the
-- campaign, calls nothing, and writes one immutable row.
--
-- WHY A ROW RATHER THAN A JOB EVENT
--
-- Meta's sheet writes itself into its job log, which is fine for something
-- read once and typed into Ads Manager. A Google sheet is read more than
-- once: a person builds the campaign from it, then comes back when a keyword
-- group underperforms, then again when the budget changes. So it is a
-- versioned row with a hash, which also means the later executor has a
-- specific thing to be approved against rather than "build the Google
-- campaign".
--
-- WHAT IT REFUSES TO INVENT
--
-- Keyword research. Deriving search intent from a service name and calling it
-- a keyword plan would be the most expensive kind of plausible: somebody
-- would spend against it. So the sheet seeds groups from what the campaign
-- actually has — its content pillars, its offer, its geography — and records
-- `keyword_research` in `missing` until a person or a model has genuinely
-- done it. A sheet that says what it does not know is worth more than one
-- that reads complete.

update public.campaign_action_executors
   set note = 'No Google Ads adapter exists in this repository. The build sheet (migration 243) specifies every object for a hand build; this executor stays unsupported until there is an account to prove an adapter against.'
 where action_key = 'google_ad_build';

-- ---------------------------------------------------------------------------
-- The sheet
-- ---------------------------------------------------------------------------

create table public.google_ads_build_sheets (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.client_campaigns(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  version integer not null check (version > 0),

  -- Everything a person would type into Ads Manager: keyword groups,
  -- negatives, geography, budget, the conversion action, the landing page and
  -- the ad copy. One document rather than columns, because Google's own shape
  -- changes faster than this schema should.
  derived jsonb not null check (jsonb_typeof(derived) = 'object'),

  -- What the sheet does not know. Named rather than left blank, so a person
  -- reading it can tell the difference between "no negatives needed" and
  -- "nobody has thought about negatives".
  missing text[] not null default '{}',

  plan_hash text not null check (plan_hash ~ '^[0-9a-f]{64}$'),
  created_by_job_id uuid references public.agent_jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (campaign_id, version),
  unique (id, client_id)
);

comment on table public.google_ads_build_sheets is
  'Every object a paid-Google campaign needs, written out for a hand build. Immutable and versioned, so the later executor has a specific thing to be approved against rather than "build the Google campaign".';

create index google_ads_build_sheets_campaign_idx
  on public.google_ads_build_sheets (campaign_id, version desc);

create function public.guard_google_ads_sheet_immutable()
returns trigger language plpgsql
set search_path = pg_catalog, public as $$
begin
  raise exception 'A build sheet is immutable. Derive a new version.';
end $$;

create trigger google_ads_build_sheets_immutable before update on public.google_ads_build_sheets
  for each row execute function public.guard_google_ads_sheet_immutable();

alter table public.google_ads_build_sheets enable row level security;
create policy google_ads_build_sheets_read on public.google_ads_build_sheets
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.google_ads_build_sheets to authenticated;
grant all on public.google_ads_build_sheets to service_role;

-- ---------------------------------------------------------------------------
-- Recording one
-- ---------------------------------------------------------------------------

create function public.record_google_ads_sheet_v6(
  p_campaign_id uuid, p_derived jsonb, p_missing text[], p_job_id uuid default null)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_version integer;
  v_hash text;
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a build sheet.';
  end if;
  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  if not found then raise exception 'No such campaign.'; end if;
  if v_campaign.acquisition_mode <> 'paid' or v_campaign.paid_platform <> 'google' then
    raise exception 'That campaign is not a paid Google campaign.';
  end if;
  if p_derived is null or jsonb_typeof(p_derived) <> 'object' then
    raise exception 'A derived sheet is required.';
  end if;

  v_hash := encode(sha256(convert_to(p_derived::text, 'UTF8')), 'hex');

  -- Deriving the same sheet twice is one sheet. A person who presses the
  -- button again because nothing looked like it happened should not get a
  -- version 2 that is identical to version 1.
  select id into v_id from public.google_ads_build_sheets
   where campaign_id = p_campaign_id and plan_hash = v_hash
   order by version desc limit 1;
  if v_id is not null then return v_id; end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.google_ads_build_sheets where campaign_id = p_campaign_id;

  insert into public.google_ads_build_sheets (
    campaign_id, client_id, version, derived, missing, plan_hash, created_by_job_id)
  values (
    p_campaign_id, v_campaign.client_id, v_version, p_derived,
    coalesce(p_missing, '{}'), v_hash, p_job_id)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.record_google_ads_sheet_v6(uuid, jsonb, text[], uuid)
  from public, anon, authenticated;
grant execute on function public.record_google_ads_sheet_v6(uuid, jsonb, text[], uuid) to service_role;

-- ---------------------------------------------------------------------------
-- What a sheet needs, and what it still cannot say
-- ---------------------------------------------------------------------------

create or replace view google_ads_sheet_due with (security_invoker = true) as
select
  c.id as campaign_id,
  c.client_id,
  c.name,
  s.id as sheet_id,
  s.version as sheet_version,
  s.missing,
  s.created_at as sheet_created_at,
  (select count(*) from public.campaign_content_pillars p where p.campaign_id = c.id) as pillars,
  c.daily_budget,
  c.target_countries,
  c.conversion_event,
  exists (select 1 from public.campaign_artifacts a
           where a.campaign_id = c.id and a.kind = 'landing_page' and a.page_id is not null) as has_page,
  (select i.credential_label from public.client_integrations i
    where i.client_id = c.client_id and i.provider = 'google' limit 1) as google_account,
  case
    when not exists (select 1 from public.campaign_manifest_versions v where v.campaign_id = c.id)
      then 'No package yet. Plan the campaign first.'
    when c.daily_budget is null
      then 'No daily budget is set, so the sheet cannot say what to spend.'
    when coalesce(array_length(c.target_countries, 1), 0) = 0
      then 'No geography is set, and a search campaign without one spends everywhere.'
    when nullif(btrim(coalesce(c.conversion_event, '')), '') is null
      then 'No conversion action is named, so there is nothing to optimise towards.'
    when not exists (select 1 from public.campaign_artifacts a
                      where a.campaign_id = c.id and a.kind = 'landing_page' and a.page_id is not null)
      then 'No landing page is attached, so the ads would point nowhere.'
    when s.id is null then null
    else 'Sheet v' || s.version::text || ' is ready for a hand build.'
  end as blocker
from public.client_campaigns c
left join public.google_ads_build_sheets s
  on s.campaign_id = c.id
 and s.version = (select max(s2.version) from public.google_ads_build_sheets s2
                   where s2.campaign_id = c.id)
left join public.campaign_manifest_versions m on m.campaign_id = c.id
where c.acquisition_mode = 'paid' and c.paid_platform = 'google' and c.archived_at is null;

comment on view google_ads_sheet_due is
  'Each paid-Google campaign and what its build sheet still needs. A null blocker means a sheet can be derived now; "ready for a hand build" means one exists, which is as far as this module goes without an account.';

grant select on google_ads_sheet_due to authenticated;

insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('google_ads_sheet', 'Google Ads Build Sheet', 'GS', null,
   'Writes out every object a paid-Google campaign needs, for a hand build in Ads Manager. Calls Google never and holds no credential, so it works precisely when the automated path does not. Seeds keyword groups from the campaign''s own pillars and offer, and says in the sheet that seeds are not research.',
   array[]::text[])
on conflict (agent_key) do update
  set name = excluded.name, initials = excluded.initials,
      description = excluded.description, requires_upstream = excluded.requires_upstream;

select lock_down_definer_functions();
