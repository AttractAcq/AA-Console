-- Recruitment stays in the AA house account and out of client campaigns.
-- Meta objects are created paused; a person launches them in Ads Manager.
create table recruitment_meta_campaigns (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  daily_budget numeric not null check (daily_budget > 0),
  target_countries text[] not null check (
    cardinality(target_countries) between 1 and 25
    and array_position(target_countries, null) is null
    and array_to_string(target_countries, ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$'
  ),
  conversion_event text not null default 'SUBMIT_APPLICATION',
  meta_campaign_id text,
  meta_ad_set_id text,
  meta_built_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references profiles(id) on delete set null
);
create index recruitment_meta_campaigns_client_date_idx
  on recruitment_meta_campaigns(client_id, created_at desc);
alter table recruitment_meta_campaigns enable row level security;
create policy recruitment_meta_campaigns_admin on recruitment_meta_campaigns
  for all to authenticated using (is_admin()) with check (is_admin());
grant select on recruitment_meta_campaigns to authenticated;

create table recruitment_meta_campaign_ads (
  campaign_id uuid not null references recruitment_meta_campaigns(id) on delete cascade,
  asset_id uuid not null references client_media_assets(id) on delete restrict,
  meta_image_hash text,
  meta_creative_id text,
  meta_ad_id text,
  primary key (campaign_id, asset_id)
);
alter table recruitment_meta_campaign_ads enable row level security;
create policy recruitment_meta_campaign_ads_admin on recruitment_meta_campaign_ads
  for all to authenticated using (is_admin()) with check (is_admin());
grant select on recruitment_meta_campaign_ads to authenticated;

insert into agents (agent_key,name,initials,domain,description,requires_upstream,requires_input)
values ('recruitment_meta_build','Recruitment Meta Builder','RM','conversion',
  'Builds selected AA recruitment images into a paused campaign in the house Meta ad account.',
  '{}',true)
on conflict (agent_key) do nothing;

create function request_recruitment_meta_build(p_campaign_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare c recruitment_meta_campaigns%rowtype; v_job uuid;
begin
  if not is_admin() then raise exception 'Only an admin can distribute recruitment ads.'; end if;
  select * into c from recruitment_meta_campaigns where id=p_campaign_id for update;
  if not found then raise exception 'That recruitment campaign no longer exists.'; end if;
  if c.client_id is distinct from aa_house_client_id() or not can_access_client(c.client_id) then
    raise exception 'Recruitment must use the AA house account.';
  end if;
  if exists (select 1 from agent_jobs j
    where j.agent_key='recruitment_meta_build' and j.input_table='recruitment_meta_campaigns'
      and j.input_id=c.id and j.status in ('queued','claimed','running')) then
    raise exception 'A recruitment Meta build is already queued or running.';
  end if;
  v_job := enqueue_agent_job_internal('recruitment_meta_build',c.client_id,
    'recruitment_meta_campaigns',c.id,auth.uid(),'{}'::jsonb,
    'Queued: build selected recruitment ads in Meta, paused');
  return v_job;
end;
$$;
revoke execute on function request_recruitment_meta_build(uuid) from public,anon;
grant execute on function request_recruitment_meta_build(uuid) to authenticated;

create function create_recruitment_meta_campaign(
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
  if p_asset_ids is null or cardinality(p_asset_ids) = 0 or cardinality(p_asset_ids) > 20 then
    raise exception 'Select between 1 and 20 recruitment ads.';
  end if;
  select count(distinct a.id)::integer into v_count
    from client_media_assets a
    join client_briefs b on b.id=a.brief_id and b.client_id=a.client_id
   where a.id = any(p_asset_ids) and a.client_id=v_house
     and a.purpose='recruitment' and b.purpose='recruitment'
     and a.review_status='approved' and a.media_type='image'
     and a.content_format is distinct from 'carousel'
     and nullif(btrim(a.storage_path),'') is not null
     and nullif(btrim(b.hook),'') is not null
     and nullif(btrim(b.script),'') is not null
     and b.call_to_action in ('APPLY_NOW','LEARN_MORE','SIGN_UP','CONTACT_US')
     and b.apply_url ~ '^https://';
  if v_count <> cardinality(p_asset_ids) then
    raise exception 'Select distinct approved AA recruitment images with complete ad copy and an HTTPS apply URL.';
  end if;
  insert into recruitment_meta_campaigns(client_id,name,daily_budget,target_countries,created_by)
  values(v_house,btrim(p_name),p_daily_budget,p_target_countries,auth.uid()) returning id into v_id;
  insert into recruitment_meta_campaign_ads(campaign_id,asset_id)
  select v_id,unnest(p_asset_ids);
  perform request_recruitment_meta_build(v_id);
  return v_id;
end;
$$;
revoke execute on function create_recruitment_meta_campaign(text,numeric,text[],uuid[]) from public,anon;
grant execute on function create_recruitment_meta_campaign(text,numeric,text[],uuid[]) to authenticated;

-- A selected image is part of the recorded Meta build. Keep its source and
-- brief available for retries, and give a clear refusal instead of an FK error.
create or replace function delete_recruitment_ad(p_brief_id uuid)
returns table (deleted_assets integer)
language plpgsql security definer set search_path = public as $$
declare v_brief client_briefs%rowtype; v_count integer;
begin
  if not is_admin() then raise exception 'Only an admin can delete a recruitment ad.'; end if;
  select * into v_brief from client_briefs where id=p_brief_id for update;
  if not found then raise exception 'That ad no longer exists.'; end if;
  if v_brief.purpose <> 'recruitment' then raise exception 'That is not a recruitment ad.'; end if;
  if exists (
    select 1 from recruitment_meta_campaign_ads selected
    join client_media_assets asset on asset.id=selected.asset_id
    where asset.brief_id=p_brief_id
  ) then
    raise exception 'This recruitment ad is selected for an Ads Manager campaign and cannot be deleted here.';
  end if;
  delete from client_media_assets where brief_id=p_brief_id;
  get diagnostics v_count = row_count;
  delete from client_briefs where id=p_brief_id;
  deleted_assets := v_count;
  return next;
end;
$$;
revoke execute on function delete_recruitment_ad(uuid) from public,anon;
grant execute on function delete_recruitment_ad(uuid) to authenticated,service_role;
