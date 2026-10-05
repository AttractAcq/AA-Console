-- A post has a time, and the time belongs to the client's day.
--
-- Scheduling has been date-only since migration 06: scheduled_posts.scheduled_for
-- is a date, and distribution_due compared it against CURRENT_DATE. That is two
-- problems rather than one.
--
-- The first is that a date cannot say "09:00". The engine (M3) has to queue a
-- publish at an instant, and a publisher that fires on a date has to invent the
-- time. The second is subtler and is why this migration exists at all:
-- CURRENT_DATE on Supabase is UTC, so "today" was the server's today, not the
-- client's. A London client in summer has an hour each evening where the board
-- says tomorrow; a client further east would have had a whole day of it.
--
-- So: clients carry an IANA timezone, scheduled_posts carry an instant, and
-- scheduled_for stays as the local date that instant falls on.
--
-- scheduled_for stays because distribution_due, the board, the calendar and the
-- gateway all read it, and because "which day is this post on" is a real
-- question with a local answer. It is kept in step by trigger rather than being
-- a generated column: a generated expression may not read another table, and
-- the timezone lives on clients. (A literal zone would have been allowed —
-- `at time zone 'Europe/London'` is immutable — but a per-client zone is the
-- entire point.)
--
-- Either column may be written. Write an instant and the local date follows it;
-- write a date and the instant lands at 09:00 local. Moving a post to another
-- day on the board keeps the time of day it already had.

-- ---------------------------------------------------------------------------
-- 1. The client's timezone
-- ---------------------------------------------------------------------------

alter table clients add column if not exists timezone text not null default 'Europe/London';

comment on column clients.timezone is
  'IANA timezone name. The client''s working day: what "today" and "09:00" mean for their posts. Validated against pg_timezone_names on write.';

-- A CHECK constraint cannot do this: pg_timezone_names is a function-backed
-- view, so reading it is a subquery, which CHECK forbids. A trigger can, and
-- client writes are rare enough that enumerating the zones costs nothing.
create or replace function public.validate_client_timezone()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.timezone is null or btrim(new.timezone) = '' then
    raise exception 'A client needs a timezone, as an IANA name such as Europe/London.';
  end if;
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception '"%" is not an IANA timezone name. Use one such as Europe/London or America/New_York.', new.timezone;
  end if;
  return new;
end;
$$;

drop trigger if exists clients_validate_timezone on clients;
create trigger clients_validate_timezone
before insert or update of timezone on clients
for each row execute function public.validate_client_timezone();

-- ---------------------------------------------------------------------------
-- 2. Reading a post's timezone
-- ---------------------------------------------------------------------------

-- Falls back rather than failing. A scheduled post whose client row has gone
-- is already an orphan on the board; it should not also break the view that
-- says so.
create or replace function public.client_timezone(p_client_id uuid)
returns text
language sql
stable
set search_path to 'public'
as $$
  select coalesce((select c.timezone from clients c where c.id = p_client_id), 'Europe/London');
$$;

comment on function public.client_timezone(uuid) is
  'The client''s IANA timezone, or Europe/London when the client is unknown.';

-- ---------------------------------------------------------------------------
-- 3. The instant
-- ---------------------------------------------------------------------------

alter table scheduled_posts add column if not exists scheduled_at timestamptz;

comment on column scheduled_posts.scheduled_at is
  'When this post goes out, as an instant. The publisher reads this. scheduled_for is the local date it falls on and is kept in step by trigger.';

comment on column scheduled_posts.scheduled_for is
  'The client-local date of scheduled_at. Derived, not independent: write either column and the other follows.';

-- The hour a post lands on when only a date was given. Mid-morning on a
-- working day rather than midnight, which would read as the day before to
-- anyone looking at a clock.
create or replace function public.default_post_time()
returns time
language sql
immutable
as $$ select time '09:00' $$;

comment on function public.default_post_time() is
  'The local time a post is scheduled for when only a date was supplied.';

-- Backfill before the NOT NULL. Existing rows are date-only, so they take the
-- default hour in their own client's zone — which is what the board has been
-- showing them as all along.
update scheduled_posts sp
set scheduled_at = (sp.scheduled_for + public.default_post_time())
                   at time zone public.client_timezone(sp.client_id)
where sp.scheduled_at is null;

-- ---------------------------------------------------------------------------
-- 4. Keeping the two in step
-- ---------------------------------------------------------------------------

