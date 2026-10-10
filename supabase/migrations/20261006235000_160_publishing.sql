-- Publishing: the claim, the record, and the switch that is off.
--
-- M2, and the end of the chain. Everything up to here prepares; this is the
-- only thing in the system that makes a client's account say something in
-- public. It is therefore the one place where "built and inert" is the
-- correct state to ship in, and where the switch being off by default is a
-- feature rather than an unfinished edge.
--
-- TWO SWITCHES, AND WHY
--
-- The runtime has PUBLISH_ENABLED, which is off unless set. This migration
-- adds client_engine_settings.publishing_enabled, which is off for every
-- client including the ones already running the engine. Both must be true.
--
-- One switch would be enough to stop publishing. It would not be enough to
-- stop publishing *for the wrong client*: a single env var means the day
-- somebody turns publishing on for one account, it is on for every account
-- the engine has ever planned a slot for. The per-client flag is what makes
-- "we are live for Attract Acquisition" a sentence that can be true without
-- also being true of everyone else.
--
-- CLAIMING, AND WHAT HAPPENS WHEN A RUNTIME DIES
--
-- A post is claimed before it is published, the same way a job is leased:
-- status goes to 'publishing' and nothing else will pick it up. If the
-- runtime then dies, that row is stranded, and there are two ways to treat
-- it. Putting it back to 'scheduled' is what a queue normally does, and here
-- it means posting twice to a real account, because a crash after the HTTP
-- call and before the write looks exactly like a crash before the call.
--
-- So a stale claim fails, with a reason that says a person has to look at
-- the account. That is worse ergonomics and better behaviour: a post that
-- did not go out and says so can be sent by hand in a minute, and a post
-- that went out twice cannot be unsent.
--
-- WHAT THIS DOES NOT DO
--
-- It does not talk to any platform. The transport, per platform, is the
-- runtime's adapters; what lives here is the gate, the claim, the record and
-- an honest account of why nothing went out.

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

alter table client_engine_settings
  add column if not exists publishing_enabled boolean not null default false,
  add column if not exists publishing_enabled_at timestamptz,
  add column if not exists publishing_enabled_by uuid references auth.users(id) on delete set null;

comment on column client_engine_settings.publishing_enabled is
  'Whether the engine may post to this client''s own accounts. Off for every client until somebody turns it on for that client. The runtime''s PUBLISH_ENABLED must also be on: both, or nothing goes out.';
comment on column client_engine_settings.publishing_enabled_at is
  'When publishing was turned on for this client, and by whom. A record of a decision, not a setting.';

-- ---------------------------------------------------------------------------
-- Which platform goes out through which connector
-- ---------------------------------------------------------------------------

-- A table rather than a CASE in three places. The useful column is
-- `supported`: a platform with no adapter must be visibly unsupported in the
-- queue rather than silently never claimed, which is the difference between
-- "LinkedIn has no adapter yet" and "LinkedIn posts quietly do not happen".
create table if not exists platform_publishing (
  platform post_platform primary key,
  provider text not null,
  supported boolean not null default false,
  note text
);

comment on table platform_publishing is
  'Which integration each platform publishes through, and whether an adapter exists. Data, so the queue can say "no adapter" instead of staying silent.';

insert into platform_publishing (platform, provider, supported, note) values
  ('instagram', 'instagram', true,  'Instagram Graph API: a container, then a publish. Needs an IG user id on the integration.'),
  ('facebook',  'meta',      true,  'Page feed through the page token on the meta integration.'),
  ('linkedin',  'linkedin',  false, 'No connector and no adapter. Nothing is claimed for LinkedIn.'),
  ('tiktok',    'tiktok',    false, 'No connector and no adapter.'),
  ('youtube',   'youtube',   false, 'No connector and no adapter.')
on conflict (platform) do update
  set provider = excluded.provider,
      supported = excluded.supported,
      note = excluded.note;

