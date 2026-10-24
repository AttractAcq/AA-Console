-- Which version of an offer is still out there.
--
-- Offer Studio's v1 is the strongest v1 of the seven: offers are versioned,
-- versions are immutable, sign-off refuses a quantified claim with no proof
-- behind it, and the campaign planner, page builder and sales-agent builder
-- all freeze the selected version into their inputs. The discipline is real.
--
-- What none of it can answer is the question somebody asks the day after a
-- reprice: where is the old version still live? The bindings to answer it all
-- exist and none of them are joined — the campaign's selected version, the
-- package's frozen version, the magnet's, and the pages and agents that hang
-- off a campaign. So a client raises their price, every new asset is correct,
-- and a PDF quoting last year's figure keeps being emailed to strangers.
--
-- That is not a tidiness problem. It is the client's credibility, and it is
-- invisible in a way that gets worse with time rather than better.
--
-- WHAT COUNTS AS CURRENT
--
-- The newest signed-off version of an offer. Not the newest version: a draft
-- v4 nobody approved does not make a live v3 wrong. So `is_current` compares
-- against the highest version that has a sign-off, and a surface carrying
-- anything older is superseded.
--
-- WHAT COUNTS AS LIVE
--
-- Per surface, and only where it is knowable. A published campaign page is
-- live because a commit exists; a magnet is live because its version has a
-- standing approval; a sales agent is live because a deployment is enabled.
-- A campaign is deliberately not called live by this view, because a v6
-- campaign's live state is still gated elsewhere and inventing it here would
-- be the sort of badge-into-evidence promotion the plan warns about. Unknown
-- stays unknown.

-- ---------------------------------------------------------------------------
-- The current version of each offer
-- ---------------------------------------------------------------------------

create or replace view offer_current_version with (security_invoker = true) as
select
  v.offer_id,
  v.client_id,
  max(v.version) as current_version,
  (array_agg(v.id order by v.version desc))[1] as current_version_id
from public.service_offer_versions v
join public.service_offer_signoffs s on s.offer_version_id = v.id
group by v.offer_id, v.client_id;

comment on view offer_current_version is
  'The newest signed-off version of each offer. Not the newest version: a draft nobody approved does not make a live one wrong.';

grant select on offer_current_version to authenticated;

-- ---------------------------------------------------------------------------
-- Where each version is carried
-- ---------------------------------------------------------------------------

-- One row per surface carrying one offer version. A union rather than five
-- separate screens, because the question is "where is v2 still live" and the
-- answer spans a campaign, a page, a magnet and an agent at once.
create or replace view offer_version_usage with (security_invoker = true) as
-- The campaign's own selected version.
select
  c.client_id,
  v.offer_id,
  c.offer_version_id as offer_version_id,
  v.version,
  'campaign'::text as surface,
  c.id as record_id,
  c.name as label,
  null::boolean as live,
  'A v6 campaign''s live state is gated elsewhere, so this view does not claim it.'::text as live_note
from public.client_campaigns c
join public.service_offer_versions v on v.id = c.offer_version_id
where c.offer_version_id is not null and c.archived_at is null

union all

-- The immutable version frozen into a package.
select
  o.client_id, v.offer_id, o.offer_version_id, v.version,
  'package', o.manifest_id, 'Package v' || m.version::text,
  null::boolean, 'A frozen package input, not a live surface.'
from public.campaign_manifest_offers o
join public.service_offer_versions v on v.id = o.offer_version_id
join public.campaign_manifest_versions m on m.id = o.manifest_id

union all

-- A lead magnet, which is live when its version has a standing approval.
select
  m.client_id, v.offer_id, m.offer_version_id, v.version,
  'lead_magnet', m.id, m.name,
  exists (
    select 1 from public.lead_magnet_versions mv
    join public.lead_magnet_approvals a
      on a.magnet_version_id = mv.id and a.status = 'approved'
    where mv.magnet_id = m.id),
  'Live when a version of the magnet has a standing approval.'
from public.lead_magnets m
join public.service_offer_versions v on v.id = m.offer_version_id
where m.offer_version_id is not null and m.archived_at is null

