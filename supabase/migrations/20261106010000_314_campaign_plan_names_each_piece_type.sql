-- Phase C: the approved plan names every piece's route and production shape.
-- Null is preserved for historical plans; a v6 plan cannot receive a new
-- approval until its mix is populated and agrees with its route volumes.
alter table public.client_campaigns
  add column if not exists content_pieces jsonb;

comment on column public.client_campaigns.content_pieces is
  'Ordered v6 content slots: acquisition_route, media_type and content_format for each planned piece. Included in the approval fingerprint.';

create or replace function public.campaign_content_pieces_valid(
  p_campaign public.client_campaigns
) returns boolean
language sql stable
set search_path = pg_catalog, public
as $$
  select case
    when p_campaign.acquisition_mode = 'legacy' then true
    when p_campaign.content_pieces is null
      or jsonb_typeof(p_campaign.content_pieces) <> 'array' then false
    when jsonb_array_length(p_campaign.content_pieces) <> p_campaign.content_count then false
    else (
      select count(*) filter (where piece->>'acquisition_route' = 'organic') = p_campaign.organic_content_count
         and count(*) filter (where piece->>'acquisition_route' = 'paid') = p_campaign.paid_content_count
         and count(*) = count(*) filter (where
           jsonb_typeof(piece) = 'object'
           and piece->>'acquisition_route' in ('organic', 'paid')
           and (
             (piece->>'content_format' = 'single' and piece->>'media_type' in ('image', 'text', 'video'))
             or (piece->>'content_format' = 'carousel' and piece->>'media_type' = 'image')
             or (piece->>'content_format' = 'story' and piece->>'media_type' in ('image', 'video'))
             or (piece->>'content_format' = 'reel' and piece->>'media_type' = 'video')
           ))
      from jsonb_array_elements(p_campaign.content_pieces) as piece
    )
  end
$$;

create or replace function public.set_campaign_content_pieces_v6(
  p_campaign_id uuid,
  p_pieces jsonb
) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  c public.client_campaigns%rowtype;
begin
  select * into c from public.client_campaigns where id = p_campaign_id for update;
  if c.id is null then
    raise exception 'No such campaign.' using errcode = 'P0001';
  end if;
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the campaign planner can set the piece mix.' using errcode = '42501';
  end if;
  if c.acquisition_mode = 'legacy' then
    raise exception 'Legacy campaigns have no v6 piece mix.' using errcode = 'P0001';
  end if;
  c.content_pieces := p_pieces;
  if not public.campaign_content_pieces_valid(c) then
    raise exception 'The planned piece types must match the content count and route volumes.' using errcode = 'P0001';
  end if;
  update public.client_campaigns
     set content_pieces = p_pieces,
         updated_at = now()
   where id = p_campaign_id;
end $$;

revoke all on function public.set_campaign_content_pieces_v6(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_campaign_content_pieces_v6(uuid, jsonb) to service_role;

-- Save, route split and piece mix are one transaction. The legacy plan writers
-- set built_at; a worker crash between separate RPCs would otherwise let its
-- recovery path finalize a built plan with no approved mix.
create or replace function public.save_campaign_plan_v6(
  p_campaign_id uuid,
  p_client_id uuid,
  p_job_id uuid,
  p_plan jsonb,
  p_ideas jsonb,
  p_organic integer,
  p_paid integer,
  p_pieces jsonb
) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  c public.client_campaigns%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the agent runtime may save a v6 campaign plan.' using errcode = '42501';
  end if;
  select * into c from public.client_campaigns
   where id = p_campaign_id and client_id = p_client_id for update;
  if c.id is null then
    raise exception 'That campaign no longer exists.' using errcode = 'P0001';
  end if;
  if c.built_at is not null then
    raise exception 'This campaign already has a plan; a revision needs its own campaign.' using errcode = 'P0001';
  end if;
  if p_ideas is null then
    perform public.save_campaign_plan_only(p_campaign_id, p_client_id, p_job_id, p_plan);
  else
    perform public.save_campaign_plan_with_ideas(p_campaign_id, p_client_id, p_job_id, p_plan, p_ideas);
  end if;
  perform public.set_campaign_route_volumes_v6(p_campaign_id, p_organic, p_paid);
  perform public.set_campaign_content_pieces_v6(p_campaign_id, p_pieces);
end $$;

revoke all on function public.save_campaign_plan_v6(uuid, uuid, uuid, jsonb, jsonb, integer, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_campaign_plan_v6(uuid, uuid, uuid, jsonb, jsonb, integer, integer, jsonb)
  to service_role;

-- Migration 309's fingerprint, with the reviewed piece list included.
create or replace function public.campaign_plan_fingerprint(
  p_campaign public.client_campaigns
) returns text
language sql immutable
set search_path = pg_catalog, public
as $$
  select md5(jsonb_build_object(
    'objective', p_campaign.objective,
    'audience', p_campaign.audience,
    'offer_summary', p_campaign.offer_summary,
    'core_message', p_campaign.core_message,
    'channels', to_jsonb(coalesce(p_campaign.channels, array[]::text[])),
    'budget', p_campaign.budget,
    'starts_on', p_campaign.starts_on,
    'ends_on', p_campaign.ends_on,
    'kpi_metric', p_campaign.kpi_metric,
    'kpi_target', p_campaign.kpi_target,
    'content_count', p_campaign.content_count,
    'organic_content_count', p_campaign.organic_content_count,
    'paid_content_count', p_campaign.paid_content_count,
    'content_pieces', p_campaign.content_pieces,
    'needs_landing_page', p_campaign.needs_landing_page,
    'needs_sales_agent', p_campaign.needs_sales_agent,
    'offer_version_id', p_campaign.offer_version_id
  )::text)
$$;

create or replace function public.check_campaign_piece_approval()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.plan_approved_at is not null
     and new.plan_approved_fingerprint = public.campaign_plan_fingerprint(new)
     and not public.campaign_content_pieces_valid(new) then
    raise exception 'Review a plan with a valid type and route for every piece before approving it.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger check_campaign_piece_approval
  before update of plan_approved_at, plan_approved_fingerprint on public.client_campaigns
  for each row execute function public.check_campaign_piece_approval();

select lock_down_definer_functions();
