-- The planner caps its generated batch at 30, but operators may add manual
-- ideas to a built campaign afterward. Keep a positive, unique position for
-- each idea without imposing the planner's batch limit on manual additions.
alter table client_ideas
  drop constraint client_ideas_campaign_position_pair;

-- The old CHECK allowed NULL positions through SQL's unknown result. Give
-- any such legacy rows stable positions before requiring the pair explicitly.
update client_ideas
   set campaign_position = null
 where campaign_id is null and campaign_position is not null;

with missing as (
  select id, campaign_id,
         row_number() over (partition by campaign_id order by created_at, id) as row_offset
    from client_ideas
   where campaign_id is not null and campaign_position is null
), last_position as (
  select campaign_id, coalesce(max(campaign_position), 0) as value
    from client_ideas
   where campaign_id is not null
   group by campaign_id
)
update client_ideas as idea
   set campaign_position = last_position.value + missing.row_offset
  from missing
  join last_position on last_position.campaign_id = missing.campaign_id
 where idea.id = missing.id;

alter table client_ideas
  add constraint client_ideas_campaign_position_pair
  check (
    (campaign_id is null and campaign_position is null)
    or (campaign_id is not null and campaign_position is not null and campaign_position > 0)
  );
