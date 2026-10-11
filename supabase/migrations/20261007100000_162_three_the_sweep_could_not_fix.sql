-- Three that a grant could not fix.
--
-- 161 took EXECUTE away from anon and left `security_definer_exposure`
-- behind so the rest could be read rather than guessed at. Reading it: 91
-- SECURITY DEFINER functions a signed-in person can call, 18 of which never
-- ask who is calling.
--
-- Fifteen of those eighteen are fine, and it is worth saying why so the
-- number is not re-litigated every time somebody runs the query. is_admin,
-- is_member, is_client_user, is_channel_member, current_role_of,
-- current_member_id, my_account_team, chat_participants and can_run_agent
-- are the permission primitives themselves — they read the caller's own
-- identity, so "check the caller" is what they are. lead_stage_rank is
-- arithmetic on an enum. sync_post_copy_parent and
-- sync_team_member_profile_name are trigger functions, which Postgres runs
-- without consulting EXECUTE at all. mcp_queue_distribution and the MCP
-- entry points check a bot's own permissions, which is their equivalent.
-- enqueue_token_health_job and enqueue_publish_sweep queue one idempotent
-- job each and are deliberately reachable so an admin can prod them.
--
-- Three are not fine.

-- ---------------------------------------------------------------------------
-- create_content_slot: a signed-in person could plan another client's month
-- ---------------------------------------------------------------------------

-- The worst of the three. No check of any kind, so anybody signed in could
-- create slots against any client_id — rows they cannot even read back,
-- because content_slots' RLS is scoped — and the tick would pick them up
-- and spend that client's budget on them. A cross-client write with a
-- cross-client bill at the end of it.
create or replace function public.create_content_slot(
  p_client_id uuid,
  p_platform post_platform,
  p_scheduled_at timestamptz,
  p_pillar_id uuid default null,
  p_format content_format default 'single'
)
returns content_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row content_slots;
begin
  -- The same three callers as advance_slot, and the same reasoning: the
  -- engine, the database's own cron, or somebody who can reach the client.
  if not may_advance_slot(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  insert into content_slots (client_id, platform, scheduled_at, pillar_id, format)
  values (p_client_id, p_platform, p_scheduled_at, p_pillar_id, p_format)
  on conflict (client_id, platform, scheduled_at) do nothing
  returning * into v_row;

  -- Already planned for that window. The planner running twice is normal, so
  -- this is not an error; it returns what is there.
  if v_row.id is null then
    select * into v_row from content_slots
    where client_id = p_client_id and platform = p_platform and scheduled_at = p_scheduled_at;
    return v_row;
  end if;

  insert into slot_events (slot_id, from_stage, to_stage, actor, note)
  values (v_row.id, null, 'planned', 'engine', 'Planned.');
  return v_row;
end;
$$;

comment on function public.create_content_slot is
  'Plan one slot, for a client the caller can reach. Idempotent on (client, platform, instant), so a planner that runs twice does not make the post twice.';

-- ---------------------------------------------------------------------------
-- integration_usable: whether somebody else's account is connected
-- ---------------------------------------------------------------------------

-- Added in 160 as a cheap predicate for the publish queue, and cheap in the
-- wrong way: it takes a client_id and returns a boolean, so a signed-in
-- person could ask it about every client in turn and learn which agencies
-- have which platforms connected. Not a token and not a number, but it is
-- somebody else's business and it was readable one call at a time.
create or replace function public.integration_usable(p_client_id uuid, p_provider text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when not may_advance_slot(p_client_id) then null
    else exists (
      select 1 from client_integrations ci
       where ci.client_id = p_client_id
         and ci.provider = p_provider
         and ci.status = any (usable_integration_statuses())
         and ci.credential_secret_id is not null
    )
  end
$$;

comment on function public.integration_usable(uuid, text) is
  'Whether this client has an integration whose token could be read, without reading it. Null — neither true nor false — for a caller who cannot reach the client, because "no" is also an answer about somebody else''s account.';

-- publish_due calls this per row, and the branch was `not
-- integration_usable(...)`. A null makes that null, and a CASE treats a null
-- branch as not matching, so the blocker would be skipped and whichever
-- later branch happened to match would speak for it.
--
-- Not a live leak today: the view is security_invoker, so scheduled_posts'
-- own RLS means a reader who cannot reach the client never sees the row to
-- evaluate. The branch is rewritten anyway, because the next thing to read
-- this view may not come through that RLS — the publisher reads it as the
-- service role already — and "unreachable because of a policy two tables
-- away" is a thing that stops being true quietly.
create or replace view publish_due with (security_invoker = true) as
select
  sp.id as post_id,
  sp.client_id,
  c.name as client_name,
  sp.platform,
  sp.scheduled_at,
  sp.media_type,
  sp.publication_status,
  sp.publish_attempts,
  sp.publish_claimed_at,
  a.id as asset_id,
  a.title as asset_title,
  coalesce(a.render_path, a.storage_path) as media_path,
  a.human_approved_at,
  pce.caption,
  pce.hashtags,
  pce.alt_text,
  pce.link_url,
  pce.first_comment,
  pp.provider,
  pp.supported as platform_supported,
  case
    when sp.asset_id is null or a.id is null then 'The asset is gone. This post can never be published.'
    when a.human_approved_at is null         then 'Nobody has approved the asset.'
    when sp.platform is null                 then 'The post has no platform.'
    when pp.platform is null or not pp.supported
      then 'There is no adapter for ' || coalesce(sp.platform::text, 'this platform') || '.'
    when not coalesce(ces.publishing_enabled, false)
      then 'Publishing is off for this client.'
    when coalesce(integration_usable(sp.client_id, pp.provider), false) is not true
      then 'No usable ' || pp.provider || ' integration for this client.'
    when pce.caption is null or btrim(pce.caption) = ''
      then 'There is no caption for ' || sp.platform::text || '.'
    when sp.scheduled_at > now()             then 'Not due yet.'
    else null
  end as blocker
from scheduled_posts sp
left join clients c on c.id = sp.client_id
left join client_media_assets a on a.id = sp.asset_id
left join client_engine_settings ces on ces.client_id = sp.client_id
left join platform_publishing pp on pp.platform = sp.platform
left join post_copy_effective pce
  on pce.scheduled_post_id = sp.id and pce.platform = sp.platform
where sp.publication_status in ('scheduled', 'publishing')
  and sp.published_at is null;

comment on view publish_due is
  'What the publisher may send, and for everything else the one sentence saying why not. A null blocker means it would go out on the next pass. Never treats an unknown integration as a usable one.';

grant select on publish_due to authenticated;

-- ---------------------------------------------------------------------------
-- lock_down_definer_functions: it hands out and takes back privileges
-- ---------------------------------------------------------------------------

-- 161 revoked this from PUBLIC and anon and granted it to service_role, and
-- left Supabase's named grant to authenticated in place, because the revoke
-- named the two roles the migration was about. Calling it is harmless and
-- idempotent — but it is a SECURITY DEFINER function that issues REVOKE as
-- the owner, and "harmless because of what it happens to do today" is not
-- how a privilege primitive should be reachable.
revoke execute on function public.lock_down_definer_functions() from authenticated;

-- ---------------------------------------------------------------------------
-- And the sweep, last, because this migration added functions
-- ---------------------------------------------------------------------------

select public.lock_down_definer_functions();