union all

-- A campaign page, which is live when a commit exists for it.
select
  a.client_id, v.offer_id, c.offer_version_id, v.version,
  'campaign_page', a.page_id, coalesce(p.title, 'A campaign page'),
  exists (select 1 from public.campaign_page_publications pub where pub.page_id = a.page_id),
  'Live when an approved publication has committed it.'
from public.campaign_artifacts a
join public.client_campaigns c on c.id = a.campaign_id
join public.service_offer_versions v on v.id = c.offer_version_id
left join public.client_pages p on p.id = a.page_id
where a.kind = 'landing_page' and a.page_id is not null
  and c.offer_version_id is not null and c.archived_at is null;

comment on view offer_version_usage is
  'Every surface carrying an offer version, across campaigns, packages, magnets and pages. The join nobody could make before, which is why a repriced offer could leave a live asset quoting the old figure.';

grant select on offer_version_usage to authenticated;

-- ---------------------------------------------------------------------------
-- The row that earns the tab
-- ---------------------------------------------------------------------------

create or replace view offer_version_drift with (security_invoker = true) as
select
  u.client_id,
  u.offer_id,
  o.service_name,
  u.offer_version_id,
  u.version,
  cur.current_version,
  u.surface,
  u.record_id,
  u.label,
  u.live,
  u.live_note,
  (cur.current_version is not null and u.version < cur.current_version) as superseded,
  case
    when cur.current_version is null
      then 'No version of this offer has been signed off, so nothing here is approved copy.'
    when u.version < cur.current_version and u.live is true
      then 'Carrying v' || u.version::text || ' while v' || cur.current_version::text
           || ' is current, and it is live.'
    when u.version < cur.current_version
      then 'Carrying v' || u.version::text || ' while v' || cur.current_version::text || ' is current.'
    else null
  end as drift
from offer_version_usage u
join public.service_offers o on o.id = u.offer_id
left join offer_current_version cur on cur.offer_id = u.offer_id;

comment on view offer_version_drift is
  'Offer usage with the sentence saying what is out of date. A live surface carrying a superseded version is the expensive case, and it is the one this view puts words to.';

grant select on offer_version_drift to authenticated;

-- ---------------------------------------------------------------------------
-- Claims, and what stands behind each one
-- ---------------------------------------------------------------------------

-- 208 refuses to sign off a quantified claim with no `proof_asset_id`, which
-- is the right gate and leaves no way to read the result. This unpacks the
-- claims array so a person can see each claim beside the proof it rests on,
-- and whether that proof is still usable — because rights expire after a
-- sign-off, and the claim does not know.
create or replace view offer_claim_evidence with (security_invoker = true) as
select
  v.client_id,
  v.offer_id,
  v.id as offer_version_id,
  v.version,
  claim.ordinality as position,
  claim.value->>'kind' as kind,
  claim.value->>'text' as claim_text,
  nullif(claim.value->>'proof_asset_id', '')::uuid as proof_asset_id,
  p.title as proof_title,
  p.usage_rights,
  p.expires_on,
  case
    when claim.value->>'kind' <> 'quantified' then null
    when nullif(claim.value->>'proof_asset_id', '') is null
      then 'A quantified claim with no proof recorded.'
    when p.id is null then 'The proof behind this claim no longer exists.'
    when p.usage_rights <> 'approved' then 'The proof behind this claim is not cleared.'
    when p.expires_on is not null and p.expires_on < current_date
      then 'Permission for the proof behind this claim expired on ' || p.expires_on::text || '.'
    else null
  end as problem
from public.service_offer_versions v
cross join lateral jsonb_array_elements(v.claims) with ordinality as claim(value, ordinality)
left join public.client_proof_assets p
  on p.id = nullif(claim.value->>'proof_asset_id', '')::uuid;

comment on view offer_claim_evidence is
  'Each claim in an offer version beside the proof it rests on, and whether that proof is still usable. Rights expire after a sign-off and the claim does not know.';

grant select on offer_claim_evidence to authenticated;
