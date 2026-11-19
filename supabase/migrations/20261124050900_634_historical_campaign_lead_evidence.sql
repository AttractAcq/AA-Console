-- Retain a campaign's recorded lead evidence after a finished lead leaves the
-- operating pipeline. This is a count-only read with the same client lead
-- entitlement as the old security-invoker lead subquery.
begin;
create function public.campaign_recorded_lead_count_v11(
  p_client_id uuid,p_campaign_id uuid)
returns bigint language plpgsql stable security definer
set search_path=pg_catalog,public as $$
begin
  if public.may_manage_client_leads(p_client_id) is not true then
    return 0;
  end if;
  if not exists (select 1 from public.client_campaigns c
      where c.id=p_campaign_id and c.client_id=p_client_id) then
    return 0;
  end if;
  return (select count(*) from public.reporting_lead_rows_v10(p_client_id) l
    where l.source_client_campaign_id=p_campaign_id
      and not coalesce(l.is_probe,false));
end $$;
revoke all on function public.campaign_recorded_lead_count_v11(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.campaign_recorded_lead_count_v11(uuid,uuid)
  to authenticated,service_role;
comment on function public.campaign_recorded_lead_count_v11(uuid,uuid) is
  'Client-authorized count of non-probe first-source campaign leads across current and archived snapshots. Returns zero without lead entitlement and does not infer provider execution or causation.';

create or replace view public.campaign_live_evidence
with (security_invoker=true) as
 SELECT id AS campaign_id,
    client_id,
    acquisition_mode,
    paid_platform,
    ad_campaign_id,
    meta_campaign_id,
    ( SELECT count(*) AS count
           FROM scheduled_posts sp
             JOIN client_media_assets ma ON ma.id = sp.asset_id
             JOIN client_briefs b ON b.id = ma.brief_id
             JOIN client_ideas i ON i.id = b.source_idea_id
          WHERE i.campaign_id = c.id AND sp.published_at IS NOT NULL) AS posts_published,
    ad_campaign_id IS NOT NULL OR meta_campaign_id IS NOT NULL AS spend_bindable,
    ( SELECT COALESCE(sum(md.spend), 0::numeric) AS "coalesce"
           FROM metrics_daily md
          WHERE md.client_id = c.client_id AND (c.ad_campaign_id IS NOT NULL AND md.campaign_id = c.ad_campaign_id OR c.meta_campaign_id IS NOT NULL AND md.entity_type = 'campaign'::metric_entity AND md.external_id = c.meta_campaign_id)) AS spend_observed,
    ( SELECT count(DISTINCT md.metric_date) AS count
           FROM metrics_daily md
          WHERE md.client_id = c.client_id AND COALESCE(md.spend, 0::numeric) > 0::numeric AND (c.ad_campaign_id IS NOT NULL AND md.campaign_id = c.ad_campaign_id OR c.meta_campaign_id IS NOT NULL AND md.entity_type = 'campaign'::metric_entity AND md.external_id = c.meta_campaign_id)) AS spending_days,
    ( SELECT count(*) AS count
           FROM campaign_page_publications p
             JOIN campaign_action_approvals pa ON pa.id = p.approval_id
          WHERE pa.campaign_id = c.id) AS pages_published,
    ( SELECT count(*) AS count
           FROM campaign_page_publications p
             JOIN campaign_action_approvals pa ON pa.id = p.approval_id
          WHERE pa.campaign_id = c.id AND p.probe_status = 'passed'::text AND p.probe_kind = 'browser_form'::text) AS pages_probed,
    ( SELECT count(*) AS count
           FROM proof_placements pp
          WHERE pp.campaign_id = c.id AND (pp.status = ANY (ARRAY['placed'::text, 'verified'::text]))) AS proof_placed,
    public.campaign_recorded_lead_count_v11(c.client_id,c.id) AS leads_attributed
   FROM client_campaigns c
  WHERE archived_at IS NULL;

comment on view public.campaign_live_evidence is
  'Recorded campaign activity with first-source non-probe lead count retained after archive. Posts, spend, pages and proof remain separate observations; this view does not certify provider execution.';
grant select on public.campaign_live_evidence to authenticated;
select public.lock_down_definer_functions();
commit;
