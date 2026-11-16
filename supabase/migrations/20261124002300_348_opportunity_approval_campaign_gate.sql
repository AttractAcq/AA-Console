-- Recheck the exact opportunity decision before returning an existing campaign
-- or creating a new one. The link trigger also guards direct inserts.
begin;
create or replace function public.create_campaign_from_opportunity_v6(
  p_opportunity_id uuid,
  p_acquisition_mode text,
  p_paid_platform text default null,
  p_name text default null
) returns public.client_campaigns
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_opportunity public.market_opportunities%rowtype;
  v_readiness record;
  v_offer_version uuid;
  v_existing public.client_campaigns%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_organic boolean;
  v_paid boolean;
begin
  select * into v_opportunity from public.market_opportunities where id = p_opportunity_id;
  if not found then raise exception 'No such opportunity.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.can_shape_opportunity(v_opportunity.client_id) then
    raise exception 'Only an admin or assigned client manager can create a campaign from an opportunity.'
      using errcode = 'P0001';
  end if;

  if p_acquisition_mode not in ('organic', 'paid', 'both') then
    raise exception 'Choose an organic, paid, or both route.' using errcode = 'P0001';
  end if;
  v_organic := p_acquisition_mode in ('organic', 'both');
  v_paid := p_acquisition_mode in ('paid', 'both');
  if v_paid and coalesce(p_paid_platform, '') not in ('meta', 'google') then
    raise exception 'Choose Meta Ads or Google Ads for a paid campaign.' using errcode = 'P0001';
  end if;

  -- Approved onwards. Everything before that is still being worked out, and
  -- a campaign against it is money spent on a maybe.
  if v_opportunity.status not in ('approved', 'active', 'learning', 'scaling') then
    raise exception 'This opportunity is %. Approve it before building a campaign on it.',
      v_opportunity.status using errcode = 'P0001';
  end if;

  if not public.opportunity_approval_current_v6(p_opportunity_id) then
    raise exception 'This opportunity needs a current exact Inbox approval before campaign planning.'
      using errcode = '23514';
  end if;

  -- Readiness read now, not trusted from whenever the approval happened.
  select * into v_readiness from public.opportunity_readiness
   where opportunity_id = p_opportunity_id;
  if v_readiness.blocker is not null then
    raise exception '%', v_readiness.blocker using errcode = 'P0001';
  end if;

  -- One campaign per opportunity per route combination. 'both' is its own
  -- combination, so it does not collide with an existing organic or paid one.
  select c.* into v_existing
    from public.client_campaigns c
    join public.opportunity_links l on l.campaign_id = c.id
   where l.opportunity_id = p_opportunity_id
     and l.role = 'campaign'
     and c.acquisition_mode = p_acquisition_mode
     and coalesce(c.paid_platform, '') = coalesce(p_paid_platform, '')
   order by c.created_at
   limit 1;
  if found then
    return v_existing;
  end if;

  select v.id into v_offer_version
    from public.opportunity_links l
    join public.service_offer_versions v
      on v.offer_id = l.offer_id and v.client_id = l.client_id
    join public.service_offer_signoffs s
      on s.offer_version_id = v.id and s.client_id = v.client_id
   where l.opportunity_id = p_opportunity_id and l.role = 'offer'
   order by v.version desc
   limit 1;

  insert into public.client_campaigns (
    client_id, name, brief, acquisition_mode, paid_platform,
    runs_organic, runs_paid, offer_version_id)
  values (
    v_opportunity.client_id,
    coalesce(nullif(btrim(coalesce(p_name, '')), ''), v_opportunity.name),
    public.opportunity_brief_v6(p_opportunity_id),
    p_acquisition_mode,
    case when v_paid then p_paid_platform end,
    v_organic, v_paid,
    v_offer_version)
  returning * into v_campaign;

  -- Both directions, unchanged: the link table is the relational record and
  -- the event is what makes "why does this campaign exist" answerable from
  -- the opportunity's own history.
  insert into public.opportunity_links (opportunity_id, client_id, role, campaign_id)
  values (p_opportunity_id, v_opportunity.client_id, 'campaign', v_campaign.id)
  on conflict do nothing;

  insert into public.opportunity_events (opportunity_id, client_id, event, actor, detail)
  values (p_opportunity_id, v_opportunity.client_id, 'linked',
          case when coalesce(auth.role(), '') = 'service_role' then 'agent' else 'human' end,
          'Campaign created: ' || v_campaign.name || ' (' || p_acquisition_mode
            || coalesce(' ' || p_paid_platform, '') || ').');

  return v_campaign;
end $$;

create view public.opportunity_approval_state_v6 with (security_invoker = true) as
select o.id as opportunity_id,o.client_id,
  public.opportunity_approval_current_v6(o.id) as approval_current,
  case when o.approved_request_id is null and o.status in ('approved','active','learning','scaling')
    then 'legacy' when o.approved_request_id is not null and
      not public.opportunity_approval_current_v6(o.id) then 'stale'
    when public.opportunity_approval_current_v6(o.id) then 'current'
    else 'not_approved' end as approval_state
from public.market_opportunities o;
revoke all on public.opportunity_approval_state_v6 from public,anon,authenticated,service_role;
grant select on public.opportunity_approval_state_v6 to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
    decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (13,2,'opportunity_approve','Market opportunity approval',
  'verified','344 exact evaluated opportunity, score, linked intelligence and proof snapshot with request epoch',
  'verified','346 AAL2 source-owned Inbox decision and direct status guard',
  'blocked','346 campaign link guard and 347 campaign creator recheck; local rollback-only fixture',
  'Pre-bridge approved opportunities need review; no live planned campaign has been attested against this path.');
select public.lock_down_definer_functions();
commit;
