-- A recruitment campaign may select only current exact Inbox-cleared image
-- and brief versions. Historical review_status alone is not authority.
begin;
create function public.recruitment_brief_signoff_current_v6(p_brief_id uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public set timezone='UTC' as $$
declare b public.client_briefs%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if auth.role() not in ('authenticated','service_role') then return false; end if;
  select * into b from public.client_briefs where id=p_brief_id;
  if b.id is null or b.purpose<>'recruitment'
    or b.status not in ('approved','in_production','complete')
    or (auth.role()='authenticated'
      and not public.can_access_client(b.client_id)) then return false; end if;
  h:=public.recruitment_brief_snapshot_hash_v6(b);
  select * into r from public.approval_requests_v6
    where client_id=b.client_id and source_system='aa_console'
      and source_kind='recruitment_brief' and source_id=b.id::text
      and artifact_hash=h and preview=public.recruitment_brief_snapshot_v6(b)
    order by requested_at desc,id desc limit 1;
  if r.id is null or r.preview_blocker is not null
    or exists(select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id=r.id) then return false; end if;
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  return d.decision='approved' and d.actor_aal='aal2'
    and d.artifact_hash=h and d.source_decision_ref=
      'client_briefs:'||b.id::text||':approved';
end $$;
revoke all on function public.recruitment_brief_signoff_current_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.recruitment_brief_signoff_current_v6(uuid)
  to authenticated,service_role;

create function public.recruitment_media_current_v6(p_asset_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select exists(select 1 from public.client_media_assets a
    join public.client_briefs b on b.id=a.brief_id and b.client_id=a.client_id
    where a.id=p_asset_id and a.purpose='recruitment'
      and b.purpose='recruitment' and a.media_type='image'
      and a.content_format='single' and a.archived_at is null
      and public.ordinary_media_signoff_current_v6(a.id)
      and public.recruitment_brief_signoff_current_v6(b.id));
$$;
revoke all on function public.recruitment_media_current_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.recruitment_media_current_v6(uuid)
  to authenticated,service_role;

create view public.recruitment_media_ready_v6 with (security_invoker=true) as
select a.id,a.client_id,a.brief_id,a.title,a.storage_path,
  a.media_type,a.content_format
from public.client_media_assets a
where a.purpose='recruitment' and public.recruitment_media_current_v6(a.id);
revoke all on public.recruitment_media_ready_v6
  from public,anon,authenticated,service_role;
grant select on public.recruitment_media_ready_v6 to authenticated,service_role;

create or replace function public.create_recruitment_meta_campaign(
  p_name text, p_daily_budget numeric, p_target_countries text[], p_asset_ids uuid[]
)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_house uuid; v_id uuid; v_count integer;
begin
  if not is_admin() then raise exception 'Only an admin can distribute recruitment ads.'; end if;
  v_house := aa_house_client_id();
  if v_house is null or not can_access_client(v_house) then
    raise exception 'The AA house client is not available.';
  end if;
  if nullif(btrim(p_name),'') is null or length(btrim(p_name)) > 160 then
    raise exception 'Name this recruitment campaign.';
  end if;
  if p_daily_budget is null or p_daily_budget <= 0 then
    raise exception 'Set a positive daily budget.';
  end if;
  if p_target_countries is null or cardinality(p_target_countries) = 0
     or cardinality(p_target_countries) > 25
     or array_position(p_target_countries, null) is not null
     or array_to_string(p_target_countries, ',') !~ '^[A-Z]{2}(,[A-Z]{2})*$' then
    raise exception 'Choose valid two-letter countries.';
  end if;
  if p_asset_ids is null or cardinality(p_asset_ids) = 0
     or cardinality(p_asset_ids) > 20 then
    raise exception 'Select between 1 and 20 recruitment ads.';
  end if;
  select count(distinct a.id)::integer into v_count
    from public.client_media_assets a
    join public.client_briefs b on b.id=a.brief_id and b.client_id=a.client_id
   where a.id=any(p_asset_ids) and a.client_id=v_house
     and public.recruitment_media_current_v6(a.id)
     and nullif(btrim(b.hook),'') is not null
     and nullif(btrim(b.script),'') is not null
     and b.call_to_action in ('APPLY_NOW','LEARN_MORE','SIGN_UP','CONTACT_US')
     and b.apply_url ~ '^https://';
  if v_count<>cardinality(p_asset_ids) then
    raise exception 'Select distinct current Inbox-cleared AA recruitment images and briefs with complete ad copy.';
  end if;
  insert into public.recruitment_meta_campaigns(client_id,name,daily_budget,target_countries,created_by)
  values(v_house,btrim(p_name),p_daily_budget,p_target_countries,auth.uid()) returning id into v_id;
  insert into public.recruitment_meta_campaign_ads(campaign_id,asset_id)
  select v_id,unnest(p_asset_ids);
  perform public.request_recruitment_meta_build(v_id);
  return v_id;
end $$;
revoke all on function public.create_recruitment_meta_campaign(text,numeric,text[],uuid[])
  from public,anon,service_role;
grant execute on function public.create_recruitment_meta_campaign(text,numeric,text[],uuid[])
  to authenticated;
select public.lock_down_definer_functions();
commit;