-- This trigger already existed to copy ref_number, media_type and client_id
-- down from the asset. It keeps that job: the timezone lookup needs client_id,
-- and client_id is resolved here, so the two belong in one BEFORE trigger
-- rather than two that would have to agree on their order.
create or replace function public.sync_scheduled_post_from_asset()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tz text;
  v_time_of_day time;
begin
  if new.asset_id is not null then
    select a.ref_number, a.media_type, a.client_id
      into new.ref_number, new.media_type, new.client_id
      from client_media_assets a where a.id = new.asset_id;
  end if;

  if new.scheduled_at is null and new.scheduled_for is null then
    raise exception 'A scheduled post needs either a date or a time.';
  end if;

  v_tz := public.client_timezone(new.client_id);

  if tg_op = 'INSERT' then
    if new.scheduled_at is not null then
      new.scheduled_for := (new.scheduled_at at time zone v_tz)::date;
    else
      new.scheduled_at := (new.scheduled_for + public.default_post_time()) at time zone v_tz;
    end if;
    return new;
  end if;

  -- On update, whichever column the caller actually moved is the one that wins.
  if new.scheduled_at is distinct from old.scheduled_at then
    new.scheduled_for := (new.scheduled_at at time zone v_tz)::date;
  elsif new.scheduled_for is distinct from old.scheduled_for then
    -- The board moves posts by date. Keep the time of day it already had
    -- rather than resetting every dragged post to 09:00.
    v_time_of_day := (old.scheduled_at at time zone v_tz)::time;
    new.scheduled_at := (new.scheduled_for + v_time_of_day) at time zone v_tz;
  elsif new.client_id is distinct from old.client_id then
    -- The client moved, so the same instant may now fall on a different date.
    new.scheduled_for := (new.scheduled_at at time zone v_tz)::date;
  end if;

  return new;
end;
$$;

-- Now that nothing can insert without one.
alter table scheduled_posts alter column scheduled_at set not null;

-- The publisher (M2) claims by instant. Only rows that have not gone out.
create index if not exists scheduled_posts_due_idx
  on scheduled_posts (scheduled_at)
  where publication_status = 'scheduled' and published_at is null;

-- ---------------------------------------------------------------------------
-- 5. What is due
-- ---------------------------------------------------------------------------

-- Three changes, and only the second alters what an existing row reads as:
--   - scheduled_at and due_now are new. due_now is the publisher's question:
--     has this instant passed. state stays the board's question: which day.
--   - "today" is now the client's today rather than the server's. That is the
--     bug this migration exists to fix, so the change is deliberate.
--   - days_late counts from the client's today for the same reason.
--
-- The two new columns go on the end. create or replace view may add columns
-- but may not rename or reorder the ones already there, so putting
-- scheduled_at next to scheduled_for where it reads better would mean
-- dropping the view the board selects from and recreating it.
create or replace view distribution_due as
select
  sp.client_id,
  sp.id as schedule_id,
  sp.asset_id,
  sp.ref_number,
  sp.scheduled_for,
  sp.channel::text as channel,
  sp.platform::text as platform,
  sp.media_type::text as media_type,
  a.title as asset_title,
  a.content_format::text as content_format,
  case
    when sp.asset_id is null or a.id is null then 'orphaned'
    when sp.scheduled_for < (now() at time zone public.client_timezone(sp.client_id))::date then 'overdue'
    when sp.scheduled_for = (now() at time zone public.client_timezone(sp.client_id))::date then 'due_today'
    else 'upcoming'
  end as state,
  greatest((now() at time zone public.client_timezone(sp.client_id))::date - sp.scheduled_for, 0) as days_late,
  coalesce(a.human_approved_at is not null, false) as human_approved,
  sp.scheduled_at,
  (sp.scheduled_at <= now()) as due_now
from scheduled_posts sp
left join client_media_assets a on a.id = sp.asset_id
where sp.publication_status = 'scheduled' and sp.published_at is null;

comment on view distribution_due is
  'Distribution still outstanding. state answers "which day" for the board; due_now answers "has the moment passed" for the publisher. Both read the client''s clock, not the server''s.';

-- ---------------------------------------------------------------------------
-- 6. Scheduling with a time
-- ---------------------------------------------------------------------------

-- Dropped rather than replaced: adding a defaulted parameter makes an overload,
-- and a four-argument call would then be ambiguous between the two.
drop function if exists public.schedule_asset(uuid, date, post_channel, post_platform);