alter table platform_publishing enable row level security;
create policy pp_read on platform_publishing for select to authenticated using (true);
grant select on platform_publishing to authenticated;

-- ---------------------------------------------------------------------------
-- One list of statuses a token can be read in
-- ---------------------------------------------------------------------------

-- Migration 156 fixed a deadlock caused by this list existing in two places
-- and the two drifting: metrics_ingest had learned that 'connected' is usable
-- and integration_secret had not. The queue below needs the same predicate a
-- third time, to say "no usable integration" truthfully, so the list becomes
-- one function that every reader asks instead of a literal every reader
-- copies.
create or replace function public.usable_integration_statuses()
returns text[]
language sql
immutable
set search_path to 'public'
as $$ select array['connected', 'active']::text[] $$;

comment on function public.usable_integration_statuses() is
  'The integration states whose token may be used. One list: 156 was caused by there being two. error and expiring are deliberately absent -- the token is known not to work.';

create or replace function public.integration_usable(p_client_id uuid, p_provider text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from client_integrations ci
     where ci.client_id = p_client_id
       and ci.provider = p_provider
       and ci.status = any (usable_integration_statuses())
       and ci.credential_secret_id is not null
  )
$$;

comment on function public.integration_usable(uuid, text) is
  'Whether this client has an integration whose token could be read, without reading it. The queue asks this rather than decrypting a secret per row to test it for null.';

-- And integration_secret asks the same function, so there is no second list
-- left to drift from the first.
create or replace function public.integration_secret(p_client_id uuid, p_provider text)
returns text
language plpgsql
security definer
set search_path to 'public', 'vault'
as $function$
declare
  v_secret_id uuid;
  v_value     text;
begin
  select credential_secret_id into v_secret_id
    from client_integrations
   where client_id = p_client_id
     and provider = p_provider
     and status = any (public.usable_integration_statuses());

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_value
    from vault.decrypted_secrets
   where id = v_secret_id;

  return v_value;
end;
$function$;

