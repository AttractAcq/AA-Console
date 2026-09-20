-- Which platform a scheduled post goes to.
--
-- scheduled_posts.channel is post_channel — organic or paid — which says how
-- a post is distributed, not where. So there has been nowhere to record that
-- one asset goes to Instagram and the next to TikTok, and the calendar could
-- show a month of posts without saying which feed any of them lands in.
--
-- Nullable. Posts already scheduled were scheduled without a platform being
-- recorded, and picking one for them now would be inventing a fact rather
-- than recovering one.

create type post_platform as enum ('facebook', 'instagram', 'tiktok', 'linkedin', 'youtube');

alter table scheduled_posts
  add column platform post_platform;

create index sp_platform_idx on scheduled_posts (client_id, platform)
  where platform is not null;

comment on column scheduled_posts.platform is
  'Where the post goes. Null on posts scheduled before this column existed; channel says organic or paid, which is a different question.';

-- The old three-argument function has to go rather than gain an overload.
-- A four-argument version whose last parameter has a default would make the
-- existing three-argument call ambiguous, and Postgres refuses an ambiguous
-- call at run time rather than at migration time — which would mean a green
-- deploy and a scheduling screen that stops working.
drop function if exists schedule_asset(uuid, date, post_channel);

create function schedule_asset(
  p_asset_id uuid,
  p_date     date,
  p_channel  post_channel default 'organic',
  p_platform post_platform default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_status review_status;
  v_id     uuid;
begin
  select client_id, review_status into v_client, v_status
    from client_media_assets where id = p_asset_id;
  if v_client is null then
    raise exception 'Asset not found';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client';
  end if;
  if v_status <> 'approved' then
    raise exception 'Asset must be approved before it can be scheduled';
  end if;

  insert into scheduled_posts (asset_id, scheduled_for, channel, platform, created_by)
  values (p_asset_id, p_date, p_channel, p_platform, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- The dropped function took its grant with it. Restored exactly as migration
-- 09 set it: authenticated only, no service_role. Adding a column is not a
-- reason to widen who may call this.
revoke execute on function schedule_asset(uuid, date, post_channel, post_platform) from public, anon;
grant execute on function schedule_asset(uuid, date, post_channel, post_platform) to authenticated;

comment on function schedule_asset(uuid, date, post_channel, post_platform) is
  'Schedules an approved asset. Refuses anything not through the review gate. Platform is optional: a post can be planned before its feed is decided.';
