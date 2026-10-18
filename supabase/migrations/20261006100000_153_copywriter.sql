-- The words that go out with the post, written by the engine.
--
-- M3.8. post_copy and set_post_copy have existed since M0.2 (145); what is
-- missing is anything that fills them, and one obstacle in the way of the
-- runtime doing so.
--
-- set_post_copy is guarded by can_access_client, which asks whether the
-- *signed-in person* may act for this client. The runtime is not a signed-in
-- person: it connects as service_role, which has no auth.uid(), so is_admin()
-- is false, so can_access_client is false, so the one function that writes
-- copy refuses the one process that needs to. client_budget_state already
-- carries `auth.role() = 'service_role' or can_access_client(...)` for
-- exactly this reason; set_post_copy should have had it from the start.
--
-- This grants the service role nothing it did not have. service_role bypasses
-- RLS outright and could write post_copy directly; the guard was only ever
-- stopping it from using the path where the upsert and the versioning live,
-- which would have pushed the engine into hand-rolling both.

create or replace function public.set_post_copy(
  p_platform post_platform,
  p_scheduled_post_id uuid default null,
  p_asset_id uuid default null,
  p_caption text default null,
  p_hashtags text[] default '{}',
  p_alt_text text default null,
  p_link_url text default null,
  p_first_comment text default null,
  p_cta text default null,
  p_source text default 'human'
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid;
  v_id uuid;
begin
  if (p_scheduled_post_id is null) = (p_asset_id is null) then
    raise exception 'Copy belongs to a scheduled post or to an asset, not both and not neither.';
  end if;

  if p_scheduled_post_id is not null then
    select sp.client_id into v_client from scheduled_posts sp where sp.id = p_scheduled_post_id;
    if v_client is null then
      raise exception 'That scheduled post does not exist.';
    end if;
  else
    select a.client_id into v_client from client_media_assets a where a.id = p_asset_id;
    if v_client is null then
      raise exception 'That asset does not exist.';
    end if;
  end if;

  -- The runtime is not a person. See the note at the top of this migration.
  if coalesce(auth.role(), '') <> 'service_role' and not can_access_client(v_client) then
    raise exception 'Not permitted for this client';
  end if;

  if p_scheduled_post_id is not null then
    insert into post_copy as pc (
      scheduled_post_id, platform, caption, hashtags,
      alt_text, link_url, first_comment, cta, source, created_by
    ) values (
      p_scheduled_post_id, p_platform, p_caption, coalesce(p_hashtags, '{}'),
      p_alt_text, p_link_url, p_first_comment, p_cta, p_source, auth.uid()
    )
    on conflict (scheduled_post_id, platform) where scheduled_post_id is not null
    do update set
      caption = excluded.caption,
      hashtags = excluded.hashtags,
      alt_text = excluded.alt_text,
      link_url = excluded.link_url,
      first_comment = excluded.first_comment,
      cta = excluded.cta,
      source = excluded.source
    returning pc.id into v_id;
  else
    insert into post_copy as pc (
      asset_id, platform, caption, hashtags,
      alt_text, link_url, first_comment, cta, source, created_by
    ) values (
      p_asset_id, p_platform, p_caption, coalesce(p_hashtags, '{}'),
      p_alt_text, p_link_url, p_first_comment, p_cta, p_source, auth.uid()
    )
    on conflict (asset_id, platform) where asset_id is not null
    do update set
      caption = excluded.caption,
      hashtags = excluded.hashtags,
      alt_text = excluded.alt_text,
      link_url = excluded.link_url,
      first_comment = excluded.first_comment,
      cta = excluded.cta,
      source = excluded.source
    returning pc.id into v_id;
  end if;

  return v_id;
end;
$$;

comment on function public.set_post_copy is
  'Write the copy for one platform, on a scheduled post or an asset. Upserts: there is one current copy per platform per parent. The service role may write for any client; a person needs access to it.';

grant execute on function public.set_post_copy(
  post_platform, uuid, uuid, text, text[], text, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The agent
-- ---------------------------------------------------------------------------

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values (
  'copywriter', 'Copywriter', 'CW', 'content',
  'Writes the caption, hashtags, alt text and first comment for a slot''s platform, from the brief and the asset, inside that platform''s limits.',
  array['brand_strategy']::text[], true)
on conflict (agent_key) do nothing;

-- A slot reaches copywriting when the asset exists. Until this row, slots
-- rested there visibly with nothing to move them on, which was the intended
-- behaviour of an unregistered stage rather than a gap.
insert into slot_pipeline (stage, format, agent_key, enter_stage, note)
values ('copywriting', null, 'copywriter', null, 'Write the words for the slot''s platform.')
on conflict (stage, format) do nothing;
