-- v6.1 / 2.6: a paid-and-organic campaign plans each route's volume.
--
-- The notes ask the planner to decide "organic volume and type, paid volume and
-- type". It decides one volume: client_campaigns.content_count. For a campaign
-- running a single route that is the answer. For a 'both' campaign -- the route
-- migration 302 added -- it is the total with no statement about the split, so
-- "twelve pieces" could mean twelve organic and no ads, and readiness could not
-- tell the difference.
--
-- WHY A NARROW SETTER RATHER THAN THE PLAN JSONB
--
-- The planner persists its whole plan as jsonb through save_campaign_plan_only
-- and save_campaign_plan_with_ideas, which read the keys they know and write
-- the columns. Adding two keys there means reproducing both bodies -- one of
-- them 7.5KB -- to change four lines, and every future reader of this migration
-- would have to diff two large functions to find what moved.
--
-- So this is a narrow writer instead, the same shape as 304, 306 and 307: one
-- named thing, validated arguments. The planner calls it after the plan is
-- saved, because the split is only meaningful once content_count exists to
-- split.
--
-- THE SPLIT IS CHECKED AGAINST THE ROUTE, NOT JUST SUMMED
--
-- A campaign that does not run paid cannot plan paid pieces, and the constraint
-- says so per mode rather than only checking the total. 'legacy' is exempt:
-- all 20 existing campaigns are legacy with content_count between 9 and 28, and
-- a constraint that made the live table invalid would be a migration that
-- cannot be applied.
--
-- Every column in the predicate is NOT NULL, so it cannot evaluate to NULL and
-- pass by accident. That is the hole 302 left in its own route CHECK --
-- `paid_platform in (...)` is NULL rather than false when the column is null,
-- and a CHECK only rejects on false -- and it is worth not repeating.

alter table public.client_campaigns
  add column if not exists organic_content_count integer not null default 0,
  add column if not exists paid_content_count integer not null default 0;

comment on column public.client_campaigns.organic_content_count is
  'How many of content_count are organic pieces. Meaningful for a both-route campaign; equals content_count for an organic one and 0 for a paid one.';
comment on column public.client_campaigns.paid_content_count is
  'How many of content_count are paid pieces. Meaningful for a both-route campaign; equals content_count for a paid one and 0 for an organic one.';

alter table public.client_campaigns
  drop constraint if exists client_campaigns_route_volume_check;
-- THE CONSTRAINT FORBIDS NONSENSE; THE FUNCTION REQUIRES EXACTNESS.
--
-- It deliberately does NOT demand that the split equal content_count, and a
-- test caught why. The planner saves its plan -- which sets content_count --
-- and then records the split, because a total has to exist before it can be
-- divided. An equality constraint rejects the FIRST of those two statements:
-- for a moment the row says twelve pieces with a nought/nought split, and
-- there is no ordering of two statements that avoids it. CHECK constraints
-- cannot be deferred in Postgres, so this is not a timing detail to work
-- around.
--
-- So the constraint rules out what is never acceptable at any instant --
-- negative counts, pieces on a route the campaign does not run, a split
-- larger than the plan -- and set_campaign_route_volumes_v6 below enforces the
-- exact split, both halves non-zero, in one statement.
--
-- A both-route campaign can therefore sit planned-but-unsplit. That is honest
-- rather than a gap: it is the state between the two writes, and anything
-- reading these columns should treat a nought on a route the campaign runs as
-- "not planned yet" rather than "nothing planned".
alter table public.client_campaigns
  add constraint client_campaigns_route_volume_check check (
    organic_content_count >= 0
    and paid_content_count >= 0
    and organic_content_count + paid_content_count <= content_count
    and (runs_organic or organic_content_count = 0)
    and (runs_paid or paid_content_count = 0)
  );

create or replace function public.set_campaign_route_volumes_v6(
  p_campaign_id uuid,
  p_organic integer,
  p_paid integer
) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_campaign public.client_campaigns%rowtype;
begin
  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  if v_campaign.id is null then
    raise exception 'No such campaign.' using errcode = 'P0001';
  end if;
  -- service_role is the planner. A person adjusting the split goes through the
  -- same standing the rest of a campaign's shape needs.
  if auth.role() is distinct from 'service_role'
     and not public.can_access_client(v_campaign.client_id) then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;
  if p_organic is null or p_paid is null or p_organic < 0 or p_paid < 0 then
    raise exception 'A route volume is a whole number of pieces, or none.'
      using errcode = 'P0001';
  end if;

  -- Each refusal names the number it disagreed with, because "invalid split" in
  -- a job failure tells whoever reads it nothing about which half was wrong.
  if v_campaign.acquisition_mode = 'legacy' then
    raise exception 'A legacy campaign has no route split to set.' using errcode = 'P0001';
  end if;
  if p_organic + p_paid <> v_campaign.content_count then
    raise exception 'The split is % organic plus % paid, which is %, but this campaign plans % pieces.',
      p_organic, p_paid, p_organic + p_paid, v_campaign.content_count
      using errcode = 'P0001';
  end if;
  if not v_campaign.runs_organic and p_organic > 0 then
    raise exception 'This campaign does not run organic, so it cannot plan % organic pieces.', p_organic
      using errcode = 'P0001';
  end if;
  if not v_campaign.runs_paid and p_paid > 0 then
    raise exception 'This campaign does not run paid, so it cannot plan % paid pieces.', p_paid
      using errcode = 'P0001';
  end if;
  -- A both-route campaign that plans nothing for one of its routes is not
  -- running both routes, whatever its flags say. Caught here rather than left
  -- for readiness to report as a campaign that is somehow ready with half its
  -- work missing.
  if v_campaign.acquisition_mode = 'both' and (p_organic = 0 or p_paid = 0) then
    raise exception 'A paid-and-organic campaign needs pieces on both routes; this plans % organic and % paid.',
      p_organic, p_paid
      using errcode = 'P0001';
  end if;

  update public.client_campaigns
     set organic_content_count = p_organic,
         paid_content_count = p_paid,
         updated_at = now()
   where id = p_campaign_id;
end $$;

comment on function public.set_campaign_route_volumes_v6(uuid, integer, integer) is
  'Records how a campaign''s planned content_count divides between its organic and paid routes. Narrow by design: the planner calls it after the plan is saved, and the generic plan writers are untouched.';

revoke all on function public.set_campaign_route_volumes_v6(uuid, integer, integer)
  from public, anon;
grant execute on function public.set_campaign_route_volumes_v6(uuid, integer, integer)
  to authenticated, service_role;

select lock_down_definer_functions();
