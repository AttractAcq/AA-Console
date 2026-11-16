-- The existing deploy worker posts directly to the public capture endpoint.
-- That proves an endpoint can create a lead, but it does not exercise a form
-- in the published page. Preserve the evidence while withholding the claim
-- that a visitor's page form has been tested in a browser.
alter table public.campaign_page_publications
  add column probe_kind text not null default 'endpoint'
    check (probe_kind in ('endpoint','browser_form'));

create or replace function public.record_campaign_page_probe_v6(
  p_publication_id uuid, p_passed boolean, p_detail text,
  p_lead_id uuid default null)
returns void language plpgsql security definer
set search_path=pg_catalog,public as $$
declare p public.campaign_page_publications%rowtype;
  a public.campaign_action_approvals%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service may record a probe.' using errcode='42501';
  end if;
  select * into p from public.campaign_page_publications
    where id=p_publication_id for update;
  if not found then raise exception 'No such publication.'; end if;
  select * into a from public.campaign_action_approvals where id=p.approval_id;
  if nullif(btrim(coalesce(p_detail,'')),'') is null then
    raise exception 'Record what the endpoint probe observed.';
  end if;
  if p.probe_kind='browser_form' then
    raise exception 'An endpoint probe cannot replace browser-form evidence.';
  end if;
  if coalesce(p_passed,false) then
    if p_lead_id is null or not exists (
      select 1 from public.client_leads l
      join public.lead_submissions s on s.lead_id=l.id
      join public.lead_capture_endpoints ep on ep.id=s.endpoint_id
      where l.id=p_lead_id and l.client_id=p.client_id
        and l.is_probe and l.source_client_campaign_id=a.campaign_id
        and l.source_page_id=p.page_id
        and l.consent_given_at is not null
        and nullif(btrim(l.consent_wording),'') is not null
        and nullif(btrim(l.source_channel),'') is not null
        and s.client_id=p.client_id and s.status='promoted'
        and s.consent_given_at is not null and s.created_at>=p.published_at
        and ep.client_id=p.client_id and ep.campaign_id=a.campaign_id
        and ep.page_id=p.page_id and ep.purpose='page_form'
    ) then
      raise exception 'A passed endpoint probe needs a same-page, same-campaign consented probe submission in Sales OS.';
    end if;
  elsif p_lead_id is not null and not exists (
    select 1 from public.client_leads l where l.id=p_lead_id and l.client_id=p.client_id
  ) then
    raise exception 'A failed probe may only name this client''s lead.';
  end if;
  update public.campaign_page_publications set
    probe_kind='endpoint',
    probe_status=case when coalesce(p_passed,false) then 'passed' else 'failed' end,
    probe_detail=btrim(p_detail), probe_lead_id=p_lead_id, probed_at=now()
  where id=p.id;
end $$;

create or replace view public.campaign_page_publish_due
with (security_invoker=true) as
select
  a.id as approval_id, a.client_id, a.campaign_id,
  s.page_id, s.site_path, s.rendered_sha256,
  p.id as publication_id, p.published_url, p.commit_sha,
  p.probe_status, p.probe_detail,
  case
    when a.status <> 'approved' then 'This page deployment is ' || a.status || '.'
    when exists (select 1 from public.campaign_manifest_versions v
      where v.campaign_id=a.campaign_id and v.version>m.version)
      then 'The campaign package was superseded after this was approved. Request approval again.'
    when pg.html is null or length(btrim(pg.html))=0
      then 'The page has no built HTML.'
    when encode(sha256(convert_to(pg.html,'UTF8')),'hex')<>s.rendered_sha256
      then 'The page changed after it was approved. Request approval of the new version.'
    when not coalesce(ces.campaign_actions_enabled,false)
      then 'External campaign actions are off for this client.'
    when p.id is not null and p.probe_status='failed'
      then 'Published, but the capture endpoint probe failed: ' ||
        coalesce(p.probe_detail,'no detail recorded') || '.'
    when p.id is not null and p.probe_kind='browser_form'
      and p.probe_status='passed' then 'Live and tested.'
    when p.id is not null and p.probe_status='passed'
      then 'Published. Capture endpoint passed; browser form unverified.'
    when p.id is not null then 'Published. Nobody has tested the form yet.'
    else null
  end as blocker
from public.campaign_action_approvals a
join public.campaign_page_approval_snapshots s on s.approval_id=a.id
join public.campaign_manifest_versions m on m.id=a.manifest_id
join public.client_pages pg on pg.id=s.page_id
left join public.campaign_page_publications p on p.approval_id=a.id
left join public.client_engine_settings ces on ces.client_id=a.client_id
where a.action_key='page_deploy';

create or replace view public.campaign_live_evidence
with (security_invoker=true) as
select c.id as campaign_id, c.client_id, c.acquisition_mode,
  c.paid_platform, c.ad_campaign_id, c.meta_campaign_id,
  (select count(*) from public.scheduled_posts sp
    join public.client_media_assets ma on ma.id=sp.asset_id
    join public.client_briefs b on b.id=ma.brief_id
    join public.client_ideas i on i.id=b.source_idea_id
    where i.campaign_id=c.id and sp.published_at is not null) as posts_published,
  (c.ad_campaign_id is not null or c.meta_campaign_id is not null) as spend_bindable,
  (select coalesce(sum(md.spend),0) from public.metrics_daily md
    where md.client_id=c.client_id
      and ((c.ad_campaign_id is not null and md.campaign_id=c.ad_campaign_id)
        or (c.meta_campaign_id is not null and md.entity_type='campaign'
          and md.external_id=c.meta_campaign_id))) as spend_observed,
  (select count(distinct md.metric_date) from public.metrics_daily md
    where md.client_id=c.client_id and coalesce(md.spend,0)>0
      and ((c.ad_campaign_id is not null and md.campaign_id=c.ad_campaign_id)
        or (c.meta_campaign_id is not null and md.entity_type='campaign'
          and md.external_id=c.meta_campaign_id))) as spending_days,
  (select count(*) from public.campaign_page_publications p
    join public.campaign_action_approvals pa on pa.id=p.approval_id
    where pa.campaign_id=c.id) as pages_published,
  (select count(*) from public.campaign_page_publications p
    join public.campaign_action_approvals pa on pa.id=p.approval_id
    where pa.campaign_id=c.id and p.probe_status='passed'
      and p.probe_kind='browser_form') as pages_probed,
  (select count(*) from public.proof_placements pp
    where pp.campaign_id=c.id and pp.status in ('placed','verified')) as proof_placed,
  (select count(*) from public.client_leads l
    where l.source_client_campaign_id=c.id and not l.is_probe) as leads_attributed
from public.client_campaigns c where c.archived_at is null;

comment on column public.campaign_page_publications.probe_kind is
  'Endpoint is a direct public capture check. Browser_form requires a later observed submission through the published page; legacy passed probes remain endpoint checks.';
comment on view public.campaign_live_evidence is
  'Published pages and browser-form-verified pages are counted separately. Endpoint-only probes cannot make a page commercially live.';