revoke all on function public.usable_integration_statuses() from public;
revoke all on function public.integration_usable(uuid, text) from public;
grant execute on function public.usable_integration_statuses() to authenticated, service_role;
grant execute on function public.integration_usable(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A post being published is a state, and it was not one
-- ---------------------------------------------------------------------------

-- 'publishing' is the claim. Without it the only way to stop two runtimes
-- taking the same row is to hope.
alter table scheduled_posts drop constraint if exists scheduled_posts_publication_status_check;
alter table scheduled_posts add constraint scheduled_posts_publication_status_check
  check (publication_status in ('scheduled', 'publishing', 'published', 'failed'));

alter table scheduled_posts
  add column if not exists publish_attempts integer not null default 0,
  add column if not exists publish_claimed_at timestamptz,
  add column if not exists external_url text;

comment on column scheduled_posts.publish_attempts is
  'How many times publishing has been attempted. The cap stops a post that cannot go out from being tried forever.';
comment on column scheduled_posts.publish_claimed_at is
  'When a runtime claimed this post. A claim older than the reaper''s window is treated as a runtime that died, and the post fails rather than being retried.';
comment on column scheduled_posts.external_url is
  'The post''s own URL on the platform, where the platform returns one. What a person clicks to see that it went out.';

alter table scheduled_posts drop constraint if exists sp_claim_has_time;
alter table scheduled_posts add constraint sp_claim_has_time
  check (publication_status <> 'publishing' or publish_claimed_at is not null);

create index if not exists scheduled_posts_claimed_idx
  on scheduled_posts (publish_claimed_at)
  where publication_status = 'publishing';

-- ---------------------------------------------------------------------------
-- What would go out, and what is stopping each thing that would not
-- ---------------------------------------------------------------------------

-- distribution_due (122/123) answers "what is outstanding" for a person
-- looking at a board. This answers the publisher's question, which is
-- different: of the outstanding posts, which one may I send right now, and
-- for each of the rest, exactly what is in the way. One nullable column
-- rather than six booleans, because the publisher acts on the first blocker
-- and a person reads it as a sentence.
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
    when not integration_usable(sp.client_id, pp.provider)
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
  'What the publisher may send, and for everything else the one sentence saying why not. A null blocker means it would go out on the next pass.';

grant select on publish_due to authenticated;

-- ---------------------------------------------------------------------------
-- Claiming
-- ---------------------------------------------------------------------------

create or replace function public.claim_posts_for_publishing(p_limit integer default 5)
returns table (
  post_id uuid,
  client_id uuid,
  platform post_platform,
  provider text,
  media_type media_type,
  media_path text,
  asset_id uuid,
  caption text,
  hashtags text[],
  alt_text text,
  link_url text,
  first_comment text,
  scheduled_at timestamptz,
  attempt integer
)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Posts are claimed by the publisher.' using errcode = 'P0001';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Claim between 1 and 50 posts at a time.' using errcode = 'P0001';
  end if;

  return query
  with ready as (
    select d.post_id
      from publish_due d
      join scheduled_posts s on s.id = d.post_id
     where d.blocker is null
       and d.publication_status = 'scheduled'
     order by d.scheduled_at
     limit p_limit
     for update of s skip locked
  ),
  claimed as (
    update scheduled_posts sp
       set publication_status = 'publishing',
           publish_claimed_at = now(),
           publish_attempts = sp.publish_attempts + 1,
           updated_at = now()
     where sp.id in (select r.post_id from ready r)
    returning sp.id, sp.publish_attempts
  )
  select
    d.post_id, d.client_id, d.platform, d.provider, d.media_type, d.media_path,
    d.asset_id, d.caption, d.hashtags, d.alt_text, d.link_url, d.first_comment,
    d.scheduled_at, cl.publish_attempts
  from claimed cl
  join publish_due d on d.post_id = cl.id;
end;
$$;

comment on function public.claim_posts_for_publishing(integer) is
  'Take up to p_limit posts that are due, approved, enabled and have copy, marking each as publishing so nothing else takes it. Everything the adapter needs comes back with the claim.';

revoke all on function public.claim_posts_for_publishing(integer) from public;
grant execute on function public.claim_posts_for_publishing(integer) to service_role;

-- ---------------------------------------------------------------------------
-- It went out
-- ---------------------------------------------------------------------------

create or replace function public.record_post_published(
  p_post_id uuid,
  p_external_id text default null,
  p_external_url text default null,
  p_bot text default 'publisher'
)
returns scheduled_posts
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_post scheduled_posts;
  v_slot uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Publication is recorded by the publisher.' using errcode = 'P0001';
  end if;

  select * into v_post from scheduled_posts where id = p_post_id for update;
  if not found then
    raise exception 'No such scheduled post: %.', p_post_id using errcode = 'P0001';
  end if;
  -- Already published is not an error: a runtime that crashed between the
  -- platform call and this write, retried by hand, must not be told off for
  -- recording the truth twice.
  if v_post.publication_status = 'published' then
    return v_post;
  end if;
  if v_post.publication_status <> 'publishing' then
    raise exception 'Post % is %, not being published. Claim it first.', p_post_id, v_post.publication_status
      using errcode = 'P0001';
  end if;

  update scheduled_posts
     set publication_status = 'published',
         published_at = now(),
         external_id = coalesce(p_external_id, external_id),
         external_url = coalesce(p_external_url, external_url),
         published_by_bot = p_bot,
         publish_claimed_at = null,
         failure_reason = null,
         updated_at = now()
   where id = p_post_id;

  select s.id into v_slot from content_slots s
   where s.scheduled_post_id = p_post_id and s.stage = 'scheduled';
  if v_slot is not null then
    perform advance_slot(
      v_slot, 'published', 'agent',
      coalesce('Published. ' || p_external_url, 'Published.'), 'publisher');
  end if;

  select * into v_post from scheduled_posts where id = p_post_id;
  return v_post;
end;
$$;

comment on function public.record_post_published(uuid, text, text, text) is
  'Record that a post went out, and move its slot to published. Recording the same publication twice is not an error: the second call is a crashed runtime telling the truth again.';

-- ---------------------------------------------------------------------------
-- It did not
-- ---------------------------------------------------------------------------

create or replace function public.record_post_publish_failure(
  p_post_id uuid,
  p_reason text,
  p_retryable boolean default false,
  p_max_attempts integer default 3
)
returns scheduled_posts
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_post scheduled_posts;
  v_slot uuid;
  v_give_up boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Publication failures are recorded by the publisher.' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why it failed: this is what a person reads on the board.' using errcode = 'P0001';
  end if;

  select * into v_post from scheduled_posts where id = p_post_id for update;
  if not found then
    raise exception 'No such scheduled post: %.', p_post_id using errcode = 'P0001';
  end if;
  if v_post.publication_status = 'published' then
    -- The call landed and then something downstream broke. The post is out;
    -- saying otherwise on the board would be a lie about a real account.
    raise exception 'Post % is already published. A failure after that is not a failed publication.', p_post_id
      using errcode = 'P0001';
  end if;

  v_give_up := not p_retryable or v_post.publish_attempts >= p_max_attempts;

  update scheduled_posts
     set publication_status = case when v_give_up then 'failed' else 'scheduled' end,
         failure_reason = p_reason,
         publish_claimed_at = null,
         updated_at = now()
   where id = p_post_id;

  -- A slot only fails when the post has. A retryable failure with attempts
  -- left is the queue working, not the slot breaking, and surfacing it as a
  -- failed slot would put a red card in front of a person for something that
  -- is about to be tried again.
  if v_give_up then
    select s.id into v_slot from content_slots s
     where s.scheduled_post_id = p_post_id and s.stage = 'scheduled';
    if v_slot is not null then
      perform advance_slot(v_slot, 'failed', 'agent', p_reason, 'publisher', null, null,
                           null, null, null, null, p_reason);
    end if;
  end if;

  select * into v_post from scheduled_posts where id = p_post_id;
  return v_post;
end;
$$;

comment on function public.record_post_publish_failure(uuid, text, boolean, integer) is
  'Record that publishing failed. A retryable failure with attempts left goes back to scheduled; anything else fails the post and its slot.';

revoke all on function public.record_post_published(uuid, text, text, text) from public;
revoke all on function public.record_post_publish_failure(uuid, text, boolean, integer) from public;
grant execute on function public.record_post_published(uuid, text, text, text) to service_role;
grant execute on function public.record_post_publish_failure(uuid, text, boolean, integer) to service_role;

-- ---------------------------------------------------------------------------
-- A runtime that died mid-publish
-- ---------------------------------------------------------------------------

-- See the header. This deliberately does not retry. A crash after the
-- platform call and a crash before it are indistinguishable from here, and
-- only one of the two guesses can be undone.
create or replace function public.reap_stale_publish_claims(p_older_than interval default interval '15 minutes')
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer := 0;
  v_id uuid;
begin
  for v_id in
    select sp.id from scheduled_posts sp
     where sp.publication_status = 'publishing'
       and sp.publish_claimed_at < now() - p_older_than
     order by sp.publish_claimed_at
  loop
    perform record_post_publish_failure(
      v_id,
      'Claimed for publishing and never reported back. Check the account before sending this again: it may have gone out.',
      false);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function public.reap_stale_publish_claims(interval) is
  'Fail posts whose publisher never came back. Never retries them: a crash after the platform call looks the same as one before it, and only one of those guesses is safe.';

revoke all on function public.reap_stale_publish_claims(interval) from public;
grant execute on function public.reap_stale_publish_claims(interval) to service_role;

-- ---------------------------------------------------------------------------
-- Turning it on for one client
-- ---------------------------------------------------------------------------

create or replace function public.set_publishing_enabled(p_client_id uuid, p_enabled boolean)
returns client_engine_settings
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row client_engine_settings;
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  insert into client_engine_settings (client_id, publishing_enabled,
                                      publishing_enabled_at, publishing_enabled_by)
  values (p_client_id, p_enabled,
          case when p_enabled then now() end,
          case when p_enabled then auth.uid() end)
  on conflict (client_id) do update
     set publishing_enabled = excluded.publishing_enabled,
         -- Kept on the way off, so the record of who turned it on survives
         -- turning it off again.
         publishing_enabled_at = case when excluded.publishing_enabled
                                      then coalesce(client_engine_settings.publishing_enabled_at, now())
                                      else client_engine_settings.publishing_enabled_at end,
         publishing_enabled_by = case when excluded.publishing_enabled
                                      then coalesce(client_engine_settings.publishing_enabled_by, auth.uid())
                                      else client_engine_settings.publishing_enabled_by end,
         updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.set_publishing_enabled(uuid, boolean) is
  'Turn publishing on or off for one client. A person''s decision, recorded with who made it.';

revoke all on function public.set_publishing_enabled(uuid, boolean) from public;
grant execute on function public.set_publishing_enabled(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- The agent, and the sweep that wakes it
-- ---------------------------------------------------------------------------

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values (
  'publisher', 'Publisher', 'PB', 'content',
  'Posts approved, scheduled content to a client''s own accounts. Does nothing unless publishing is on in the runtime and on for that client.',
  array[]::text[], false)
on conflict (agent_key) do nothing;

-- No slot_pipeline row. Every other stage is reached by a slot moving; this
-- one is reached by a clock, and a pipeline row would have the tick queue a
-- publish the moment a slot hit 'scheduled' -- which is approval time, not
-- posting time. A post approved on Monday for Thursday must go out on
-- Thursday.
create or replace function public.enqueue_publish_sweep()
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_job uuid;
begin
  -- One sweep at a time. Two publishers claiming at once is safe -- the
  -- claim is a locked update and skips what is taken -- but two is still
  -- two leases and two logs for one question about the clock.
  if exists (
    select 1 from agent_jobs
     where agent_key = 'publisher' and status in ('queued', 'claimed', 'running')
  ) then
    return null;
  end if;

  -- And nothing to do is nothing to queue. A job that wakes every ten
  -- minutes to find an empty queue is a hundred and forty rows a day
  -- saying so.
  if not exists (select 1 from publish_due where blocker is null) then
    return null;
  end if;

  insert into agent_jobs (agent_key, params)
  values ('publisher', jsonb_build_object('limit', 5))
  returning id into v_job;
  return v_job;
end;
$$;

comment on function public.enqueue_publish_sweep() is
  'Queues one publishing sweep, if something is actually due and no sweep is already in flight.';

revoke all on function public.enqueue_publish_sweep() from public;
grant execute on function public.enqueue_publish_sweep() to authenticated, service_role;

-- Every ten minutes. The planner puts a slot inside a posting window, not on
-- a particular minute, so ten minutes of drift is inside what was promised
-- and a tighter schedule buys nothing.
select cron.unschedule('publish-sweep') where exists (
  select 1 from cron.job where jobname = 'publish-sweep');

select cron.schedule('publish-sweep', '*/10 * * * *', $cron$ select public.enqueue_publish_sweep(); $cron$);

-- ---------------------------------------------------------------------------
-- The reaper, hourly
-- ---------------------------------------------------------------------------

select cron.unschedule('reap-stale-publish-claims')
 where exists (select 1 from cron.job where jobname = 'reap-stale-publish-claims');

select cron.schedule(
  'reap-stale-publish-claims',
  '20 * * * *',
  $cron$select public.reap_stale_publish_claims();$cron$
);