create or replace function public.schedule_asset(
  p_asset_id uuid,
  p_date date,
  p_channel post_channel default 'organic'::post_channel,
  p_platform post_platform default null::post_platform,
  p_time time default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid;
  v_status review_status;
  v_human  timestamptz;
  v_id     uuid;
begin
  select client_id, review_status, human_approved_at
    into v_client, v_status, v_human
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
  if v_human is null then
    raise exception 'That asset has not been approved by a person yet. Approve it in Approvals before scheduling it.';
  end if;

  -- A null time leaves scheduled_at null and lets the trigger apply the
  -- default hour, so the default lives in exactly one place.
  insert into scheduled_posts (asset_id, scheduled_for, scheduled_at, channel, platform, created_by)
  values (
    p_asset_id,
    p_date,
    case when p_time is null then null
         else (p_date + p_time) at time zone public.client_timezone(v_client) end,
    p_channel,
    p_platform,
    auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.schedule_asset(uuid, date, post_channel, post_platform, time) is
  'Schedule a human-approved asset. p_time is the client-local time of day; omitted, it is default_post_time().';

grant execute on function public.schedule_asset(uuid, date, post_channel, post_platform, time) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. The same, for the distribution bot
-- ---------------------------------------------------------------------------

drop function if exists mcp_internal.queue_distribution(text, text, text, uuid, uuid, date, text);

create or replace function mcp_internal.queue_distribution(
  p_bot_id text,
  p_request_id text,
  p_execution_id text,
  p_client_id uuid,
  p_asset_id uuid,
  p_scheduled_for date,
  p_channel text default 'organic'::text,
  p_scheduled_time time default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'mcp_internal', 'public'
as $function$
declare
  v_asset client_media_assets;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
  v_schedule_id uuid;
  v_scheduled_at timestamptz;
begin
  -- Sec Phase 5 posture: active bot + mcp_bot_clients grant. Never can_access_client.
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  -- Phase 10 Alex CLEAR: distribution schedule write is bot_distribution only.
  -- Hard-coded, not expressed as a permission row (bot_production keeps
  -- content.* for its other real content tools and already matches this name).
  if p_bot_id <> 'bot_distribution' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_scheduled_for is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_channel is null or p_channel not in ('organic', 'paid') then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  -- The time is part of the request, so two calls that differ only by time are
  -- two requests rather than one replay.
  v_payload := jsonb_build_object(
    'asset_id', p_asset_id, 'scheduled_for', p_scheduled_for, 'channel', p_channel,
    'scheduled_time', p_scheduled_time);
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.queue_distribution', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_asset from client_media_assets where id = p_asset_id for update;
  if not found then
    raise exception using message = 'asset_not_found', errcode = 'P0001';
  end if;
  if v_asset.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  if v_asset.review_status <> 'approved' then
    raise exception using message = 'invalid_asset_status', errcode = 'P0001';
  end if;

  if p_scheduled_time is not null then
    v_scheduled_at := (p_scheduled_for + p_scheduled_time)
                      at time zone public.client_timezone(p_client_id);
  end if;

  insert into scheduled_posts (asset_id, scheduled_for, scheduled_at, channel, created_by_bot)
  values (p_asset_id, p_scheduled_for, v_scheduled_at, p_channel::post_channel, p_bot_id)
  returning id into v_schedule_id;

  select sp.scheduled_at into v_scheduled_at from scheduled_posts sp where sp.id = v_schedule_id;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'asset_id', p_asset_id,
    'schedule_id', v_schedule_id,
    'scheduled_for', p_scheduled_for,
    'scheduled_at', v_scheduled_at,
    'channel', p_channel,
    'publication_status', 'scheduled',
    'created_by_bot', p_bot_id,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, asset_id, schedule_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.queue_distribution', p_client_id,
    p_asset_id, v_schedule_id, v_payload, v_result
  );
  return v_result;
end;
$function$;

-- The service-role wrapper the gateway actually calls. It has to pass the new
-- argument through or the bot path can never set a time, whatever the
-- function underneath accepts.
drop function if exists public.mcp_queue_distribution(text, text, text, uuid, uuid, date, text);

create or replace function public.mcp_queue_distribution(
  p_bot_id text,
  p_request_id text,
  p_execution_id text,
  p_client_id uuid,
  p_asset_id uuid,
  p_scheduled_for date,
  p_channel text default 'organic'::text,
  p_scheduled_time time default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'mcp_internal', 'public'
as $function$
begin
  perform mcp_internal.require_service_role();
  return mcp_internal.queue_distribution(
    p_bot_id, p_request_id, p_execution_id, p_client_id, p_asset_id, p_scheduled_for,
    p_channel, p_scheduled_time);
end;
$function$;
