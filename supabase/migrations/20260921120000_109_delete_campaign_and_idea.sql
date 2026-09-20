-- Deleting a client campaign, and deleting one idea, from the Console.
--
-- Operators asked for delete, not cancel. client_campaigns.status includes
-- 'cancelled', but that is a status change, not removal — a cancelled plan
-- still sits in the list. Soft-delete (archived_at) exists only on agents;
-- inventing it here would diverge from recruitment, which hard-deletes.
--
-- Pattern A (intentional RPC delete), matching delete_recruitment_ad:
--
--   client_ideas (campaign_id) → client_campaigns ON DELETE CASCADE, and
--   campaign_artifacts / campaign_content_pillars likewise cascade from the
--   campaign. A plain DELETE of the campaign would therefore remove those
--   children. What it would NOT remove is the brief → asset chain owned by
--   those ideas: client_briefs.source_idea_id is ON DELETE SET NULL, and
--   client_media_assets.brief_id is ON DELETE SET NULL. Deleting only the
--   campaign would leave briefs and images with nothing pointing at them —
--   still in Asset review, still awaiting a decision, now with no way to
--   tell what they were for. Same hole recruitment closed.
--
-- So delete_client_campaign removes owned production first (assets, then
-- briefs from the campaign's ideas, then the campaign itself). CASCADE then
-- clears ideas, artifact links and pillar links. Landing pages and sales
-- agents linked via campaign_artifacts stay; only the link row goes.
--
-- delete_client_idea removes one idea and the briefs/assets produced from
-- it. It never touches the parent campaign. Sibling ideas stay.
--
-- Admin-only, same gate as delete_recruitment_ad (is_admin). Employees and
-- clients must not delete. Console-only: content registry has no matching
-- create/update MCP tools for these entities, so no MCP delete_* is added.

-- ---------------------------------------------------------------------------
-- delete_client_idea
-- ---------------------------------------------------------------------------

create or replace function delete_client_idea(p_idea_id uuid)
returns table (
  deleted_briefs integer,
  deleted_assets integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idea client_ideas;
  v_brief_ids uuid[];
  v_assets integer;
  v_briefs integer;
begin
  if not is_admin() then
    raise exception 'Only an admin can delete an idea.';
  end if;

  select * into v_idea from client_ideas where id = p_idea_id for update;
  if not found then
    raise exception 'That idea no longer exists.';
  end if;

  select coalesce(array_agg(id), '{}') into v_brief_ids
  from client_briefs
  where source_idea_id = p_idea_id;

  -- Images first, while the briefs are still there to find them by.
  -- client_media_assets.brief_id is ON DELETE SET NULL.
  delete from client_media_assets
  where brief_id = any (v_brief_ids);
  get diagnostics v_assets = row_count;

  -- creative_generations / creative_renders / campaign_artifacts(brief_id)
  -- cascade from the brief.
  delete from client_briefs where id = any (v_brief_ids);
  get diagnostics v_briefs = row_count;

  delete from client_ideas where id = p_idea_id;

  deleted_briefs := v_briefs;
  deleted_assets := v_assets;
  return next;
end;
$$;

revoke execute on function delete_client_idea(uuid) from public, anon;
grant execute on function delete_client_idea(uuid) to authenticated, service_role;

comment on function delete_client_idea(uuid) is
  'Admin-only. Hard-deletes one client idea and the briefs/assets produced from it. Never deletes the parent campaign.';

-- ---------------------------------------------------------------------------
-- delete_client_campaign
-- ---------------------------------------------------------------------------

create or replace function delete_client_campaign(p_campaign_id uuid)
returns table (
  deleted_ideas integer,
  deleted_briefs integer,
  deleted_assets integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign client_campaigns;
  v_idea_ids uuid[];
  v_brief_ids uuid[];
  v_ideas integer;
  v_briefs integer;
  v_assets integer;
  v_extra integer;
begin
  if not is_admin() then
    raise exception 'Only an admin can delete a campaign.';
  end if;

  select * into v_campaign from client_campaigns where id = p_campaign_id for update;
  if not found then
    raise exception 'That campaign no longer exists.';
  end if;

  select coalesce(array_agg(id), '{}') into v_idea_ids
  from client_ideas
  where campaign_id = p_campaign_id;

  select coalesce(array_agg(distinct x), '{}') into v_brief_ids
  from (
    select b.id as x
    from client_briefs b
    where b.source_idea_id = any (v_idea_ids)
    union
    select ca.brief_id
    from campaign_artifacts ca
    where ca.campaign_id = p_campaign_id
      and ca.kind = 'content'
      and ca.brief_id is not null
  ) s;

  delete from client_media_assets
  where brief_id = any (v_brief_ids);
  get diagnostics v_assets = row_count;

  -- Content assets attached only via campaign_artifacts.asset_id.
  delete from client_media_assets a
  using campaign_artifacts ca
  where ca.campaign_id = p_campaign_id
    and ca.kind = 'content'
    and ca.asset_id = a.id;
  get diagnostics v_extra = row_count;
  v_assets := v_assets + v_extra;

  delete from client_briefs where id = any (v_brief_ids);
  get diagnostics v_briefs = row_count;

  -- Ideas, campaign_artifacts, campaign_content_pillars CASCADE from the
  -- campaign. Count ideas before that happens so the notice can name them.
  v_ideas := coalesce(array_length(v_idea_ids, 1), 0);

  delete from client_campaigns where id = p_campaign_id;

  deleted_ideas := v_ideas;
  deleted_briefs := v_briefs;
  deleted_assets := v_assets;
  return next;
end;
$$;

revoke execute on function delete_client_campaign(uuid) from public, anon;
grant execute on function delete_client_campaign(uuid) to authenticated, service_role;

comment on function delete_client_campaign(uuid) is
  'Admin-only. Hard-deletes a client campaign after removing owned ideas, content briefs and assets. Cascade also clears artifact and pillar links. Does not delete landing pages or sales agents — only their campaign links.';
