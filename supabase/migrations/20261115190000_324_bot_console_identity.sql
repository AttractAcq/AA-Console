-- 324 · Bot console identities.
-- A bot is an admin so agency reads keep working, and is denied hard-hold
-- writes. is_admin() is unchanged. AAL2 is not a human check: a bot with a
-- TOTP seed would pass it, so every hard-hold gate calls is_human_admin()
-- or refuses is_bot before that step-up.
--
-- Not applied to staging (vmmertwoboqiazcsougw) or prod (bancbdztffokwiifzoiv).
-- Do not extend create_console_user. Provision with scripts/provision-bot-user.ts.

-- <<bot-identity>>

alter table public.profiles
  add column if not exists is_bot boolean not null default false,
  add column if not exists bot_key text;

alter table public.profiles
  drop constraint if exists profiles_bot_key_key;
alter table public.profiles
  add constraint profiles_bot_key_key unique (bot_key);

alter table public.profiles
  drop constraint if exists profiles_bot_identity_check;
alter table public.profiles
  add constraint profiles_bot_identity_check check (
    (bot_key is null or bot_key ~ '^bot-[a-z0-9-]+$')
    and (not is_bot or bot_key is not null)
    and (is_bot or bot_key is null)
  );

comment on column public.profiles.is_bot is
  'Console bot login. Role stays admin so agency reads work. Hard-hold writes use is_human_admin().';
comment on column public.profiles.bot_key is
  'Stable bot id such as bot-cos. Unique, null for humans, required when is_bot.';

-- Authenticated users, including admins, must not un-bot themselves or mint
-- a bot key. service_role is the provisioner. A value that does not change
-- is not a change, so the metadata backfill below is allowed.
create or replace function public.guard_profile_bot_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_changed := new.is_bot or new.bot_key is not null;
  else
    v_changed := new.is_bot is distinct from old.is_bot
      or new.bot_key is distinct from old.bot_key;
  end if;
  if v_changed and coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'only service_role may change bot identity' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.sync_profile_bot_app_metadata()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update auth.users
     set raw_app_meta_data =
       coalesce(raw_app_meta_data, '{}'::jsonb)
       || jsonb_build_object('is_bot', new.is_bot, 'bot_key', new.bot_key)
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists profiles_guard_bot_identity on public.profiles;
create trigger profiles_guard_bot_identity
  before insert or update of is_bot, bot_key on public.profiles
  for each row execute function public.guard_profile_bot_identity();

drop trigger if exists profiles_sync_bot_app_metadata on public.profiles;
create trigger profiles_sync_bot_app_metadata
  after insert or update of is_bot, bot_key on public.profiles
  for each row execute function public.sync_profile_bot_app_metadata();

-- Column privileges are a second latch. Table-level UPDATE would ignore a
-- column revoke, so take UPDATE away and give back every column except the
-- bot identity. The trigger remains the check that service_role is required.
revoke update on table public.profiles from public, anon, authenticated;
grant update (
  id, role, full_name, email, employee_category, created_at, updated_at
) on table public.profiles to authenticated;
-- Keep the provisioner on a table-level grant. Column grants do not expand it.
grant update on table public.profiles to service_role;

create or replace function public.is_human_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select p.role = 'admin'::public.app_role and p.is_bot = false
        from public.profiles p
       where p.id = auth.uid()
    ),
    false
  );
$$;

comment on function public.is_human_admin() is
  'True only for a non-bot admin. is_admin() stays true for bot admins so reads keep working. AAL2 is not consulted.';

revoke execute on function public.guard_profile_bot_identity() from public, anon, authenticated;
revoke execute on function public.sync_profile_bot_app_metadata() from public, anon, authenticated;
revoke execute on function public.is_human_admin() from public, anon;
grant execute on function public.is_human_admin() to authenticated, service_role;

-- Stamp existing humans, including the operator profile, as not bots.
-- Values do not change, so the guard allows it; the mirror writes
-- raw_app_meta_data.is_bot = false and bot_key = null.
update public.profiles set is_bot = is_bot;


-- Product allowlist. bot-production may approve ideas, media, and campaign
-- plans. bot-sales may approve a lead-magnet version. Slot approval, proof
-- artifacts, production-release decisions, publishing, distribution, and
-- delivery are not on this list.
create or replace function public.bot_may(p_action text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = auth.uid()
       and p.is_bot
       and (p.bot_key, p_action) in (
         ('bot-production', 'approve_content'),
         ('bot-sales', 'approve_lead_magnet')
       )
  );
$$;

comment on function public.bot_may(text) is
  'True only when the caller is a bot whose bot_key is allowed this action. Humans are false. AAL2 is not consulted.';

revoke execute on function public.bot_may(text) from public, anon;
grant execute on function public.bot_may(text) to authenticated, service_role;

-- Purge a bot's GoTrue sessions. service_role only, and only for is_bot.
-- GoTrue has no admin logout-by-user-id route, so the provisioner calls this.
create or replace function public.revoke_bot_sessions(p_user_id uuid)
returns table (sessions_deleted integer, refresh_tokens_deleted integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sessions integer := 0;
  v_tokens integer := 0;
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'only service_role may revoke bot sessions' using errcode = '42501';
  end if;
  if p_user_id is null or not exists (
    select 1 from public.profiles p
     where p.id = p_user_id and p.is_bot
  ) then
    raise exception 'only a bot account may have sessions revoked here' using errcode = '42501';
  end if;
  delete from auth.refresh_tokens
   where user_id::text = p_user_id::text;
  get diagnostics v_tokens = row_count;
  delete from auth.sessions
   where user_id = p_user_id;
  get diagnostics v_sessions = row_count;
  return query select v_sessions, v_tokens;
end;
$$;

revoke all on function public.revoke_bot_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_bot_sessions(uuid) to service_role;

comment on function public.revoke_bot_sessions(uuid) is
  'Deletes auth.sessions and auth.refresh_tokens for one bot. Refuses every non-bot. service_role only.';

revoke truncate, trigger, references on table public.profiles from public, anon, authenticated;

-- <<end bot-identity>>

-- Extend the exposure inventory when adding a gate, or signed-in definer
-- functions that call only the new gate read as ungated.
create or replace function public.caller_gate_markers()
returns text language sql immutable set search_path to 'public' as $$
  select
    'can_access_client|is_human_admin\(|is_admin\(|auth\.role\(\)|current_role_of|accessible_client_ids'
    || '|may_advance_slot|may_touch_assignment|may_manage_client_leads'
    || '|has_client_sales_entitlement|can_read_client_sales_data|can_read_workflow_lead_attribution'
    || '|advance_slot|advance_assignment'
    || '|require_active_bot|require_bot_client_grant|bot_may\('
$$;

-- <<hard-hold-rpcs>>

-- admin_store_integration_credential (was 20260922120000_124_connected_means_eligible.sql)
create or replace function public.admin_store_integration_credential(
  p_client_id uuid,
  p_provider text,
  p_label text,
  p_secret text,
  p_access_level text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'vault'
as $$
declare
  v_secret uuid;
  v_row    uuid;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not is_human_admin() then
    raise exception 'Admins only';
  end if;

  -- The raw credential goes to Vault and nowhere else; the table only
  -- ever holds the reference.
  v_secret := vault.create_secret(
    p_secret,
    'integration:' || p_client_id::text || ':' || p_provider || ':' || coalesce(p_label, 'default'),
    'AA Console integration credential'
  );

  insert into client_integrations (client_id, provider, credential_label, credential_secret_id, access_level)
  values (p_client_id, p_provider, p_label, v_secret, p_access_level)
  on conflict (client_id, provider, credential_label) do update
    set credential_secret_id = excluded.credential_secret_id,
        access_level = excluded.access_level,
        -- A fresh credential earns a fresh attempt. Leaving the old 'error'
        -- in place means the act of fixing a dead token does not resume the
        -- ingestion the dead token stopped.
        status = 'connected',
        updated_at = now()
  returning id into v_row;

  return v_row;
end;
$$;

-- set_engine_enabled (was 20261005210000_146_engine_settings.sql)
-- The switch is its own function because it is its own decision. It refuses
-- to turn on a client that has nothing to post or nowhere to put it, because
-- an engine that is on and silent looks identical to one that is broken.
create or replace function public.set_engine_enabled(p_client_id uuid, p_enabled boolean)
returns client_engine_settings
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row client_engine_settings;
  v_platforms integer;
  v_windows integer;
  v_pillars integer;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not is_human_admin() then
    raise exception 'Only an admin switches the engine on or off.';
  end if;

  insert into client_engine_settings (client_id) values (p_client_id)
  on conflict (client_id) do nothing;

  if p_enabled then
    select count(*) into v_platforms
      from client_engine_platforms
      where client_id = p_client_id and active and posts_per_week > 0;
    if v_platforms = 0 then
      raise exception 'This client has no active platform with a cadence. The engine would plan nothing.';
    end if;

    select count(*) into v_windows from client_engine_windows where client_id = p_client_id;
    if v_windows = 0 then
      raise exception 'This client has no posting windows. The engine would have nowhere to put a post.';
    end if;

    select count(*) into v_pillars
      from client_content_pillars where client_id = p_client_id and active;
    if v_pillars = 0 then
      raise exception 'This client has no active content pillars. The engine would have nothing to write about.';
    end if;
  end if;

  update client_engine_settings set enabled = p_enabled
  where client_id = p_client_id
  returning * into v_row;
  return v_row;
end;
$$;

-- set_engine_running (was 20261006040000_150_engine_tick.sql)
create or replace function public.set_engine_running(p_enabled boolean, p_note text default null)
returns engine_controls
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row engine_controls;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not is_human_admin() then
    raise exception 'Only an admin starts or stops the engine.';
  end if;
  update engine_controls
     set enabled = p_enabled, note = p_note, updated_at = now(), updated_by = auth.uid()
   where id
  returning * into v_row;
  return v_row;
end;
$$;

-- set_publishing_enabled (was 20261006235000_160_publishing.sql)
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

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

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

-- set_proof_publishing_enabled (was 20261019200000_229_proof_publishing_switch.sql)
create or replace function public.set_proof_publishing_enabled(
  p_client_id uuid, p_enabled boolean)
returns client_engine_settings
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_row client_engine_settings;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;

  insert into client_engine_settings (client_id, proof_publishing_enabled,
                                      proof_publishing_enabled_at, proof_publishing_enabled_by)
  values (p_client_id, p_enabled,
          case when p_enabled then now() end,
          case when p_enabled then auth.uid() end)
  on conflict (client_id) do update
     set proof_publishing_enabled = excluded.proof_publishing_enabled,
         proof_publishing_enabled_at = case when excluded.proof_publishing_enabled
                                            then coalesce(client_engine_settings.proof_publishing_enabled_at, now())
                                            else client_engine_settings.proof_publishing_enabled_at end,
         proof_publishing_enabled_by = case when excluded.proof_publishing_enabled
                                            then coalesce(client_engine_settings.proof_publishing_enabled_by, auth.uid())
                                            else client_engine_settings.proof_publishing_enabled_by end
  returning * into v_row;
  return v_row;
end;
$$;

-- set_campaign_actions_enabled (was 20261022090000_230_campaign_action_executor.sql)
create or replace function public.set_campaign_actions_enabled(
  p_client_id uuid, p_enabled boolean)
returns client_engine_settings
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_row client_engine_settings;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;
  if not (coalesce(public.is_human_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)) then
    raise exception 'Only an admin or the active client manager may change this.'
      using errcode = 'P0001';
  end if;

  insert into client_engine_settings (client_id, campaign_actions_enabled,
                                      campaign_actions_enabled_at, campaign_actions_enabled_by)
  values (p_client_id, p_enabled,
          case when p_enabled then now() end,
          case when p_enabled then auth.uid() end)
  on conflict (client_id) do update
    set campaign_actions_enabled = excluded.campaign_actions_enabled,
        -- Keep the stamp on the way off. Who turned this on is worth more
        -- than when it was last turned off, and 229's reasoning applies.
        campaign_actions_enabled_at = case when excluded.campaign_actions_enabled
          then now() else client_engine_settings.campaign_actions_enabled_at end,
        campaign_actions_enabled_by = case when excluded.campaign_actions_enabled
          then auth.uid() else client_engine_settings.campaign_actions_enabled_by end
  returning * into v_row;
  return v_row;
end;
$$;

-- set_lead_capture_enabled_v6 (was 20261024090000_235_a_lead_can_arrive_from_outside.sql)
create or replace function public.set_lead_capture_enabled_v6(p_endpoint_id uuid, p_enabled boolean)
returns public.lead_capture_endpoints
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_row public.lead_capture_endpoints%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v_row from public.lead_capture_endpoints where id = p_endpoint_id;
  if not found then raise exception 'No such endpoint.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_human_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(v_row.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can change this.'
      using errcode = 'P0001';
  end if;
  update public.lead_capture_endpoints
     set enabled = coalesce(p_enabled, false)
   where id = p_endpoint_id
   returning * into v_row;
  return v_row;
end $$;

-- set_lead_magnet_delivery_enabled (was 20261024100000_236_lead_magnets.sql)
create or replace function public.set_lead_magnet_delivery_enabled(
  p_client_id uuid, p_enabled boolean)
returns client_engine_settings
language plpgsql security definer
set search_path to 'public' as $$
declare v_row client_engine_settings;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;
  if not (coalesce(public.is_human_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)) then
    raise exception 'Only an admin or the active client manager may change this.'
      using errcode = 'P0001';
  end if;
  insert into client_engine_settings (client_id, lead_magnet_delivery_enabled,
    lead_magnet_delivery_enabled_at, lead_magnet_delivery_enabled_by)
  values (p_client_id, p_enabled, case when p_enabled then now() end,
          case when p_enabled then auth.uid() end)
  on conflict (client_id) do update
    set lead_magnet_delivery_enabled = excluded.lead_magnet_delivery_enabled,
        lead_magnet_delivery_enabled_at = case when excluded.lead_magnet_delivery_enabled
          then now() else client_engine_settings.lead_magnet_delivery_enabled_at end,
        lead_magnet_delivery_enabled_by = case when excluded.lead_magnet_delivery_enabled
          then auth.uid() else client_engine_settings.lead_magnet_delivery_enabled_by end
  returning * into v_row;
  return v_row;
end $$;

-- set_outbound_messaging_enabled (was 20261025130000_248_a_message_can_be_sent_to_a_person.sql)
create or replace function public.set_outbound_messaging_enabled(
  p_client_id uuid, p_enabled boolean)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not coalesce(public.is_human_admin(), false) then
    raise exception 'Only an admin can turn outbound messaging on or off.' using errcode = 'P0001';
  end if;
  insert into public.client_engine_settings (
    client_id, outbound_messaging_enabled, outbound_messaging_enabled_at,
    outbound_messaging_enabled_by)
  values (p_client_id, coalesce(p_enabled, false),
          case when p_enabled then now() else null end,
          case when p_enabled then auth.uid() else null end)
  on conflict (client_id) do update
    set outbound_messaging_enabled = excluded.outbound_messaging_enabled,
        outbound_messaging_enabled_at = excluded.outbound_messaging_enabled_at,
        outbound_messaging_enabled_by = excluded.outbound_messaging_enabled_by;
end $$;

-- set_client_booking_enabled_v6 (was 20261030180000_281_the_configuration_nobody_can_enter.sql)
-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

create or replace function public.set_client_booking_enabled_v6(
  p_client_id uuid,
  p_enabled boolean
) returns public.client_booking_settings
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.client_booking_settings;
  v_windows integer;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  select * into v_row from public.client_booking_settings where client_id = p_client_id;
  if not found then
    raise exception 'Set this client''s booking rules before switching booking on.';
  end if;

  if p_enabled then
    select count(*) into v_windows
      from public.client_booking_windows where client_id = p_client_id;
    if v_windows = 0 then
      raise exception 'This client has no bookable hours recorded, so switching booking on would offer slots that do not exist.';
    end if;
  end if;

  update public.client_booking_settings
     set enabled = p_enabled, updated_at = now()
   where client_id = p_client_id
  returning * into v_row;

  return v_row;
end $$;

-- set_client_engine_budget_v6 (was 20261030190000_282_the_engines_own_configuration.sql)
-- B066-adjacent / 282: the engine's own configuration, and a readiness line
-- that does not lie.
--
-- The autonomous loop is already built and already running. `engine_tick()`
-- fires hourly on cron, plans slots from the client's platforms, pillars and
-- posting windows, then walks every live slot through `slot_pipeline` --
-- ideation, idea_select, brief, creative_build or video_build, video_edit,
-- copywriter, qa -- queueing the right agent for each stage and stopping at
-- `awaiting_approval`, which is the distribution boundary. Nine stages, all
-- mapped, all implemented.
--
-- Every tick for the last several hours recorded the same note:
--
--   "The engine is switched off globally."
--
-- So nothing was broken. The loop was faithful and had nothing it was
-- allowed to do. It has three gates, and two of them had no writer anywhere
-- in the system -- not a function, not a policy, not a screen.
--
-- WHAT HAD NO WAY IN
--
-- `client_engine_budgets.cap_usd` for the current month. `engine_tick` skips
-- any client with no cap for the month it is running in, and says so. It is
-- also the only blocker `engine_readiness` was reporting, which made it the
-- one thing an operator was told to fix and could not. Nothing wrote this
-- table: it appears in the generated types and in tests, and nowhere else.
--
-- `clients.timezone`. It decides which local day and hour a planned slot
-- lands on, and 281's booking windows are read in the client's zone too. AA
-- has carried `Europe/London` while operating on UTC+2, so every slot this
-- engine planned would have been two hours out. No function or screen set it.
--
-- WHY THE READINESS LINE COULD SAY "RUNNING" WHILE NOTHING RAN
--
-- `engine_readiness` checked configuration, the client switch and the cap,
-- and never the global switch. With the cap set and the client switched on it
-- would read "Running" while `engine_controls.enabled` was false and the tick
-- refused every hour. An operator would have had no way to tell from the
-- screen that the thing it called running was stopped.
--
-- It also never showed whether the pipeline can advance without a person.
-- `approve_idea_by_policy` raises "This client has not switched on policy
-- approval of ideas" when `auto_approve_ideas` is off, so a slot reaches
-- `ideating`, the selector fails, and the slot parks at the second of nine
-- stages. The same holds for briefs. A client can therefore be "Running" and
-- still need a person at stage two, which is the opposite of what the word
-- implies. Both flags are now on the row, so the screen can say so.
--
-- WHAT THIS DOES NOT DO
--
-- It sets nothing and switches nothing on. It adds the two writers that were
-- missing and makes the readiness row tell the whole truth. The global
-- switch, the client switch and the policy-approval flags keep their existing
-- writers, which require a signed-in person, because each of them is a
-- decision that should carry a name.

-- ---------------------------------------------------------------------------
-- The monthly spend cap
-- ---------------------------------------------------------------------------

create or replace function public.set_client_engine_budget_v6(
  p_client_id uuid,
  p_month date,
  p_cap_usd numeric,
  p_note text default null
) returns public.client_engine_budgets
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.client_engine_budgets;
  v_month date := date_trunc('month', coalesce(p_month, current_date))::date;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  if p_cap_usd is null or p_cap_usd <= 0 then
    raise exception 'A spend cap has to be a positive amount. A cap of zero stops the engine rather than configuring it; switch the client off instead.';
  end if;

  -- The engine spends against this figure without asking again, so a typed
  -- extra zero is the realistic mistake and it is worth refusing rather than
  -- discovering in a provider bill.
  if p_cap_usd > 10000 then
    raise exception 'A monthly cap above 10000 USD needs a deliberate change to this limit. Received %.', p_cap_usd;
  end if;

  -- A cap for a month already gone cannot restrain anything: the engine only
  -- ever reads the month it is ticking in.
  if v_month < date_trunc('month', current_date)::date then
    raise exception 'That month has already passed. A cap can only be set for the current month or a later one.';
  end if;

  insert into public.client_engine_budgets as b (client_id, month, cap_usd, note)
  values (p_client_id, v_month, p_cap_usd, nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (client_id, month) do update
     set cap_usd = excluded.cap_usd,
         note = coalesce(excluded.note, b.note),
         updated_at = now()
  returning b.* into v_row;

  return v_row;
end $$;

-- delete_recruitment_ad (was 20260926110000_133_recruitment_meta_distribution.sql)
-- A selected image is part of the recorded Meta build. Keep its source and
-- brief available for retries, and give a clear refusal instead of an FK error.
create or replace function public.delete_recruitment_ad(p_brief_id uuid)
returns table (deleted_assets integer)
language plpgsql security definer set search_path = public as $$
declare v_brief client_briefs%rowtype; v_count integer;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not is_human_admin() then raise exception 'Only an admin can delete a recruitment ad.'; end if;
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

-- delete_client_idea (was 20260921120000_109_delete_campaign_and_idea.sql)
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

create or replace function public.delete_client_idea(p_idea_id uuid)
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

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not is_human_admin() then
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

-- delete_client_campaign (was 20260921120000_109_delete_campaign_and_idea.sql)
-- ---------------------------------------------------------------------------
-- delete_client_campaign
-- ---------------------------------------------------------------------------

create or replace function public.delete_client_campaign(p_campaign_id uuid)
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

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not is_human_admin() then
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

-- delete_content_asset_v6 (was 20261019140000_223_archive_and_terminate_content.sql)
-- ---------------------------------------------------------------------------
-- The end of an asset
-- ---------------------------------------------------------------------------

create or replace function public.delete_content_asset_v6(p_asset_id uuid)
returns table (
  deleted_frames integer,
  deleted_copy integer,
  deleted_posts integer,
  deleted_files integer
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_asset client_media_assets;
  v_paths text[];
  v_held text;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v_asset from client_media_assets where id = p_asset_id;
  if v_asset.id is null then
    raise exception 'No such asset.' using errcode = 'P0001';
  end if;
  if not can_access_client(v_asset.client_id) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;

  -- The holds that are right to refuse. Named, with the reason, rather than
  -- left to arrive as a foreign key violation nobody can act on.
  if to_regclass('public.proof_placements') is not null then
    execute 'select ''a proof placement'' from proof_placements where asset_id = $1 limit 1'
      into v_held using p_asset_id;
    if v_held is not null then
      raise exception 'This asset is named by % and may be live somewhere public. Retract the placement first.', v_held
        using errcode = 'P0001';
    end if;
  end if;
  if to_regclass('public.proof_production_requests') is not null then
    execute 'select ''a proof production request'' from proof_production_requests where source_asset_id = $1 limit 1'
      into v_held using p_asset_id;
    if v_held is not null then
      raise exception 'This asset is the source of % and cannot be deleted while that record stands.', v_held
        using errcode = 'P0001';
    end if;
  end if;

  -- Every file this asset owns: its own, its render, and each frame's.
  select array_remove(array_agg(path), null) into v_paths from (
    select v_asset.storage_path as path
    union all select v_asset.render_path
    union all select f.storage_path from client_media_frames f where f.asset_id = p_asset_id
  ) files;

  with gone as (delete from client_media_frames where asset_id = p_asset_id returning 1)
    select count(*)::int into deleted_frames from gone;
  with gone as (delete from post_copy where asset_id = p_asset_id returning 1)
    select count(*)::int into deleted_copy from gone;
  with gone as (delete from scheduled_posts where asset_id = p_asset_id returning 1)
    select count(*)::int into deleted_posts from gone;
  delete from client_asset_reviews where asset_id = p_asset_id;

  -- The bucket. Guarded because the storage schema belongs to Supabase and is
  -- absent in a bare test database; a termination that cannot reach it should
  -- still remove the rows rather than fail halfway.
  deleted_files := 0;
  if to_regclass('storage.objects') is not null and coalesce(array_length(v_paths, 1), 0) > 0 then
    execute 'with gone as (delete from storage.objects where bucket_id = ''client-media'' and name = any($1) returning 1) select count(*)::int from gone'
      into deleted_files using v_paths;
  end if;

  delete from client_media_assets where id = p_asset_id;
  return next;
end;
$$;

-- delete_content_brief_v6 (was 20261019140000_223_archive_and_terminate_content.sql)
-- ---------------------------------------------------------------------------
-- The end of a brief, and everything made from it
-- ---------------------------------------------------------------------------

-- Same scope as delete_client_idea, one stage down: a brief is not a record
-- worth keeping once the thing it described is gone, and leaving its assets
-- behind would orphan files nobody can find from any screen.
create or replace function public.delete_content_brief_v6(p_brief_id uuid)
returns table (
  deleted_frames integer,
  deleted_copy integer,
  deleted_posts integer,
  deleted_files integer
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid;
  v_asset uuid;
  v_one record;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select client_id into v_client from client_briefs where id = p_brief_id;
  if v_client is null then
    raise exception 'No such brief.' using errcode = 'P0001';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;

  deleted_frames := 0; deleted_copy := 0; deleted_posts := 0; deleted_files := 0;
  for v_asset in select id from client_media_assets where brief_id = p_brief_id loop
    -- Each asset goes through the same door, so a held one refuses the whole
    -- delete rather than leaving a brief with one asset still attached.
    select * into v_one from public.delete_content_asset_v6(v_asset);
    deleted_frames := deleted_frames + v_one.deleted_frames;
    deleted_copy := deleted_copy + v_one.deleted_copy;
    deleted_posts := deleted_posts + v_one.deleted_posts;
    deleted_files := deleted_files + v_one.deleted_files;
  end loop;

  delete from client_briefs where id = p_brief_id;
  return next;
end;
$$;

-- request_client_sales_entitlement (was 20261029180000_267_sales_entitlement_boundary.sql)
create or replace function public.request_client_sales_entitlement(
  p_client_id uuid, p_member_id uuid, p_action text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_id uuid;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() <> 'authenticated' or not public.is_human_admin() then
    raise exception 'Only an administrator may request sales access.';
  end if;
  if p_action is null or p_action not in ('grant', 'revoke') then
    raise exception 'Choose grant or revoke.';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'Client does not exist.';
  end if;
  if p_action = 'grant' then
    select tm.user_id into v_user_id
      from public.team_members tm
      join public.profiles p on p.id = tm.user_id
     where tm.id = p_member_id and tm.active and p.role = 'employee';
    if v_user_id is null then
      raise exception 'Choose an active team member with an employee account.';
    end if;
  else
    -- A departed or relinked member still needs an auditable revocation.
    select e.bound_user_id into v_user_id
      from public.client_sales_entitlements e
     where e.client_id = p_client_id and e.member_id = p_member_id
       and e.revoked_at is null;
    if v_user_id is null then
      raise exception 'This member has no current sales grant for this client.';
    end if;
  end if;
  insert into public.client_sales_entitlement_requests (
    client_id, member_id, bound_user_id, action, scope_hash, requested_by
  ) values (
    p_client_id, p_member_id, v_user_id, p_action,
    public.sales_entitlement_scope_hash(p_client_id,p_member_id,v_user_id,p_action), auth.uid()
  ) returning id into v_id;
  return v_id;
end;
$$;

-- decide_client_sales_entitlement (was 20261029180000_267_sales_entitlement_boundary.sql)
create or replace function public.decide_client_sales_entitlement(
  p_request_id uuid, p_scope_hash text, p_approve boolean, p_note text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_req public.client_sales_entitlement_requests%rowtype;
  v_user_id uuid;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or
  -- can_access_client gate. service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() <> 'authenticated' or not public.is_human_admin() then
    raise exception 'Only an administrator may decide sales access.';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'MFA assurance level aal2 is required to decide sales access.';
  end if;
  if p_approve is null then
    raise exception 'Choose approve or reject.';
  end if;
  select * into v_req from public.client_sales_entitlement_requests
   where id = p_request_id for update;
  if not found or v_req.status <> 'pending' then
    raise exception 'This sales access request is no longer pending.';
  end if;
  if p_scope_hash is distinct from v_req.scope_hash or v_req.scope_hash <>
     public.sales_entitlement_scope_hash(v_req.client_id,v_req.member_id,v_req.bound_user_id,v_req.action) then
    raise exception 'The exact sales access scope changed. Request a new decision.';
  end if;
  -- Rejection must remain possible after retirement or account relinking;
  -- otherwise a stale pending grant cannot be closed or replaced.
  if p_approve and v_req.action = 'grant' then
    select tm.user_id into v_user_id
      from public.team_members tm
      join public.profiles p on p.id = tm.user_id
     where tm.id = v_req.member_id and tm.active and p.role = 'employee';
    if v_user_id is distinct from v_req.bound_user_id then
      raise exception 'The team member identity changed. Request a new decision.';
    end if;
  end if;
  if p_approve and v_req.action = 'grant' then
    insert into public.client_sales_entitlements (
      client_id,member_id,bound_user_id,grant_request_id,approved_scope_hash,granted_by
    ) values (
      v_req.client_id,v_req.member_id,v_req.bound_user_id,v_req.id,v_req.scope_hash,auth.uid()
    ) on conflict (client_id,member_id) do update
      set bound_user_id = excluded.bound_user_id,
          grant_request_id = excluded.grant_request_id,
          approved_scope_hash = excluded.approved_scope_hash,
          inbox_decision_id = null,
          granted_at = now(), granted_by = auth.uid(),
          revoked_at = null, revoked_by = null, revoke_request_id = null;
  elsif p_approve and v_req.action = 'revoke' then
    update public.client_sales_entitlements
       set revoked_at = now(), revoked_by = auth.uid(), revoke_request_id = v_req.id,
           inbox_decision_id = null
     where client_id = v_req.client_id and member_id = v_req.member_id
       and bound_user_id = v_req.bound_user_id and revoked_at is null;
    if not found then
      raise exception 'The sales grant changed. Request a new decision.';
    end if;
  end if;
  update public.client_sales_entitlement_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note),'')
   where id = v_req.id;
end;
$$;

-- <<end hard-hold-rpcs>>

-- <<rls-split>>
-- FOR ALL policies whose predicate is only is_admin() become a read for every
-- admin and writes for human admins. Mixed OR policies and bucket-scoped
-- storage policies are intentionally not rewritten here.

-- public.profiles.profiles_admin_all (from 20260903104450_01_foundations_roles_clients.sql)
drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all_select on public.profiles
  for select to authenticated using (public.is_admin());
create policy profiles_admin_all_insert on public.profiles
  for insert to authenticated with check (public.is_human_admin());
create policy profiles_admin_all_update on public.profiles
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy profiles_admin_all_delete on public.profiles
  for delete to authenticated using (public.is_human_admin());

-- public.clients.clients_admin_all (from 20260903104450_01_foundations_roles_clients.sql)
drop policy if exists clients_admin_all on public.clients;
create policy clients_admin_all_select on public.clients
  for select to authenticated using (public.is_admin());
create policy clients_admin_all_insert on public.clients
  for insert to authenticated with check (public.is_human_admin());
create policy clients_admin_all_update on public.clients
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy clients_admin_all_delete on public.clients
  for delete to authenticated using (public.is_human_admin());

-- public.client_users.client_users_admin_all (from 20260903104450_01_foundations_roles_clients.sql)
drop policy if exists client_users_admin_all on public.client_users;
create policy client_users_admin_all_select on public.client_users
  for select to authenticated using (public.is_admin());
create policy client_users_admin_all_insert on public.client_users
  for insert to authenticated with check (public.is_human_admin());
create policy client_users_admin_all_update on public.client_users
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy client_users_admin_all_delete on public.client_users
  for delete to authenticated using (public.is_human_admin());

-- public.team_members.team_members_admin_all (from 20260903104529_02_team_and_operations.sql)
drop policy if exists team_members_admin_all on public.team_members;
create policy team_members_admin_all_select on public.team_members
  for select to authenticated using (public.is_admin());
create policy team_members_admin_all_insert on public.team_members
  for insert to authenticated with check (public.is_human_admin());
create policy team_members_admin_all_update on public.team_members
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy team_members_admin_all_delete on public.team_members
  for delete to authenticated using (public.is_human_admin());

-- public.job_assignments.job_assignments_admin_all (from 20260903104529_02_team_and_operations.sql)
drop policy if exists job_assignments_admin_all on public.job_assignments;
create policy job_assignments_admin_all_select on public.job_assignments
  for select to authenticated using (public.is_admin());
create policy job_assignments_admin_all_insert on public.job_assignments
  for insert to authenticated with check (public.is_human_admin());
create policy job_assignments_admin_all_update on public.job_assignments
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy job_assignments_admin_all_delete on public.job_assignments
  for delete to authenticated using (public.is_human_admin());

-- public.client_assignments.client_assignments_admin_all (from 20260903104529_02_team_and_operations.sql)
drop policy if exists client_assignments_admin_all on public.client_assignments;
create policy client_assignments_admin_all_select on public.client_assignments
  for select to authenticated using (public.is_admin());
create policy client_assignments_admin_all_insert on public.client_assignments
  for insert to authenticated with check (public.is_human_admin());
create policy client_assignments_admin_all_update on public.client_assignments
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy client_assignments_admin_all_delete on public.client_assignments
  for delete to authenticated using (public.is_human_admin());

-- public.work_logs.work_logs_admin_all (from 20260903104529_02_team_and_operations.sql)
drop policy if exists work_logs_admin_all on public.work_logs;
create policy work_logs_admin_all_select on public.work_logs
  for select to authenticated using (public.is_admin());
create policy work_logs_admin_all_insert on public.work_logs
  for insert to authenticated with check (public.is_human_admin());
create policy work_logs_admin_all_update on public.work_logs
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy work_logs_admin_all_delete on public.work_logs
  for delete to authenticated using (public.is_human_admin());

-- public.contract_payments.contract_payments_admin_all (from 20260903104529_02_team_and_operations.sql)
drop policy if exists contract_payments_admin_all on public.contract_payments;
create policy contract_payments_admin_all_select on public.contract_payments
  for select to authenticated using (public.is_admin());
create policy contract_payments_admin_all_insert on public.contract_payments
  for insert to authenticated with check (public.is_human_admin());
create policy contract_payments_admin_all_update on public.contract_payments
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy contract_payments_admin_all_delete on public.contract_payments
  for delete to authenticated using (public.is_human_admin());

-- public.agents.agents_admin_all (from 20260903104615_03_agent_registry_and_job_queue.sql)
drop policy if exists agents_admin_all on public.agents;
create policy agents_admin_all_select on public.agents
  for select to authenticated using (public.is_admin());
create policy agents_admin_all_insert on public.agents
  for insert to authenticated with check (public.is_human_admin());
create policy agents_admin_all_update on public.agents
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy agents_admin_all_delete on public.agents
  for delete to authenticated using (public.is_human_admin());

-- public.agent_jobs.agent_jobs_admin_all (from 20260903104615_03_agent_registry_and_job_queue.sql)
drop policy if exists agent_jobs_admin_all on public.agent_jobs;
create policy agent_jobs_admin_all_select on public.agent_jobs
  for select to authenticated using (public.is_admin());
create policy agent_jobs_admin_all_insert on public.agent_jobs
  for insert to authenticated with check (public.is_human_admin());
create policy agent_jobs_admin_all_update on public.agent_jobs
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy agent_jobs_admin_all_delete on public.agent_jobs
  for delete to authenticated using (public.is_human_admin());

-- public.agent_job_events.agent_job_events_admin_all (from 20260903104615_03_agent_registry_and_job_queue.sql)
drop policy if exists agent_job_events_admin_all on public.agent_job_events;
create policy agent_job_events_admin_all_select on public.agent_job_events
  for select to authenticated using (public.is_admin());
create policy agent_job_events_admin_all_insert on public.agent_job_events
  for insert to authenticated with check (public.is_human_admin());
create policy agent_job_events_admin_all_update on public.agent_job_events
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy agent_job_events_admin_all_delete on public.agent_job_events
  for delete to authenticated using (public.is_human_admin());

-- public.client_business_context.cbc_admin_all (from 20260903104724_04_intelligence_and_strategy.sql)
drop policy if exists cbc_admin_all on public.client_business_context;
create policy cbc_admin_all_select on public.client_business_context
  for select to authenticated using (public.is_admin());
create policy cbc_admin_all_insert on public.client_business_context
  for insert to authenticated with check (public.is_human_admin());
create policy cbc_admin_all_update on public.client_business_context
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cbc_admin_all_delete on public.client_business_context
  for delete to authenticated using (public.is_human_admin());

-- public.client_agent_inputs.cai_admin_all (from 20260903104724_04_intelligence_and_strategy.sql)
drop policy if exists cai_admin_all on public.client_agent_inputs;
create policy cai_admin_all_select on public.client_agent_inputs
  for select to authenticated using (public.is_admin());
create policy cai_admin_all_insert on public.client_agent_inputs
  for insert to authenticated with check (public.is_human_admin());
create policy cai_admin_all_update on public.client_agent_inputs
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cai_admin_all_delete on public.client_agent_inputs
  for delete to authenticated using (public.is_human_admin());

-- public.client_agent_records.car_admin_all (from 20260903104724_04_intelligence_and_strategy.sql)
drop policy if exists car_admin_all on public.client_agent_records;
create policy car_admin_all_select on public.client_agent_records
  for select to authenticated using (public.is_admin());
create policy car_admin_all_insert on public.client_agent_records
  for insert to authenticated with check (public.is_human_admin());
create policy car_admin_all_update on public.client_agent_records
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy car_admin_all_delete on public.client_agent_records
  for delete to authenticated using (public.is_human_admin());

-- public.record_templates.record_templates_admin_all (from 20260903104724_04_intelligence_and_strategy.sql)
drop policy if exists record_templates_admin_all on public.record_templates;
create policy record_templates_admin_all_select on public.record_templates
  for select to authenticated using (public.is_admin());
create policy record_templates_admin_all_insert on public.record_templates
  for insert to authenticated with check (public.is_human_admin());
create policy record_templates_admin_all_update on public.record_templates
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy record_templates_admin_all_delete on public.record_templates
  for delete to authenticated using (public.is_human_admin());

-- public.client_proof_assets.cpa_admin_all (from 20260903104816_05_content_chain_proof_ideas_briefs_media.sql)
drop policy if exists cpa_admin_all on public.client_proof_assets;
create policy cpa_admin_all_select on public.client_proof_assets
  for select to authenticated using (public.is_admin());
create policy cpa_admin_all_insert on public.client_proof_assets
  for insert to authenticated with check (public.is_human_admin());
create policy cpa_admin_all_update on public.client_proof_assets
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cpa_admin_all_delete on public.client_proof_assets
  for delete to authenticated using (public.is_human_admin());

-- public.client_ideas.ci_admin_all (from 20260903104816_05_content_chain_proof_ideas_briefs_media.sql)
drop policy if exists ci_admin_all on public.client_ideas;
create policy ci_admin_all_select on public.client_ideas
  for select to authenticated using (public.is_admin());
create policy ci_admin_all_insert on public.client_ideas
  for insert to authenticated with check (public.is_human_admin());
create policy ci_admin_all_update on public.client_ideas
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy ci_admin_all_delete on public.client_ideas
  for delete to authenticated using (public.is_human_admin());

-- public.client_briefs.cb_admin_all (from 20260903104816_05_content_chain_proof_ideas_briefs_media.sql)
drop policy if exists cb_admin_all on public.client_briefs;
create policy cb_admin_all_select on public.client_briefs
  for select to authenticated using (public.is_admin());
create policy cb_admin_all_insert on public.client_briefs
  for insert to authenticated with check (public.is_human_admin());
create policy cb_admin_all_update on public.client_briefs
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cb_admin_all_delete on public.client_briefs
  for delete to authenticated using (public.is_human_admin());

-- public.client_media_assets.cma_admin_all (from 20260903104816_05_content_chain_proof_ideas_briefs_media.sql)
drop policy if exists cma_admin_all on public.client_media_assets;
create policy cma_admin_all_select on public.client_media_assets
  for select to authenticated using (public.is_admin());
create policy cma_admin_all_insert on public.client_media_assets
  for insert to authenticated with check (public.is_human_admin());
create policy cma_admin_all_update on public.client_media_assets
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cma_admin_all_delete on public.client_media_assets
  for delete to authenticated using (public.is_human_admin());

-- public.client_asset_reviews.cars_admin_all (from 20260903104816_05_content_chain_proof_ideas_briefs_media.sql)
drop policy if exists cars_admin_all on public.client_asset_reviews;
create policy cars_admin_all_select on public.client_asset_reviews
  for select to authenticated using (public.is_admin());
create policy cars_admin_all_insert on public.client_asset_reviews
  for insert to authenticated with check (public.is_human_admin());
create policy cars_admin_all_update on public.client_asset_reviews
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cars_admin_all_delete on public.client_asset_reviews
  for delete to authenticated using (public.is_human_admin());

-- public.ref_counters.ref_counters_admin_all (from 20260903104816_05_content_chain_proof_ideas_briefs_media.sql)
drop policy if exists ref_counters_admin_all on public.ref_counters;
create policy ref_counters_admin_all_select on public.ref_counters
  for select to authenticated using (public.is_admin());
create policy ref_counters_admin_all_insert on public.ref_counters
  for insert to authenticated with check (public.is_human_admin());
create policy ref_counters_admin_all_update on public.ref_counters
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy ref_counters_admin_all_delete on public.ref_counters
  for delete to authenticated using (public.is_human_admin());

-- public.scheduled_posts.sp_admin_all (from 20260903104850_06_distribution_conversion_leads.sql)
drop policy if exists sp_admin_all on public.scheduled_posts;
create policy sp_admin_all_select on public.scheduled_posts
  for select to authenticated using (public.is_admin());
create policy sp_admin_all_insert on public.scheduled_posts
  for insert to authenticated with check (public.is_human_admin());
create policy sp_admin_all_update on public.scheduled_posts
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy sp_admin_all_delete on public.scheduled_posts
  for delete to authenticated using (public.is_human_admin());

-- public.client_pages.cp_admin_all (from 20260903104850_06_distribution_conversion_leads.sql)
drop policy if exists cp_admin_all on public.client_pages;
create policy cp_admin_all_select on public.client_pages
  for select to authenticated using (public.is_admin());
create policy cp_admin_all_insert on public.client_pages
  for insert to authenticated with check (public.is_human_admin());
create policy cp_admin_all_update on public.client_pages
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cp_admin_all_delete on public.client_pages
  for delete to authenticated using (public.is_human_admin());

-- public.client_leads.cl_admin_all (from 20260903104850_06_distribution_conversion_leads.sql)
drop policy if exists cl_admin_all on public.client_leads;
create policy cl_admin_all_select on public.client_leads
  for select to authenticated using (public.is_admin());
create policy cl_admin_all_insert on public.client_leads
  for insert to authenticated with check (public.is_human_admin());
create policy cl_admin_all_update on public.client_leads
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cl_admin_all_delete on public.client_leads
  for delete to authenticated using (public.is_human_admin());

-- public.client_onboarding_steps.cos_admin_all (from 20260903104939_07_account_and_admin.sql)
drop policy if exists cos_admin_all on public.client_onboarding_steps;
create policy cos_admin_all_select on public.client_onboarding_steps
  for select to authenticated using (public.is_admin());
create policy cos_admin_all_insert on public.client_onboarding_steps
  for insert to authenticated with check (public.is_human_admin());
create policy cos_admin_all_update on public.client_onboarding_steps
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cos_admin_all_delete on public.client_onboarding_steps
  for delete to authenticated using (public.is_human_admin());

-- public.client_integrations.cint_admin_all (from 20260903104939_07_account_and_admin.sql)
drop policy if exists cint_admin_all on public.client_integrations;
create policy cint_admin_all_select on public.client_integrations
  for select to authenticated using (public.is_admin());
create policy cint_admin_all_insert on public.client_integrations
  for insert to authenticated with check (public.is_human_admin());
create policy cint_admin_all_update on public.client_integrations
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cint_admin_all_delete on public.client_integrations
  for delete to authenticated using (public.is_human_admin());

-- public.client_contracts.cc_admin_all (from 20260903104939_07_account_and_admin.sql)
drop policy if exists cc_admin_all on public.client_contracts;
create policy cc_admin_all_select on public.client_contracts
  for select to authenticated using (public.is_admin());
create policy cc_admin_all_insert on public.client_contracts
  for insert to authenticated with check (public.is_human_admin());
create policy cc_admin_all_update on public.client_contracts
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cc_admin_all_delete on public.client_contracts
  for delete to authenticated using (public.is_human_admin());

-- public.client_billing.cbill_admin_all (from 20260903104939_07_account_and_admin.sql)
drop policy if exists cbill_admin_all on public.client_billing;
create policy cbill_admin_all_select on public.client_billing
  for select to authenticated using (public.is_admin());
create policy cbill_admin_all_insert on public.client_billing
  for insert to authenticated with check (public.is_human_admin());
create policy cbill_admin_all_update on public.client_billing
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cbill_admin_all_delete on public.client_billing
  for delete to authenticated using (public.is_human_admin());

-- public.client_audit_notes.can_admin_all (from 20260903104939_07_account_and_admin.sql)
drop policy if exists can_admin_all on public.client_audit_notes;
create policy can_admin_all_select on public.client_audit_notes
  for select to authenticated using (public.is_admin());
create policy can_admin_all_insert on public.client_audit_notes
  for insert to authenticated with check (public.is_human_admin());
create policy can_admin_all_update on public.client_audit_notes
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy can_admin_all_delete on public.client_audit_notes
  for delete to authenticated using (public.is_human_admin());

-- public.sops.sops_admin_all (from 20260903104939_07_account_and_admin.sql)
drop policy if exists sops_admin_all on public.sops;
create policy sops_admin_all_select on public.sops
  for select to authenticated using (public.is_admin());
create policy sops_admin_all_insert on public.sops
  for insert to authenticated with check (public.is_human_admin());
create policy sops_admin_all_update on public.sops
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy sops_admin_all_delete on public.sops
  for delete to authenticated using (public.is_human_admin());

-- public.finance_periods.fp_admin_all (from 20260903104939_07_account_and_admin.sql)
drop policy if exists fp_admin_all on public.finance_periods;
create policy fp_admin_all_select on public.finance_periods
  for select to authenticated using (public.is_admin());
create policy fp_admin_all_insert on public.finance_periods
  for insert to authenticated with check (public.is_human_admin());
create policy fp_admin_all_update on public.finance_periods
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy fp_admin_all_delete on public.finance_periods
  for delete to authenticated using (public.is_human_admin());

-- public.finance_entries.fe_admin_all (from 20260903104939_07_account_and_admin.sql)
drop policy if exists fe_admin_all on public.finance_entries;
create policy fe_admin_all_select on public.finance_entries
  for select to authenticated using (public.is_admin());
create policy fe_admin_all_insert on public.finance_entries
  for insert to authenticated with check (public.is_human_admin());
create policy fe_admin_all_update on public.finance_entries
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy fe_admin_all_delete on public.finance_entries
  for delete to authenticated using (public.is_human_admin());

-- public.team_channels.tc_admin_all (from 20260903105011_08_team_chat_and_storage_buckets.sql)
drop policy if exists tc_admin_all on public.team_channels;
create policy tc_admin_all_select on public.team_channels
  for select to authenticated using (public.is_admin());
create policy tc_admin_all_insert on public.team_channels
  for insert to authenticated with check (public.is_human_admin());
create policy tc_admin_all_update on public.team_channels
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy tc_admin_all_delete on public.team_channels
  for delete to authenticated using (public.is_human_admin());

-- public.campaigns.campaigns_admin_all (from 20260904080405_14_campaigns.sql)
drop policy if exists campaigns_admin_all on public.campaigns;
create policy campaigns_admin_all_select on public.campaigns
  for select to authenticated using (public.is_admin());
create policy campaigns_admin_all_insert on public.campaigns
  for insert to authenticated with check (public.is_human_admin());
create policy campaigns_admin_all_update on public.campaigns
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy campaigns_admin_all_delete on public.campaigns
  for delete to authenticated using (public.is_human_admin());

-- public.channel_members.cm_admin_all (from 20260904084217_16_chat_channel_members.sql)
drop policy if exists cm_admin_all on public.channel_members;
create policy cm_admin_all_select on public.channel_members
  for select to authenticated using (public.is_admin());
create policy cm_admin_all_insert on public.channel_members
  for insert to authenticated with check (public.is_human_admin());
create policy cm_admin_all_update on public.channel_members
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cm_admin_all_delete on public.channel_members
  for delete to authenticated using (public.is_human_admin());

-- public.master_ai_conversations.master_ai_conversations_admin (from 20260905081711_29_master_ai.sql)
drop policy if exists master_ai_conversations_admin on public.master_ai_conversations;
create policy master_ai_conversations_admin_select on public.master_ai_conversations
  for select to authenticated using (public.is_admin());
create policy master_ai_conversations_admin_insert on public.master_ai_conversations
  for insert to authenticated with check (public.is_human_admin());
create policy master_ai_conversations_admin_update on public.master_ai_conversations
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy master_ai_conversations_admin_delete on public.master_ai_conversations
  for delete to authenticated using (public.is_human_admin());

-- public.master_ai_messages.master_ai_messages_admin (from 20260905081711_29_master_ai.sql)
drop policy if exists master_ai_messages_admin on public.master_ai_messages;
create policy master_ai_messages_admin_select on public.master_ai_messages
  for select to authenticated using (public.is_admin());
create policy master_ai_messages_admin_insert on public.master_ai_messages
  for insert to authenticated with check (public.is_human_admin());
create policy master_ai_messages_admin_update on public.master_ai_messages
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy master_ai_messages_admin_delete on public.master_ai_messages
  for delete to authenticated using (public.is_human_admin());

-- public.metrics_daily.metrics_daily_admin_all (from 20260905090029_32_metrics_ingest_foundations.sql)
drop policy if exists metrics_daily_admin_all on public.metrics_daily;
create policy metrics_daily_admin_all_select on public.metrics_daily
  for select to authenticated using (public.is_admin());
create policy metrics_daily_admin_all_insert on public.metrics_daily
  for insert to authenticated with check (public.is_human_admin());
create policy metrics_daily_admin_all_update on public.metrics_daily
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy metrics_daily_admin_all_delete on public.metrics_daily
  for delete to authenticated using (public.is_human_admin());

-- public.creative_generations.creative_generations_admin_all (from 20260905131703_39_brief_build_pipeline.sql)
drop policy if exists creative_generations_admin_all on public.creative_generations;
create policy creative_generations_admin_all_select on public.creative_generations
  for select to authenticated using (public.is_admin());
create policy creative_generations_admin_all_insert on public.creative_generations
  for insert to authenticated with check (public.is_human_admin());
create policy creative_generations_admin_all_update on public.creative_generations
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy creative_generations_admin_all_delete on public.creative_generations
  for delete to authenticated using (public.is_human_admin());

-- public.brief_dispatches.brief_dispatches_admin_all (from 20260905131703_39_brief_build_pipeline.sql)
drop policy if exists brief_dispatches_admin_all on public.brief_dispatches;
create policy brief_dispatches_admin_all_select on public.brief_dispatches
  for select to authenticated using (public.is_admin());
create policy brief_dispatches_admin_all_insert on public.brief_dispatches
  for insert to authenticated with check (public.is_human_admin());
create policy brief_dispatches_admin_all_update on public.brief_dispatches
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy brief_dispatches_admin_all_delete on public.brief_dispatches
  for delete to authenticated using (public.is_human_admin());

-- public.creative_renders.creative_renders_admin_all (from 20260905143029_42_creative_renders.sql)
drop policy if exists creative_renders_admin_all on public.creative_renders;
create policy creative_renders_admin_all_select on public.creative_renders
  for select to authenticated using (public.is_admin());
create policy creative_renders_admin_all_insert on public.creative_renders
  for insert to authenticated with check (public.is_human_admin());
create policy creative_renders_admin_all_update on public.creative_renders
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy creative_renders_admin_all_delete on public.creative_renders
  for delete to authenticated using (public.is_human_admin());

-- public.client_contact_details.ccd_admin_all (from 20260906200228_49_client_contact_details.sql)
drop policy if exists ccd_admin_all on public.client_contact_details;
create policy ccd_admin_all_select on public.client_contact_details
  for select to authenticated using (public.is_admin());
create policy ccd_admin_all_insert on public.client_contact_details
  for insert to authenticated with check (public.is_human_admin());
create policy ccd_admin_all_update on public.client_contact_details
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy ccd_admin_all_delete on public.client_contact_details
  for delete to authenticated using (public.is_human_admin());

-- public.client_brand_profiles.cbp_admin_all (from 20260907130000_53_client_brand_profiles.sql)
drop policy if exists cbp_admin_all on public.client_brand_profiles;
create policy cbp_admin_all_select on public.client_brand_profiles
  for select to authenticated using (public.is_admin());
create policy cbp_admin_all_insert on public.client_brand_profiles
  for insert to authenticated with check (public.is_human_admin());
create policy cbp_admin_all_update on public.client_brand_profiles
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cbp_admin_all_delete on public.client_brand_profiles
  for delete to authenticated using (public.is_human_admin());

-- public.lead_events.le_admin_all (from 20260908030000_60_revenue_pipeline.sql)
drop policy if exists le_admin_all on public.lead_events;
create policy le_admin_all_select on public.lead_events
  for select to authenticated using (public.is_admin());
create policy le_admin_all_insert on public.lead_events
  for insert to authenticated with check (public.is_human_admin());
create policy le_admin_all_update on public.lead_events
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy le_admin_all_delete on public.lead_events
  for delete to authenticated using (public.is_human_admin());

-- public.client_sales_agents.csa_admin_all (from 20260908192515_67_sales_agents.sql)
drop policy if exists csa_admin_all on public.client_sales_agents;
create policy csa_admin_all_select on public.client_sales_agents
  for select to authenticated using (public.is_admin());
create policy csa_admin_all_insert on public.client_sales_agents
  for insert to authenticated with check (public.is_human_admin());
create policy csa_admin_all_update on public.client_sales_agents
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy csa_admin_all_delete on public.client_sales_agents
  for delete to authenticated using (public.is_human_admin());

-- public.sales_agent_conversations.sac_admin_all (from 20260908192515_67_sales_agents.sql)
drop policy if exists sac_admin_all on public.sales_agent_conversations;
create policy sac_admin_all_select on public.sales_agent_conversations
  for select to authenticated using (public.is_admin());
create policy sac_admin_all_insert on public.sales_agent_conversations
  for insert to authenticated with check (public.is_human_admin());
create policy sac_admin_all_update on public.sales_agent_conversations
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy sac_admin_all_delete on public.sales_agent_conversations
  for delete to authenticated using (public.is_human_admin());

-- public.client_campaigns.cc_admin_all (from 20260909020000_72_campaign_execution.sql)
drop policy if exists cc_admin_all on public.client_campaigns;
create policy cc_admin_all_select on public.client_campaigns
  for select to authenticated using (public.is_admin());
create policy cc_admin_all_insert on public.client_campaigns
  for insert to authenticated with check (public.is_human_admin());
create policy cc_admin_all_update on public.client_campaigns
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cc_admin_all_delete on public.client_campaigns
  for delete to authenticated using (public.is_human_admin());

-- public.campaign_artifacts.cart_admin_all (from 20260909020000_72_campaign_execution.sql)
drop policy if exists cart_admin_all on public.campaign_artifacts;
create policy cart_admin_all_select on public.campaign_artifacts
  for select to authenticated using (public.is_admin());
create policy cart_admin_all_insert on public.campaign_artifacts
  for insert to authenticated with check (public.is_human_admin());
create policy cart_admin_all_update on public.campaign_artifacts
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cart_admin_all_delete on public.campaign_artifacts
  for delete to authenticated using (public.is_human_admin());

-- public.client_marketing_spend.cms_admin_all (from 20260911205529_79_client_marketing_spend.sql)
drop policy if exists cms_admin_all on public.client_marketing_spend;
create policy cms_admin_all_select on public.client_marketing_spend
  for select to authenticated using (public.is_admin());
create policy cms_admin_all_insert on public.client_marketing_spend
  for insert to authenticated with check (public.is_human_admin());
create policy cms_admin_all_update on public.client_marketing_spend
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cms_admin_all_delete on public.client_marketing_spend
  for delete to authenticated using (public.is_human_admin());

-- public.github_app_installations.gai_admin_all (from 20260912000000_80_site_deployment.sql)
drop policy if exists gai_admin_all on public.github_app_installations;
create policy gai_admin_all_select on public.github_app_installations
  for select to authenticated using (public.is_admin());
create policy gai_admin_all_insert on public.github_app_installations
  for insert to authenticated with check (public.is_human_admin());
create policy gai_admin_all_update on public.github_app_installations
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy gai_admin_all_delete on public.github_app_installations
  for delete to authenticated using (public.is_human_admin());

-- public.client_site_repositories.csr_admin_all (from 20260912000000_80_site_deployment.sql)
drop policy if exists csr_admin_all on public.client_site_repositories;
create policy csr_admin_all_select on public.client_site_repositories
  for select to authenticated using (public.is_admin());
create policy csr_admin_all_insert on public.client_site_repositories
  for insert to authenticated with check (public.is_human_admin());
create policy csr_admin_all_update on public.client_site_repositories
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy csr_admin_all_delete on public.client_site_repositories
  for delete to authenticated using (public.is_human_admin());

-- public.client_sales_agent_deployments.csad_admin_all (from 20260912000000_80_site_deployment.sql)
drop policy if exists csad_admin_all on public.client_sales_agent_deployments;
create policy csad_admin_all_select on public.client_sales_agent_deployments
  for select to authenticated using (public.is_admin());
create policy csad_admin_all_insert on public.client_sales_agent_deployments
  for insert to authenticated with check (public.is_human_admin());
create policy csad_admin_all_update on public.client_sales_agent_deployments
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy csad_admin_all_delete on public.client_sales_agent_deployments
  for delete to authenticated using (public.is_human_admin());

-- public.client_page_revisions.cpr_admin_all (from 20260913000000_82_page_revisions.sql)
drop policy if exists cpr_admin_all on public.client_page_revisions;
create policy cpr_admin_all_select on public.client_page_revisions
  for select to authenticated using (public.is_admin());
create policy cpr_admin_all_insert on public.client_page_revisions
  for insert to authenticated with check (public.is_human_admin());
create policy cpr_admin_all_update on public.client_page_revisions
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cpr_admin_all_delete on public.client_page_revisions
  for delete to authenticated using (public.is_human_admin());

-- public.client_page_findings.cpf_admin_all (from 20260913000000_82_page_revisions.sql)
drop policy if exists cpf_admin_all on public.client_page_findings;
create policy cpf_admin_all_select on public.client_page_findings
  for select to authenticated using (public.is_admin());
create policy cpf_admin_all_insert on public.client_page_findings
  for insert to authenticated with check (public.is_human_admin());
create policy cpf_admin_all_update on public.client_page_findings
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cpf_admin_all_delete on public.client_page_findings
  for delete to authenticated using (public.is_human_admin());

-- public.client_content_pillars.ccp_admin_all (from 20260920190000_102_content_pillars.sql)
drop policy if exists ccp_admin_all on public.client_content_pillars;
create policy ccp_admin_all_select on public.client_content_pillars
  for select to authenticated using (public.is_admin());
create policy ccp_admin_all_insert on public.client_content_pillars
  for insert to authenticated with check (public.is_human_admin());
create policy ccp_admin_all_update on public.client_content_pillars
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy ccp_admin_all_delete on public.client_content_pillars
  for delete to authenticated using (public.is_human_admin());

-- public.campaign_content_pillars.ccpil_admin_all (from 20260920210000_104_campaign_pillars.sql)
drop policy if exists ccpil_admin_all on public.campaign_content_pillars;
create policy ccpil_admin_all_select on public.campaign_content_pillars
  for select to authenticated using (public.is_admin());
create policy ccpil_admin_all_insert on public.campaign_content_pillars
  for insert to authenticated with check (public.is_human_admin());
create policy ccpil_admin_all_update on public.campaign_content_pillars
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy ccpil_admin_all_delete on public.campaign_content_pillars
  for delete to authenticated using (public.is_human_admin());

-- public.client_media_frames.cmf_admin_all (from 20260921010000_109_content_formats.sql)
drop policy if exists cmf_admin_all on public.client_media_frames;
create policy cmf_admin_all_select on public.client_media_frames
  for select to authenticated using (public.is_admin());
create policy cmf_admin_all_insert on public.client_media_frames
  for insert to authenticated with check (public.is_human_admin());
create policy cmf_admin_all_update on public.client_media_frames
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cmf_admin_all_delete on public.client_media_frames
  for delete to authenticated using (public.is_human_admin());

-- public.lead_identities.lead_identities_admin_all (from 20260925121000_129_lead_pipeline_archive.sql)
drop policy if exists lead_identities_admin_all on public.lead_identities;
create policy lead_identities_admin_all_select on public.lead_identities
  for select to authenticated using (public.is_admin());
create policy lead_identities_admin_all_insert on public.lead_identities
  for insert to authenticated with check (public.is_human_admin());
create policy lead_identities_admin_all_update on public.lead_identities
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy lead_identities_admin_all_delete on public.lead_identities
  for delete to authenticated using (public.is_human_admin());

-- public.archived_leads.archived_leads_admin_all (from 20260925121000_129_lead_pipeline_archive.sql)
drop policy if exists archived_leads_admin_all on public.archived_leads;
create policy archived_leads_admin_all_select on public.archived_leads
  for select to authenticated using (public.is_admin());
create policy archived_leads_admin_all_insert on public.archived_leads
  for insert to authenticated with check (public.is_human_admin());
create policy archived_leads_admin_all_update on public.archived_leads
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy archived_leads_admin_all_delete on public.archived_leads
  for delete to authenticated using (public.is_human_admin());

-- public.recruitment_meta_campaigns.recruitment_meta_campaigns_admin (from 20260926110000_133_recruitment_meta_distribution.sql)
drop policy if exists recruitment_meta_campaigns_admin on public.recruitment_meta_campaigns;
create policy recruitment_meta_campaigns_admin_select on public.recruitment_meta_campaigns
  for select to authenticated using (public.is_admin());
create policy recruitment_meta_campaigns_admin_insert on public.recruitment_meta_campaigns
  for insert to authenticated with check (public.is_human_admin());
create policy recruitment_meta_campaigns_admin_update on public.recruitment_meta_campaigns
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy recruitment_meta_campaigns_admin_delete on public.recruitment_meta_campaigns
  for delete to authenticated using (public.is_human_admin());

-- public.recruitment_meta_campaign_ads.recruitment_meta_campaign_ads_admin (from 20260926110000_133_recruitment_meta_distribution.sql)
drop policy if exists recruitment_meta_campaign_ads_admin on public.recruitment_meta_campaign_ads;
create policy recruitment_meta_campaign_ads_admin_select on public.recruitment_meta_campaign_ads
  for select to authenticated using (public.is_admin());
create policy recruitment_meta_campaign_ads_admin_insert on public.recruitment_meta_campaign_ads
  for insert to authenticated with check (public.is_human_admin());
create policy recruitment_meta_campaign_ads_admin_update on public.recruitment_meta_campaign_ads
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy recruitment_meta_campaign_ads_admin_delete on public.recruitment_meta_campaign_ads
  for delete to authenticated using (public.is_human_admin());

-- public.client_engine_budgets.client_engine_budgets_admin (from 20261004140000_142_client_spend_caps.sql)
drop policy if exists client_engine_budgets_admin on public.client_engine_budgets;
create policy client_engine_budgets_admin_select on public.client_engine_budgets
  for select to authenticated using (public.is_admin());
create policy client_engine_budgets_admin_insert on public.client_engine_budgets
  for insert to authenticated with check (public.is_human_admin());
create policy client_engine_budgets_admin_update on public.client_engine_budgets
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy client_engine_budgets_admin_delete on public.client_engine_budgets
  for delete to authenticated using (public.is_human_admin());

-- public.post_copy.post_copy_admin_all (from 20261005190000_145_post_copy.sql)
drop policy if exists post_copy_admin_all on public.post_copy;
create policy post_copy_admin_all_select on public.post_copy
  for select to authenticated using (public.is_admin());
create policy post_copy_admin_all_insert on public.post_copy
  for insert to authenticated with check (public.is_human_admin());
create policy post_copy_admin_all_update on public.post_copy
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy post_copy_admin_all_delete on public.post_copy
  for delete to authenticated using (public.is_human_admin());

-- public.client_engine_settings.ces_admin_all (from 20261005210000_146_engine_settings.sql)
drop policy if exists ces_admin_all on public.client_engine_settings;
create policy ces_admin_all_select on public.client_engine_settings
  for select to authenticated using (public.is_admin());
create policy ces_admin_all_insert on public.client_engine_settings
  for insert to authenticated with check (public.is_human_admin());
create policy ces_admin_all_update on public.client_engine_settings
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy ces_admin_all_delete on public.client_engine_settings
  for delete to authenticated using (public.is_human_admin());

-- public.client_engine_platforms.cep_admin_all (from 20261005210000_146_engine_settings.sql)
drop policy if exists cep_admin_all on public.client_engine_platforms;
create policy cep_admin_all_select on public.client_engine_platforms
  for select to authenticated using (public.is_admin());
create policy cep_admin_all_insert on public.client_engine_platforms
  for insert to authenticated with check (public.is_human_admin());
create policy cep_admin_all_update on public.client_engine_platforms
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cep_admin_all_delete on public.client_engine_platforms
  for delete to authenticated using (public.is_human_admin());

-- public.client_engine_windows.cew_admin_all (from 20261005210000_146_engine_settings.sql)
drop policy if exists cew_admin_all on public.client_engine_windows;
create policy cew_admin_all_select on public.client_engine_windows
  for select to authenticated using (public.is_admin());
create policy cew_admin_all_insert on public.client_engine_windows
  for insert to authenticated with check (public.is_human_admin());
create policy cew_admin_all_update on public.client_engine_windows
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy cew_admin_all_delete on public.client_engine_windows
  for delete to authenticated using (public.is_human_admin());

-- public.engine_controls.ec_admin (from 20261006040000_150_engine_tick.sql)
drop policy if exists ec_admin on public.engine_controls;
create policy ec_admin_select on public.engine_controls
  for select to authenticated using (public.is_admin());
create policy ec_admin_insert on public.engine_controls
  for insert to authenticated with check (public.is_human_admin());
create policy ec_admin_update on public.engine_controls
  for update to authenticated using (public.is_human_admin()) with check (public.is_human_admin());
create policy ec_admin_delete on public.engine_controls
  for delete to authenticated using (public.is_human_admin());


-- Admin-or-manager writes: the admin branch is human-only. The manager
-- branch is unchanged. Bots are not managers, so they do not take that branch.

-- public.proof_capture_configs.proof_capture_write
drop policy if exists proof_capture_write on public.proof_capture_configs;
create policy proof_capture_write_select on public.proof_capture_configs
  for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy proof_capture_write_insert on public.proof_capture_configs
  for insert to authenticated
  with check (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy proof_capture_write_update on public.proof_capture_configs
  for update to authenticated
  using (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id))
  with check (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy proof_capture_write_delete on public.proof_capture_configs
  for delete to authenticated
  using (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));

-- public.client_proof_destinations.client_proof_destinations_write
drop policy if exists client_proof_destinations_write on public.client_proof_destinations;
create policy client_proof_destinations_write_select on public.client_proof_destinations
  for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy client_proof_destinations_write_insert on public.client_proof_destinations
  for insert to authenticated
  with check (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy client_proof_destinations_write_update on public.client_proof_destinations
  for update to authenticated
  using (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id))
  with check (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy client_proof_destinations_write_delete on public.client_proof_destinations
  for delete to authenticated
  using (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));

-- public.client_google_locations.client_google_locations_write
drop policy if exists client_google_locations_write on public.client_google_locations;
create policy client_google_locations_write_select on public.client_google_locations
  for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy client_google_locations_write_insert on public.client_google_locations
  for insert to authenticated
  with check (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy client_google_locations_write_update on public.client_google_locations
  for update to authenticated
  using (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id))
  with check (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy client_google_locations_write_delete on public.client_google_locations
  for delete to authenticated
  using (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));

-- public.motion_scenes.motion_scenes_write
drop policy if exists motion_scenes_write on public.motion_scenes;
create policy motion_scenes_write_select on public.motion_scenes
  for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy motion_scenes_write_insert on public.motion_scenes
  for insert to authenticated
  with check (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy motion_scenes_write_update on public.motion_scenes
  for update to authenticated
  using (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id))
  with check (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy motion_scenes_write_delete on public.motion_scenes
  for delete to authenticated
  using (public.is_human_admin() or auth.uid() = public.active_video_approval_manager(client_id));

-- storage.objects admin gates. Reads stay is_admin(). Admin writes are human
-- admins. client-media uploads are also closed to bots by
-- media_obj_employee_insert below: can_access_client() is true for every
-- admin, including a bot, so that insert policy has to exclude is_bot.
-- proof client inserts stay a client policy. Per-tab bot uploads are follow-on.

drop policy if exists sops_obj_admin_all on storage.objects;
create policy sops_obj_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'sops' and public.is_admin());
create policy sops_obj_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'sops' and public.is_human_admin());
create policy sops_obj_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'sops' and public.is_human_admin())
  with check (bucket_id = 'sops' and public.is_human_admin());
create policy sops_obj_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'sops' and public.is_human_admin());

drop policy if exists contracts_obj_admin_all on storage.objects;
create policy contracts_obj_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'contracts' and public.is_admin());
create policy contracts_obj_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'contracts' and public.is_human_admin());
create policy contracts_obj_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'contracts' and public.is_human_admin())
  with check (bucket_id = 'contracts' and public.is_human_admin());
create policy contracts_obj_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'contracts' and public.is_human_admin());

drop policy if exists media_obj_admin_all on storage.objects;
create policy media_obj_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'client-media' and public.is_admin());
create policy media_obj_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'client-media' and public.is_human_admin());
create policy media_obj_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'client-media' and public.is_human_admin())
  with check (bucket_id = 'client-media' and public.is_human_admin());
create policy media_obj_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'client-media' and public.is_human_admin());

drop policy if exists proof_obj_admin_all on storage.objects;
create policy proof_obj_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'proof' and public.is_admin());
create policy proof_obj_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'proof' and public.is_human_admin());
create policy proof_obj_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'proof' and public.is_human_admin())
  with check (bucket_id = 'proof' and public.is_human_admin());
create policy proof_obj_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'proof' and public.is_human_admin());


-- Employee upload into a client folder. A bot admin also passes
-- can_access_client(), so is_bot is excluded explicitly.
drop policy if exists media_obj_employee_insert on storage.objects;
create policy media_obj_employee_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'client-media'
    and public.can_access_client(public.try_uuid((storage.foldername(name))[1]))
    and not exists (
      select 1 from public.profiles p
       where p.id = auth.uid() and p.is_bot
    )
  );

-- Offer Studio create. The read policy is unchanged. A bot admin cannot insert.
drop policy if exists service_offers_create on public.service_offers;
create policy service_offers_create on public.service_offers
  for insert to authenticated
  with check (
    coalesce(public.is_human_admin(), false)
    or auth.uid() = public.active_video_approval_manager(client_id)
  );

-- <<end rls-split>>

-- <<approval-decisions>>
-- AAL2 is not a human check. These decision RPCs refuse a bot before the
-- assurance step. Manager branches stay. service_role callers are unchanged.

-- record_approval_decision_v6 (was 20261030110000_273_canonical_approval_ledger.sql)
-- This is a recording gate, not the owning decision. An adapter calls it
-- after its source transition and while that transaction can still roll back.
create or replace function public.record_approval_decision_v6(
  p_request_id uuid, p_decision text, p_artifact_hash text,
  p_source_decision_ref text, p_reason text default null
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_evidence public.approval_request_evidence_v6%rowtype;
  v_existing public.approval_decision_events_v6%rowtype;
  v_latest public.approval_decision_events_v6%rowtype;
  v_hash text;
  v_blocker text;
  v_id uuid;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'A provisioned human with AAL2 must decide this approval.'
      using errcode = '42501';
  end if;
  if p_decision not in ('approved','rejected','revoked') or p_decision is null
    or nullif(btrim(coalesce(p_source_decision_ref, '')), '') is null
    or (p_decision <> 'approved' and nullif(btrim(coalesce(p_reason, '')), '') is null) then
    raise exception 'A valid decision, source reference and reason are required.'
      using errcode = '22023';
  end if;
  select * into v_request from public.approval_requests_v6
    where id = p_request_id for update;
  if not found then raise exception 'Approval request not found.' using errcode = 'P0002'; end if;
  if v_request.client_id is null then
    if not coalesce(public.is_human_admin(), false) then
      raise exception 'Only an admin may decide agency-wide approvals.' using errcode = '42501';
    end if;
  elsif not public.can_review_approval_request_v6(v_request.client_id, v_request.owner_role) then
    raise exception 'Not the decision owner for this client.' using errcode = '42501';
  end if;

  select * into v_evidence from public.approval_request_evidence_v6
    where request_id = p_request_id;
  v_hash := coalesce(v_evidence.artifact_hash, v_request.artifact_hash);
  if p_artifact_hash is distinct from v_hash then
    raise exception 'The exact artifact hash changed; request a new approval.'
      using errcode = '23514';
  end if;

  select * into v_existing from public.approval_decision_events_v6
    where request_id = p_request_id and source_decision_ref = btrim(p_source_decision_ref);
  if found then
    if v_existing.decision = p_decision and v_existing.actor_id = auth.uid()
      and v_existing.artifact_hash is not distinct from p_artifact_hash
      and v_existing.reason is not distinct from nullif(btrim(p_reason), '') then
      return v_existing.id;
    end if;
    raise exception 'Source decision reference already belongs to another decision.'
      using errcode = '23505';
  end if;

  select * into v_latest from public.approval_decision_events_v6
    where request_id = p_request_id order by event_order desc limit 1;
  if p_decision = 'revoked' then
    if v_latest.decision is distinct from 'approved' then
      raise exception 'Only an approved request can be revoked.' using errcode = '23514';
    end if;
  elsif v_latest.id is not null then
    raise exception 'This approval request has already been decided.' using errcode = '23514';
  elsif p_decision = 'approved'
    and v_request.expires_at is not null
    and v_request.expires_at <= clock_timestamp() then
    raise exception 'This approval request has expired.' using errcode = '23514';
  end if;

  if p_decision = 'approved' then
    select i.preview_blocker into v_blocker from public.approval_inbox_v6 i
      where i.id = p_request_id;
    if v_blocker is not null or v_request.expires_at is null then
      raise exception 'Incomplete exact-version evidence: %',
        coalesce(v_blocker, 'expiry missing') using errcode = '23514';
    end if;
  end if;
  insert into public.approval_decision_events_v6 (
    request_id,decision,actor_id,actor_aal,artifact_hash,
    source_decision_ref,reason
  ) values (
    p_request_id,p_decision,auth.uid(),'aal2',v_hash,
    btrim(p_source_decision_ref),nullif(btrim(p_reason), '')
  ) returning id into v_id;
  return v_id;
end;
$$;

-- sales_entitlement_inbox_request_guard_v6 (was 20261030130000_275_sales_entitlement_inbox_binding.sql)
create or replace function public.sales_entitlement_inbox_request_guard_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' then
      raise exception 'Sales entitlement requests must start pending for exact Inbox review.'
        using errcode = '23514';
    end if;
    select c.name into new.client_name_snapshot from public.clients c
      where c.id = new.client_id;
    select tm.name into new.member_name_snapshot from public.team_members tm
      where tm.id = new.member_id;
    if nullif(btrim(coalesce(new.client_name_snapshot, '')), '') is null
      or nullif(btrim(coalesce(new.member_name_snapshot, '')), '') is null then
      raise exception 'Sales entitlement requires a named client and team member.';
    end if;
    return new;
  end if;
  if old.id is distinct from new.id
    or old.client_id is distinct from new.client_id
    or old.member_id is distinct from new.member_id
    or old.bound_user_id is distinct from new.bound_user_id
    or old.action is distinct from new.action
    or old.scope_hash is distinct from new.scope_hash
    or old.requested_by is distinct from new.requested_by
    or old.requested_at is distinct from new.requested_at
    or old.client_name_snapshot is distinct from new.client_name_snapshot
    or old.member_name_snapshot is distinct from new.member_name_snapshot
    or old.status <> 'pending'
    or new.status not in ('approved','rejected')
    or new.decided_at is null or new.decided_by is distinct from auth.uid() then
    raise exception 'Sales entitlement request identity and decision are immutable.';
  end if;
  if auth.role() is distinct from 'authenticated'
    or auth.uid() is null or not coalesce(public.is_human_admin(),false)
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'An admin with AAL2 must decide sales access.';
  end if;
  if new.scope_hash <> public.sales_entitlement_scope_hash(
    new.client_id,new.member_id,new.bound_user_id,new.action) then
    raise exception 'Sales access scope changed. Request a new decision.';
  end if;
  if new.status = 'rejected'
    and nullif(btrim(coalesce(new.decision_note,'')), '') is null then
    raise exception 'Rejection needs a reason.';
  end if;
  return new;
end;
$$;

-- approve_recruitment_brief (was 20261030140000_276_recruitment_brief_inbox.sql)
create or replace function public.approve_recruitment_brief(p_brief_id uuid)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_brief public.client_briefs%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not coalesce(public.is_human_admin(), false)
    or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'A provisioned human admin with AAL2 must approve the recruitment brief.'
      using errcode = '42501';
  end if;
  select * into v_brief from public.client_briefs where id = p_brief_id for update;
  if not found then raise exception 'That brief does not exist.' using errcode = 'P0002'; end if;
  if v_brief.purpose <> 'recruitment' then
    raise exception 'That is not a recruitment brief.' using errcode = '23514';
  end if;
  if v_brief.status <> 'draft' then
    raise exception 'Only a draft recruitment brief can be approved.' using errcode = '23514';
  end if;
  if v_brief.archived_at is not null then
    raise exception 'An archived recruitment draft cannot be approved.' using errcode = '23514';
  end if;
  update public.client_briefs set status = 'approved' where id = p_brief_id;
end;
$$;

-- approve_recruitment_brief_from_inbox_v6 (was 20261030140000_276_recruitment_brief_inbox.sql)
-- The user supplies the card they actually reviewed. Lock the brief, prove
-- the card still describes its complete current bytes, then invoke the owning
-- source approval in the same transaction. The trigger consumes this context
-- and rejects any direct UPDATE or legacy ID-only call.
create or replace function public.approve_recruitment_brief_from_inbox_v6(
  p_brief_id uuid, p_request_id uuid,
  p_expected_source_version text, p_expected_artifact_hash text
) returns void language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_brief public.client_briefs%rowtype;
  v_request public.approval_requests_v6%rowtype;
  v_hash text;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not coalesce(public.is_human_admin(), false)
    or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'A provisioned human admin with AAL2 must approve the recruitment brief.'
      using errcode = '42501';
  end if;
  select * into v_brief from public.client_briefs
    where id = p_brief_id for update;
  if not found or v_brief.purpose <> 'recruitment'
    or v_brief.status <> 'draft' or v_brief.archived_at is not null then
    raise exception 'Only an active recruitment draft can be approved.'
      using errcode = '23514';
  end if;
  v_hash := public.recruitment_brief_snapshot_hash_v6(v_brief);
  select * into v_request from public.approval_requests_v6
    where id = p_request_id;
  if not found or v_request.source_system <> 'aa_console'
    or v_request.source_kind <> 'recruitment_brief'
    or v_request.source_id <> p_brief_id::text
    or v_request.client_id is distinct from v_brief.client_id
    or v_request.source_version is distinct from p_expected_source_version
    or v_request.artifact_hash is distinct from p_expected_artifact_hash
    or v_request.artifact_hash is distinct from v_hash
    or v_request.preview is distinct from public.recruitment_brief_snapshot_v6(v_brief)
    or v_request.preview_blocker is not null
    or v_request.expires_at is null or v_request.expires_at <= now()
    or exists (select 1 from public.approval_decision_events_v6 d
      where d.request_id = p_request_id) then
    raise exception 'The selected recruitment card is stale or incomplete; review the current exact version.'
      using errcode = '23514';
  end if;
  insert into approval_private.recruitment_brief_decision_context_v6
    (transaction_id,brief_id,request_id,source_version,artifact_hash,actor_id)
    values (txid_current(),p_brief_id,p_request_id,p_expected_source_version,v_hash,auth.uid());
  perform public.approve_recruitment_brief(p_brief_id);
  delete from approval_private.recruitment_brief_decision_context_v6
    where transaction_id=txid_current() and brief_id=p_brief_id;
end;
$$;

-- decide_google_review_reply_v6 (was 20261024140000_240_google_business_profile.sql)
create or replace function public.decide_google_review_reply_v6(
  p_reply_id uuid, p_approved boolean, p_reason text default null)
returns public.google_review_replies language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_reply public.google_review_replies%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v_reply from public.google_review_replies where id = p_reply_id for update;
  if not found then raise exception 'No such reply.' using errcode = 'P0001'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_human_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_reply.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must decide this.'
      using errcode = 'P0001';
  end if;
  if v_reply.status not in ('drafted', 'awaiting_approval') then
    raise exception 'That reply is %, not waiting for a decision.', v_reply.status
      using errcode = 'P0001';
  end if;
  -- The words may have been edited since they were read.
  if v_reply.body_hash <> encode(sha256(convert_to(v_reply.body, 'UTF8')), 'hex') then
    raise exception 'This reply was edited after it was read. Draft it again.' using errcode = 'P0001';
  end if;

  if not coalesce(p_approved, false) then
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Say why it was rejected.' using errcode = 'P0001';
    end if;
    update public.google_review_replies
       set status = 'rejected', rejection_reason = btrim(p_reason)
     where id = p_reply_id returning * into v_reply;
    return v_reply;
  end if;

  update public.google_review_replies
     set status = 'approved', approved_by = auth.uid(), approved_at = now()
   where id = p_reply_id returning * into v_reply;
  return v_reply;
end $$;

-- decide_google_review_reply_from_inbox_v6 (was 20261030150000_278_google_review_reply_inbox.sql)
-- The old owning RPC takes only a reply ID. A stale Inbox card must never
-- approve newly edited words. The wrapper locks the source, checks the exact
-- version selected by the human, then invokes that same owning RPC. Revoke
-- direct browser execution so every page uses the version-bound path.
create or replace function public.decide_google_review_reply_from_inbox_v6(
  p_reply_id uuid, p_expected_source_version text,
  p_expected_artifact_hash text, p_approved boolean,
  p_reason text default null
) returns public.google_review_replies language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  v_reply public.google_review_replies%rowtype;
  v_payload jsonb;
  v_request public.approval_requests_v6%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'A provisioned human with AAL2 must decide this reply.'
      using errcode = '42501';
  end if;
  select * into v_reply from public.google_review_replies
    where id = p_reply_id for update;
  if not found or v_reply.status not in ('drafted', 'awaiting_approval') then
    raise exception 'That reply is not waiting for a decision.' using errcode = '23514';
  end if;
  v_payload := public.google_reply_inbox_payload_v6(v_reply);
  if p_expected_source_version is distinct from v_payload->>'source_version'
    or p_expected_artifact_hash is distinct from v_payload->>'artifact_hash' then
    raise exception 'The selected reply card is stale; review the new exact version.'
      using errcode = '23514';
  end if;
  select * into v_request from public.approval_requests_v6
    where source_system = 'aa_console'
      and source_kind = 'google_review_reply'
      and source_id = p_reply_id::text
      and source_version = p_expected_source_version;
  if not found or v_request.artifact_hash is distinct from p_expected_artifact_hash
    or v_request.preview is distinct from v_payload->'preview'
    or v_request.destination is distinct from v_payload->>'destination'
    or v_request.account_ref is distinct from v_payload->>'account_ref'
    or v_request.scope is distinct from v_payload->'scope' then
    raise exception 'The selected reply card no longer matches the source.'
      using errcode = '23514';
  end if;
  if p_approved and v_payload->>'preview_blocker' is not null then
    raise exception 'The Google reply is not decision-ready: %',
      v_payload->>'preview_blocker' using errcode = '23514';
  end if;
  return public.decide_google_review_reply_v6(p_reply_id, p_approved, p_reason);
end;
$$;

-- record_console_auth_sender_verification_v6 (was 20261101032000_288_console_invitation_decision_and_send.sql)
create or replace function public.record_console_auth_sender_verification_v6(
  p_sender_email text, p_supabase_url_origin text,
  p_redirect_origin text, p_template_subject text, p_template_body text,
  p_evidence_ref text, p_evidence_sha256 text
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare v_id uuid;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal','') <> 'aal2'
    or not public.is_human_admin() then
    raise exception 'A provisioned admin with AAL2 must attest Auth SMTP settings.'
      using errcode = '42501';
  end if;
  if p_sender_email is null or p_sender_email <> lower(btrim(p_sender_email))
    or p_sender_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_supabase_url_origin !~ '^https://[^/]+$'
    or p_redirect_origin !~ '^https://[^/]+$'
    or length(btrim(coalesce(p_template_subject,''))) not between 1 and 500
    or length(btrim(coalesce(p_template_body,''))) not between 1 and 20000
    or nullif(btrim(coalesce(p_evidence_ref,'')),'') is null
    or length(p_evidence_ref) > 500
    or p_evidence_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Exact sender, project, redirect and retained read-back evidence are required.'
      using errcode = '22023';
  end if;
  insert into public.console_auth_sender_verifications_v6 (
    sender_email,supabase_url_origin,redirect_origin,
    template_subject,template_body,template_sha256,evidence_ref,
    evidence_sha256,verified_by,expires_at
  ) values (
    p_sender_email,p_supabase_url_origin,p_redirect_origin,
    p_template_subject,p_template_body,
    encode(sha256(convert_to(jsonb_build_object(
      'subject',p_template_subject,'body',p_template_body)::text,'UTF8')),'hex'),
    btrim(p_evidence_ref),p_evidence_sha256,auth.uid(),now()+interval '30 days'
  ) returning id into v_id;
  return v_id;
end;
$$;

-- decide_console_invitation_v6 (was 20261101032000_288_console_invitation_decision_and_send.sql)
create or replace function public.decide_console_invitation_v6(
  p_request_id uuid, p_expected_source_version text,
  p_expected_artifact_hash text, p_approved boolean, p_reason text default null
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.console_invitation_requests_v6%rowtype;
  v_card public.approval_requests_v6%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal','') <> 'aal2'
    or not public.is_human_admin() then
    raise exception 'A provisioned admin with AAL2 must decide this invitation.'
      using errcode = '42501';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
  if v_request.status <> 'requested'
    or v_request.payload_hash is distinct from p_expected_source_version
    or v_request.payload_hash is distinct from p_expected_artifact_hash then
    raise exception 'Invitation state or exact version changed.' using errcode = '23514';
  end if;
  select * into v_card from public.approval_requests_v6
    where source_system = 'auth' and source_kind = 'console_invitation'
      and source_id = v_request.id::text
      and source_version = v_request.payload_hash for update;
  if not found or v_card.artifact_hash is distinct from v_request.payload_hash
    or v_card.preview is distinct from v_request.payload
    or v_card.destination is distinct from v_request.recipient_email
    or v_card.account_ref is distinct from v_request.sender_account then
    raise exception 'The frozen Inbox card does not match this invitation.'
      using errcode = '23514';
  end if;
  if p_approved then
    if v_request.expires_at <= now() then
      raise exception 'Invitation expired.' using errcode = '23514';
    end if;
    if exists (select 1 from auth.users
      where lower(email) = v_request.recipient_email) then
      raise exception 'Auth email now exists; review provenance.' using errcode = '23505';
    end if;
    if v_request.target_role = 'employee' and not exists (
      select 1 from public.team_members where id = v_request.target_member_id
        and active and user_id is null and category = v_request.team_category
        and name = v_request.full_name
        and invitation_generation_v6 = (v_request.payload ->> 'team_member_generation')::bigint
    ) then
      raise exception 'Roster target changed; request a new invitation.' using errcode = '23514';
    end if;
    update public.console_invitation_requests_v6 set status = 'approved'
      where id = v_request.id;
  else
    if nullif(btrim(coalesce(p_reason,'')),'') is null then
      raise exception 'A rejection reason is required.' using errcode = '22023';
    end if;
    update public.console_invitation_requests_v6 set status = 'rejected'
      where id = v_request.id;
  end if;
  perform public.record_approval_decision_v6(v_card.id,
    case when p_approved then 'approved' else 'rejected' end,
    v_request.payload_hash, 'console_invitation:' || v_request.id::text || ':decision',
    p_reason);
  insert into public.console_invitation_events_v6(request_id,state,actor_id,reason)
    values (v_request.id, case when p_approved then 'approved' else 'rejected' end,
      auth.uid(), case when p_approved then null else btrim(p_reason) end);
  select * into v_request from public.console_invitation_requests_v6 where id = p_request_id;
  return v_request;
end;
$$;

-- cancel_console_invitation_v6 (was 20261101032000_288_console_invitation_decision_and_send.sql)
create or replace function public.cancel_console_invitation_v6(
  p_request_id uuid, p_reason text
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.console_invitation_requests_v6%rowtype;
  v_card public.approval_requests_v6%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal','') <> 'aal2'
    or not public.is_human_admin() then
    raise exception 'A provisioned admin with AAL2 must cancel.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A cancellation reason is required.' using errcode = '22023';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found or v_request.status not in ('requested','approved','sent','conflict') then
    raise exception 'Invitation cannot be cancelled from this state.' using errcode = '23514';
  end if;
  select * into v_card from public.approval_requests_v6
    where source_system = 'auth' and source_kind = 'console_invitation'
      and source_id = v_request.id::text and source_version = v_request.payload_hash;
  update public.console_invitation_requests_v6 set status = 'cancelled'
    where id = p_request_id;
  perform public.record_approval_decision_v6(v_card.id,
    case when v_request.status = 'requested' then 'rejected' else 'revoked' end,
    v_request.payload_hash, 'console_invitation:' || v_request.id::text || ':cancel',
    p_reason);
  insert into public.console_invitation_events_v6(request_id,state,actor_id,reason)
    values (v_request.id,'cancelled',auth.uid(),btrim(p_reason));
  select * into v_request from public.console_invitation_requests_v6 where id = p_request_id;
  return v_request;
end;
$$;

-- resolve_console_invitation_uncertain_v6 (was 20261101032000_288_console_invitation_decision_and_send.sql)
-- An in-flight or ambiguous provider outcome remains reserved. Only a human
-- admin who has inspected retained provider evidence may attest that no
-- invitation was issued. The Auth table absence is checked in this transaction.
-- This never retries the external send.
create or replace function public.resolve_console_invitation_uncertain_v6(
  p_request_id uuid, p_expected_hash text, p_evidence_ref text,
  p_evidence_sha256 text, p_reason text
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.console_invitation_requests_v6%rowtype;
  v_card public.approval_requests_v6%rowtype;
  v_claimed_at timestamptz;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal','') <> 'aal2' or not public.is_human_admin() then
    raise exception 'A provisioned admin with AAL2 must resolve an uncertain send.'
      using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_evidence_ref,'')),'') is null
    or length(p_evidence_ref) > 500
    or p_evidence_sha256 !~ '^[0-9a-f]{64}$'
    or nullif(btrim(coalesce(p_reason,'')),'') is null
    or length(p_reason) > 500 then
    raise exception 'Retained provider no-send evidence and reason are required.'
      using errcode = '22023';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found or v_request.status not in ('sending','reconcile')
    or v_request.payload_hash is distinct from p_expected_hash then
    raise exception 'Uncertain invitation state or exact version changed.'
      using errcode = '23514';
  end if;
  select claimed_at into v_claimed_at from public.console_invitation_send_claims_v6
    where request_id = p_request_id;
  if v_claimed_at is null or v_claimed_at > now() - interval '15 minutes' then
    raise exception 'Wait for the provider outcome before resolving this send.'
      using errcode = '23514';
  end if;
  if exists (select 1 from auth.users where lower(email) = v_request.recipient_email) then
    raise exception 'Auth user exists; resolve or disable that identity first.'
      using errcode = '23505';
  end if;
  select * into v_card from public.approval_requests_v6
    where source_system = 'auth' and source_kind = 'console_invitation'
      and source_id = v_request.id::text and source_version = v_request.payload_hash
      and artifact_hash = v_request.payload_hash;
  if not found then
    raise exception 'Exact invitation card is missing.' using errcode = '23514';
  end if;
  update public.console_invitation_requests_v6 set status = 'cancelled'
    where id = p_request_id;
  perform public.record_approval_decision_v6(v_card.id,'revoked',
    v_request.payload_hash,
    'console_invitation:' || v_request.id::text || ':uncertain-resolved',
    'Provider no-send evidence ' || btrim(p_evidence_ref)
      || ' sha256=' || p_evidence_sha256 || '; ' || btrim(p_reason));
  insert into public.console_invitation_events_v6(request_id,state,actor_id,reason)
    values (p_request_id,'cancelled',auth.uid(),
      'no_send:' || btrim(p_evidence_ref) || ':' || p_evidence_sha256);
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id;
  return v_request;
end;
$$;

-- submit_production_release_candidate_v6 (was 20261101050000_291_production_release_candidate_inbox.sql)
create or replace function public.submit_production_release_candidate_v6(
  p_candidate jsonb, p_expires_at timestamptz
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_pr jsonb;
  v_checks jsonb;
  v_migrations jsonb;
  v_schema jsonb;
  v_deployment jsonb;
  v_head text;
  v_base text;
  v_pr_number text;
  v_version text;
  v_id uuid;
  v_check_names text[];
  v_migration_count integer;
  v_last_migration text;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not coalesce(public.is_human_admin(), false)
    or coalesce(auth.jwt()->>'aal', '') <> 'aal2' then
    raise exception 'Only a provisioned admin with AAL2 may submit a release candidate.'
      using errcode = '42501';
  end if;
  if p_expires_at is null or p_expires_at <= clock_timestamp() + interval '5 minutes'
    or p_expires_at > clock_timestamp() + interval '48 hours' then
    raise exception 'Release candidate expiry must be between 5 minutes and 48 hours.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_candidate) is distinct from 'object' then
    raise exception 'Release candidate must be a JSON object.'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_candidate) k
    where k not in ('repository','pr','checks','migrations','schema',
      'deployment','switch_plan','rollback')
  ) then
    raise exception 'Release candidate has an invalid root shape.'
      using errcode = '22023';
  end if;
  v_pr := p_candidate->'pr';
  v_checks := p_candidate->'checks';
  v_migrations := p_candidate->'migrations';
  v_schema := p_candidate->'schema';
  v_deployment := p_candidate->'deployment';
  v_head := v_pr->>'head_sha';
  v_base := v_pr->>'base_sha';
  v_pr_number := v_pr->>'number';
  if jsonb_typeof(v_pr) is distinct from 'object' then
    raise exception 'Release candidate PR must be an object.'
      using errcode = '22023';
  end if;
  if p_candidate->>'repository' is distinct from 'AttractAcq/AA-Console'
    or exists (select 1 from jsonb_object_keys(v_pr) k
      where k not in ('number','url','head_sha','base_sha','merge_method'))
    or not coalesce(v_pr_number ~ '^[1-9][0-9]*$', false)
    or v_pr->>'url' is distinct from
      'https://github.com/AttractAcq/AA-Console/pull/' || v_pr_number
    or not coalesce(v_head ~ '^[0-9a-f]{40}$', false)
    or not coalesce(v_base ~ '^[0-9a-f]{40}$', false)
    or not coalesce(v_pr->>'merge_method' in ('squash','merge','rebase'), false) then
    raise exception 'Release candidate PR identity is incomplete or invalid.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_checks) is distinct from 'array' then
    raise exception 'Release candidate checks must be an array.'
      using errcode = '22023';
  end if;
  if jsonb_array_length(v_checks) <> 4
    or exists (select 1 from jsonb_array_elements(v_checks) c
      where jsonb_typeof(c) is distinct from 'object'
        or c->>'head_sha' is distinct from v_head
        or c->>'conclusion' is distinct from 'success'
        or not coalesce(c->>'run_id' ~ '^[1-9][0-9]*$', false)) then
    raise exception 'Release candidate must name four successful checks on the exact PR head.'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_checks) c,
      lateral jsonb_object_keys(c) k
      where k not in ('name','head_sha','run_id','conclusion')) then
    raise exception 'Release candidate check contains an unknown field.'
      using errcode = '22023';
  end if;
  select array_agg(c->>'name' order by c->>'name') into v_check_names
    from jsonb_array_elements(v_checks) c;
  if v_check_names is distinct from array[
    'Agent runtime (typecheck, test, build)',
    'Frontend (lint, typecheck, test, build)',
    'MCP gateway (typecheck, test, build)',
    'Schema replay (clean, upgrade, catalog, types)'
  ]::text[] then
    raise exception 'Release candidate check names do not match protected CI.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_migrations) is distinct from 'array'
    or jsonb_typeof(v_schema) is distinct from 'object' then
    raise exception 'Release candidate migrations and schema must have the required shape.'
      using errcode = '22023';
  end if;
  if not coalesce(v_schema->>'current_head' ~ '^[0-9]{14}$', false)
    or not coalesce(v_schema->>'target_head' ~ '^[0-9]{14}$', false)
    or exists (select 1 from jsonb_object_keys(v_schema) k
      where k not in ('current_head','target_head'))
    or exists (select 1 from jsonb_array_elements(v_migrations) m
      where jsonb_typeof(m) is distinct from 'object'
        or not coalesce(m->>'version' ~ '^[0-9]{14}$', false)
        or not coalesce(m->>'filename' ~ '^[0-9]{14}_[A-Za-z0-9_.-]+[.]sql$', false)
        or left(m->>'filename', 14) is distinct from m->>'version'
        or not coalesce(m->>'sha256' ~ '^[0-9a-f]{64}$', false)) then
    raise exception 'Release candidate migration plan is incomplete or invalid.'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_migrations) m,
      lateral jsonb_object_keys(m) k
      where k not in ('version','filename','sha256')) then
    raise exception 'Release candidate migration contains an unknown field.'
      using errcode = '22023';
  end if;
  select count(*)::integer, max(m->>'version')
    into v_migration_count, v_last_migration
    from jsonb_array_elements(v_migrations) m;
  if (v_migration_count = 0
      and v_schema->>'target_head' is distinct from v_schema->>'current_head')
    or (v_migration_count > 0 and (
      v_schema->>'target_head' is distinct from v_last_migration
      or v_migration_count <> (select count(distinct m->>'version')
        from jsonb_array_elements(v_migrations) m)
      or exists (select 1 from jsonb_array_elements(v_migrations) m
        where m->>'version' <= v_schema->>'current_head')
      or exists (select 1 from jsonb_array_elements(v_migrations)
        with ordinality m(value, ordinal)
        join jsonb_array_elements(v_migrations)
        with ordinality prior(value, ordinal)
          on prior.ordinal + 1 = m.ordinal
        where prior.value->>'version' >= m.value->>'version')
    )) then
    raise exception 'Release candidate migration versions must be distinct and ordered.'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_deployment) is distinct from 'object'
    or jsonb_typeof(p_candidate->'switch_plan') is distinct from 'array'
    or jsonb_typeof(p_candidate->'rollback') is distinct from 'object' then
    raise exception 'Release deployment, switches and rollback must have the required shape.'
      using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(v_deployment) k
      where k not in ('browser_pr_head_sha','runtime_pin_sha','gateway_pin_sha',
        'railway_environment_id','runtime_service_id','gateway_service_id',
        'manifest_sha256'))
    or v_deployment->>'browser_pr_head_sha' is distinct from v_head
    or not coalesce(v_deployment->>'runtime_pin_sha' ~ '^[0-9a-f]{40}$', false)
    or not coalesce(v_deployment->>'gateway_pin_sha' ~ '^[0-9a-f]{40}$', false)
    or not coalesce(v_deployment->>'manifest_sha256' ~ '^[0-9a-f]{64}$', false)
    or nullif(btrim(v_deployment->>'railway_environment_id'), '') is null
    or nullif(btrim(v_deployment->>'runtime_service_id'), '') is null
    or nullif(btrim(v_deployment->>'gateway_service_id'), '') is null
    or jsonb_array_length(p_candidate->'switch_plan') <> 0
    or exists (select 1 from jsonb_object_keys(p_candidate->'rollback') k
      where k <> 'strategy')
    or not coalesce(p_candidate->'rollback'->>'strategy'
      in ('forward_fix','redeploy_prior_version'), false) then
    raise exception 'Release deployment and rollback scope is incomplete or unsupported.'
      using errcode = '22023';
  end if;

  -- PostgreSQL jsonb text has a deterministic key order. Include expiry in
  -- the hash so resubmitting the same plan with another expiry is a new card.
  v_version := encode(sha256(convert_to(jsonb_build_object(
    'candidate', p_candidate, 'expires_at', p_expires_at
  )::text, 'UTF8')), 'hex');
  insert into public.production_release_candidates_v6 (
    candidate, expires_at, version_hash, submitted_by
  ) values (p_candidate, p_expires_at, v_version, auth.uid())
    on conflict (version_hash) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from public.production_release_candidates_v6
      where version_hash = v_version;
    return v_id;
  end if;
  perform public.register_approval_request_v6(jsonb_build_object(
    'source_system', 'aa_console',
    'source_kind', 'production_release',
    'source_id', v_id::text,
    'source_version', v_version,
    'title', 'Production release PR #' || v_pr_number,
    'artifact_hash', v_version,
    'preview', p_candidate,
    'destination', 'AA-Console production release',
    'account_ref', v_deployment->>'railway_environment_id',
    'scope', jsonb_build_object(
      'repository', 'AttractAcq/AA-Console',
      'pr_head_sha', v_head,
      'base_sha', v_base,
      'migration_target_head', v_schema->>'target_head',
      'railway_environment_id', v_deployment->>'railway_environment_id',
      'switch_plan', p_candidate->'switch_plan'
    ),
    'owner_role', 'admin',
    'expires_at', p_expires_at,
    'preview_blocker',
      'Release source and four checks are not independently attested. No merge, migration, Railway or Pages effect gate is connected.',
    'requested_by', auth.uid(),
    'requester_kind', 'human'
  ));
  return v_id;
end;
$$;

-- decide_production_release_candidate_v6 (was 20261101120000_298_approved_release_proof_refresh.sql)
create or replace function public.decide_production_release_candidate_v6(
  p_request_id uuid, p_expected_source_version text,
  p_expected_artifact_hash text, p_expected_packet_sha256 text,
  p_decision text, p_reason text
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_source public.production_release_candidates_v6%rowtype;
  v_proof public.production_release_attestations_v6%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not coalesce(public.is_human_admin(),false)
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'Only a provisioned admin with AAL2 can decide a release.'
      using errcode = '42501';
  end if;
  if p_decision not in ('approved','rejected','revoked') or p_decision is null
    or (p_decision <> 'approved' and nullif(btrim(coalesce(p_reason,'')),'') is null) then
    raise exception 'A valid release decision and reason are required.'
      using errcode = '22023';
  end if;
  select * into v_request from public.approval_requests_v6
    where id = p_request_id for update;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'production_release'
    or v_request.client_id is not null or v_request.owner_role is distinct from 'admin'
    or v_request.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Production release request is invalid.' using errcode = '23514';
  end if;
  select * into v_source from public.production_release_candidates_v6
    where id = v_request.source_id::uuid;
  if not found or v_request.source_version is distinct from v_source.version_hash
    or v_request.artifact_hash is distinct from v_source.version_hash
    or v_request.preview is distinct from v_source.candidate
    or v_request.expires_at is distinct from v_source.expires_at
    or p_expected_source_version is distinct from v_source.version_hash
    or p_expected_artifact_hash is distinct from v_source.version_hash then
    raise exception 'Production release candidate version changed.' using errcode = '23514';
  end if;
  if p_decision = 'approved' then
    if v_source.expires_at <= clock_timestamp()
      or public.production_release_source_state_v6(p_request_id) <> 'pending' then
      raise exception 'Release evidence is stale, held or expired.'
        using errcode = '23514';
    end if;
    select * into v_proof from public.production_release_attestations_v6
      where request_id = p_request_id order by event_order desc limit 1;
    if not found or not coalesce(p_expected_packet_sha256 ~ '^[0-9a-f]{64}$',false)
      or p_expected_packet_sha256 is distinct from v_proof.packet_sha256
      or v_proof.source_version is distinct from v_source.version_hash
      or v_proof.packet->>'packetSha256' is distinct from v_proof.packet_sha256 then
      raise exception 'The exact GitHub proof changed after the Inbox review.'
        using errcode = '23514';
    end if;
  end if;
  return public.record_approval_decision_v6(
    p_request_id,p_decision,v_source.version_hash,
    'production_release:' || p_request_id::text || ':' || p_decision,
    p_reason
  );
end;
$$;

-- bind_approved_production_release_packet_v6 (was 20261101120000_298_approved_release_proof_refresh.sql)
-- The request-row lock in record_approval_decision_v6 serializes this trigger
-- with the proof writer. The latest proof is therefore the exact packet the
-- AAL2 admin saw when the approval event was appended.
create or replace function public.bind_approved_production_release_packet_v6()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_proof public.production_release_attestations_v6%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if new.decision is distinct from 'approved' then return new; end if;
  select * into v_request from public.approval_requests_v6
    where id = new.request_id;
  if not found or v_request.source_system is distinct from 'aa_console'
    or v_request.source_kind is distinct from 'production_release' then
    return new;
  end if;
  if auth.role() is distinct from 'authenticated'
    or auth.uid() is distinct from new.actor_id
    or coalesce(auth.jwt()->>'aal','') <> 'aal2'
    or new.actor_aal is distinct from 'aal2'
    or not coalesce(public.is_human_admin(),false)
    or v_request.source_version is distinct from new.artifact_hash
    or v_request.artifact_hash is distinct from new.artifact_hash then
    raise exception 'Only the exact human release decision can bind proof.'
      using errcode = '42501';
  end if;
  select * into v_proof from public.production_release_attestations_v6
    where request_id = new.request_id order by event_order desc limit 1;
  if not found or v_proof.source_version is distinct from v_request.source_version
    or v_proof.packet_sha256 is distinct from v_proof.packet->>'packetSha256'
    or v_proof.attested_at < clock_timestamp() - interval '15 minutes'
    or v_request.expires_at <= clock_timestamp() then
    raise exception 'The exact release proof is stale or mismatched.'
      using errcode = '23514';
  end if;
  insert into public.production_release_approval_bindings_v6 (
    request_id,decision_id,attestation_id,source_version,packet_sha256
  ) values (
    new.request_id,new.id,v_proof.id,v_request.source_version,v_proof.packet_sha256
  );
  return new;
end;
$$;

-- decide_campaign_action_approval_v6 (was 20261015230000_206_v6_action_approvals.sql)
create or replace function public.decide_campaign_action_approval_v6(
  p_request_id uuid, p_decision text, p_reason text default null
) returns public.campaign_action_approvals
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_request public.campaign_action_approvals%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() <> 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in human must decide this action.';
  end if;
  select * into v_request from public.campaign_action_approvals
    where id = p_request_id for update;
  if not found then raise exception 'Approval request not found.'; end if;
  if not (coalesce(public.is_human_admin(), false)
    or coalesce(auth.uid() = public.active_video_approval_manager(v_request.client_id), false)) then
    raise exception 'Only an admin or the active client manager may approve.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This request has already been decided.';
  end if;
  select * into v_manifest from public.campaign_manifest_versions
    where id = v_request.manifest_id;
  if exists (select 1 from public.campaign_manifest_versions v
    where v.campaign_id = v_request.campaign_id and v.version > v_manifest.version) then
    raise exception 'The campaign package changed. Request a new approval.';
  end if;
  if p_decision not in ('approved', 'rejected') or p_decision is null
     or (p_decision = 'rejected' and nullif(btrim(coalesce(p_reason, '')), '') is null) then
    raise exception 'Approve, or reject with a reason.';
  end if;
  update public.campaign_action_approvals set
    status = p_decision, decided_at = now(), decided_by = auth.uid(),
    rejection_reason = case when p_decision = 'rejected' then btrim(p_reason) else null end
  where id = p_request_id returning * into v_request;
  return v_request;
end;
$$;

-- decide_proof_placement_approval_v6 (was 20261019090000_218_proof_distribution_spine.sql)
create or replace function public.decide_proof_placement_approval_v6(
  p_approval_id uuid, p_approved boolean, p_reason text default null)
returns public.proof_placements language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_approval public.proof_placement_approvals%rowtype;
  v_placement public.proof_placements%rowtype;
  v_mode text;
  v_next text;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v_approval from public.proof_placement_approvals where id = p_approval_id for update;
  if not found then raise exception 'No such approval.'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_human_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_approval.client_id), false)) then
    raise exception 'Only an admin or assigned client manager can decide a placement.';
  end if;
  if v_approval.status <> 'pending' then
    raise exception 'That approval was already %.', v_approval.status;
  end if;
  select * into v_placement from public.proof_placements where id = v_approval.placement_id for update;
  -- The payload moved between asking and deciding. Approving now would sign
  -- off something nobody read.
  if v_placement.payload_hash <> v_approval.payload_hash then
    raise exception 'This payload changed after approval was requested. Ask again.';
  end if;

  if not p_approved then
    if nullif(btrim(p_reason), '') is null then raise exception 'Say why it was rejected.'; end if;
    update public.proof_placement_approvals
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(), rejection_reason = btrim(p_reason)
     where id = p_approval_id;
    update public.proof_placements set status = 'rejected' where id = v_placement.id;
    insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
    values (v_placement.id, v_placement.client_id, 'rejected', 'human', btrim(p_reason));
    select * into v_placement from public.proof_placements where id = v_placement.id;
    return v_placement;
  end if;

  update public.proof_placement_approvals
     set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where id = p_approval_id;
  update public.proof_placements set status = 'approved' where id = v_placement.id;
  insert into public.proof_placement_events (placement_id, client_id, event, actor)
  values (v_placement.id, v_placement.client_id, 'approved', 'human');

  -- Where it waits next depends on who performs the act. An assisted
  -- destination has no sweep to wait for; an embed one waits for a page.
  select mode into v_mode from public.proof_destinations where destination_key = v_placement.destination_key;
  v_next := case v_mode
              when 'api' then 'queued'
              when 'reference' then 'queued'
              when 'assisted' then 'awaiting_manual_placement'
              else 'bound' end;
  update public.proof_placements set status = v_next where id = v_placement.id;
  if v_next = 'queued' then
    insert into public.proof_placement_events (placement_id, client_id, event, actor)
    values (v_placement.id, v_placement.client_id, 'queued', 'system');
  end if;

  select * into v_placement from public.proof_placements where id = v_placement.id;
  return v_placement;
end $$;

-- Frozen at decision time. Reading profiles.is_bot later is wrong: decided_by
-- is ON DELETE SET NULL, and clearing is_bot would make a bot approval
-- look human. Approved rows with a null decider stay undeliverable.
alter table public.lead_magnet_approvals
  add column if not exists decided_by_bot boolean not null default false;

comment on column public.lead_magnet_approvals.decided_by_bot is
  'True when the caller who decided this row was a bot. Set only by decide_lead_magnet_approval_v6, which is security definer and runs as the owner. Table UPDATE is revoked, so a column revoke is not shadowed by relacl. anon and authenticated get no UPDATE: there is no write policy and no invoker update. service_role keeps column UPDATE on every other column because workers run as that role; decided_by_bot and id are excluded.';

update public.lead_magnet_approvals a
   set decided_by_bot = true
  from public.profiles p
 where p.id = a.decided_by
   and p.is_bot;

-- A table-level UPDATE grant makes has_column_privilege true for every
-- column, including one that was revoked by name. Take the table grant
-- away, then give service_role back the columns a worker may still change.
revoke update on table public.lead_magnet_approvals
  from public, anon, authenticated, service_role;
grant update (
  client_id, magnet_version_id, payload_hash, scope, status,
  requested_at, requested_by, decided_at, decided_by,
  rejection_reason, revoked_at, revoked_reason
) on table public.lead_magnet_approvals to service_role;

-- decide_lead_magnet_approval_v6 (was 20261024100000_236_lead_magnets.sql)
create or replace function public.decide_lead_magnet_approval_v6(
  p_approval_id uuid, p_approved boolean, p_reason text default null)
returns public.lead_magnet_approvals language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_approval public.lead_magnet_approvals%rowtype;
  v_current text;
  v_caller_is_bot boolean;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     )
     and not public.bot_may('approve_lead_magnet') then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v_approval from public.lead_magnet_approvals where id = p_approval_id for update;
  if not found then raise exception 'No such approval.' using errcode = 'P0001'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_human_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_approval.client_id), false)
             or coalesce(public.bot_may('approve_lead_magnet'), false)) then
    raise exception 'A signed-in admin or the assigned client manager must decide this.'
      using errcode = 'P0001';
  end if;
  if v_approval.status <> 'pending' then
    raise exception 'That approval was already %.', v_approval.status using errcode = 'P0001';
  end if;

  -- The file may have been re-exported between asking and deciding, which
  -- would make this a decision about something nobody read.
  v_current := public.lead_magnet_payload_hash_v6(v_approval.magnet_version_id);
  if v_current <> v_approval.payload_hash then
    raise exception 'This magnet changed after approval was requested. Ask again.'
      using errcode = 'P0001';
  end if;

  select coalesce(bool_or(p.is_bot), false)
    into v_caller_is_bot
    from public.profiles p
   where p.id = auth.uid();

  if not coalesce(p_approved, false) then
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Say why it was rejected.' using errcode = 'P0001';
    end if;
    update public.lead_magnet_approvals
       set status = 'rejected', decided_at = now(), decided_by = auth.uid(),
           decided_by_bot = v_caller_is_bot,
           rejection_reason = btrim(p_reason)
     where id = p_approval_id returning * into v_approval;
    return v_approval;
  end if;

  update public.lead_magnet_approvals
     set status = 'approved', decided_at = now(), decided_by = auth.uid(),
         decided_by_bot = v_caller_is_bot
   where id = p_approval_id returning * into v_approval;
  return v_approval;
end $$;
-- <<end approval-decisions>>


-- <<security-review-preambles>>
-- approve_service_offer_version_v6 (was 20261016010000_208_v6_offer_studio.sql; preamble only)
create or replace function public.approve_service_offer_version_v6(p_version_id uuid)
returns public.service_offer_signoffs
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_version public.service_offer_versions%rowtype;
  v_claim jsonb;
  v_proof public.client_proof_assets%rowtype;
  v_signoff public.service_offer_signoffs%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() <> 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in human must approve this offer.';
  end if;
  select * into v_version from public.service_offer_versions where id = p_version_id;
  if not found then raise exception 'Offer version not found.'; end if;
  if not (coalesce(public.is_admin(), false) or
    coalesce(auth.uid() = public.active_video_approval_manager(v_version.client_id), false)) then
    raise exception 'Only an admin or the active client manager may approve.';
  end if;
  if exists (select 1 from public.service_offer_signoffs where offer_version_id = p_version_id) then
    raise exception 'This offer version is already approved.';
  end if;
  for v_claim in select * from jsonb_array_elements(v_version.claims) loop
    if v_claim->>'kind' = 'quantified' then
      select * into v_proof from public.client_proof_assets
        where id = (v_claim->>'proof_asset_id')::uuid;
      if not found or v_proof.client_id <> v_version.client_id
         or v_proof.usage_rights <> 'approved'
         or (v_proof.expires_on is not null and v_proof.expires_on < current_date) then
        raise exception 'A quantified claim needs current, cleared proof for this client.';
      end if;
    end if;
  end loop;
  insert into public.service_offer_signoffs(offer_version_id,client_id,approved_by)
  values (p_version_id,v_version.client_id,auth.uid()) returning * into v_signoff;
  return v_signoff;
end;
$$;

-- decide_meta_profile_change_v6 (was 20261024150000_241_meta_profile_presence.sql; preamble only)
create or replace function public.decide_meta_profile_change_v6(
  p_change_id uuid, p_approved boolean, p_reason text default null)
returns public.meta_profile_changes language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_change public.meta_profile_changes%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v_change from public.meta_profile_changes where id = p_change_id for update;
  if not found then raise exception 'No such change.' using errcode = 'P0001'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_change.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must decide this.'
      using errcode = 'P0001';
  end if;
  if v_change.status <> 'drafted' then
    raise exception 'That change is %, not a draft.', v_change.status using errcode = 'P0001';
  end if;

  if not coalesce(p_approved, false) then
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Say why it was rejected.' using errcode = 'P0001';
    end if;
    update public.meta_profile_changes
       set status = 'rejected', rejection_reason = btrim(p_reason)
     where id = p_change_id returning * into v_change;
    return v_change;
  end if;

  update public.meta_profile_changes
     set status = 'approved', approved_by = auth.uid(), approved_at = now()
   where id = p_change_id returning * into v_change;
  return v_change;
end $$;

-- decide_proof_delivery (was 20261018110000_216_proof_capture_delivery.sql; preamble only)
create or replace function public.decide_proof_delivery(p_delivery_id uuid,p_approve boolean) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.proof_request_deliveries%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

 select * into d from public.proof_request_deliveries where id=p_delivery_id for update;
 if not found or auth.role() is distinct from 'authenticated' or not(coalesce(public.is_admin(),false) or coalesce(auth.uid()=public.active_video_approval_manager(d.client_id),false)) then raise exception 'Not permitted'; end if;
 if d.status not in ('pending_approval','approved','failed') then raise exception 'This delivery can no longer be changed'; end if;
 update public.proof_request_deliveries set status=case when p_approve then 'approved' else 'cancelled' end,
 approved_by=case when p_approve then auth.uid() end,approved_at=case when p_approve then now() end,error=null where id=d.id;
end $$;

-- approve_message_template_v6 (was 20261025140000_249_the_send_path.sql; preamble only)
-- ---------------------------------------------------------------------------
-- Approving a version for a channel and a purpose
-- ---------------------------------------------------------------------------

create or replace function public.approve_message_template_v6(
  p_template_version_id uuid, p_consent_basis text)
returns public.message_template_approvals language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v public.message_template_versions%rowtype;
  t public.message_templates%rowtype;
  a public.message_template_approvals%rowtype;
  v_supported boolean;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v from public.message_template_versions where id = p_template_version_id;
  if not found then raise exception 'No such message version.' using errcode = 'P0001'; end if;
  select * into t from public.message_templates where id = v.template_id;

  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(t.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must approve a message.'
      using errcode = 'P0001';
  end if;

  -- Stated, not inferred. Nothing reads consent_wording, so this sentence is
  -- the record of the judgement that the consent covers a message like this.
  if nullif(btrim(coalesce(p_consent_basis, '')), '') is null then
    raise exception 'Say why the consent these leads gave covers a message of this purpose.'
      using errcode = 'P0001';
  end if;

  select supported into v_supported from public.message_channels
   where channel_key = t.channel_key;
  if not coalesce(v_supported, false) then
    raise exception 'There is no transport for %. Approving it would authorise something that cannot happen.',
      t.channel_key using errcode = 'P0001';
  end if;

  insert into public.message_template_approvals (
    template_version_id, client_id, channel_key, purpose, consent_basis, approved_by)
  values (p_template_version_id, t.client_id, t.channel_key, t.purpose,
          btrim(p_consent_basis), auth.uid())
  on conflict (template_version_id, channel_key) do update
    set status = 'approved', consent_basis = excluded.consent_basis,
        approved_by = excluded.approved_by, approved_at = now(),
        revoked_by = null, revoked_at = null, revoked_reason = null
  returning * into a;
  return a;
end $$;

-- approve_nurture_sequence_v6 (was 20261025170000_252_walking_the_sequence.sql; preamble only)
-- G11, the engine: approving a sequence, enrolling leads, and walking them.
--
-- The one thing in here worth reading twice is `sequence_exit_reason_v6`.
-- Everything else is bookkeeping; that function is what stops the system
-- asking somebody who booked a call on Tuesday whether they are still
-- thinking it over.

-- ---------------------------------------------------------------------------
-- Approving the shape
-- ---------------------------------------------------------------------------

create or replace function public.approve_nurture_sequence_v6(p_sequence_id uuid)
returns public.nurture_sequences language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  s public.nurture_sequences%rowtype;
  v_steps integer;
  v_unapproved text;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into s from public.nurture_sequences where id = p_sequence_id for update;
  if not found then raise exception 'No such sequence.' using errcode = 'P0001'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(s.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must approve a sequence.'
      using errcode = 'P0001';
  end if;

  select count(*)::int into v_steps from public.nurture_sequence_steps
   where sequence_id = p_sequence_id;
  if v_steps = 0 then
    raise exception 'That sequence has no steps.' using errcode = 'P0001';
  end if;

  -- Approving the shape must not quietly authorise unapproved words.
  select string_agg('step ' || st.position::text, ', ' order by st.position)
    into v_unapproved
    from public.nurture_sequence_steps st
   where st.sequence_id = p_sequence_id
     and not exists (
       select 1 from public.message_template_approvals a
        where a.template_version_id = st.template_version_id and a.status = 'approved');
  if v_unapproved is not null then
    raise exception 'These steps carry words nobody has approved: %. Approve each message version first.',
      v_unapproved using errcode = 'P0001';
  end if;

  update public.nurture_sequences
     set approved_at = now(), approved_by = auth.uid()
   where id = p_sequence_id returning * into s;
  return s;
end $$;

-- create_booking_link_v6 (was 20261029200000_269_authenticated_sales_rpc_scope.sql; preamble only)
-- B005 guarded RPC: create_booking_link_v6 (latest definition from 20261025210000_256_taking_a_slot.sql).
create or replace function public.create_booking_link_v6(
  p_client_id uuid, p_purpose text, p_token_hash text,
  p_campaign_id uuid default null, p_expires_at timestamptz default null)
returns public.booking_links
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.booking_links%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if not (coalesce(public.is_admin(), false)
          or coalesce(public.may_manage_client_leads(p_client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if p_campaign_id is not null and not exists (
    select 1 from public.client_campaigns c
     where c.id = p_campaign_id and c.client_id = p_client_id) then
    raise exception 'That campaign belongs to a different client.' using errcode = 'P0001';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A booking token hash is 64 hex characters.' using errcode = 'P0001';
  end if;
  insert into public.booking_links (
    client_id, campaign_id, purpose, token_hash, expires_at, created_by)
  values (
    p_client_id, p_campaign_id, btrim(p_purpose), p_token_hash, p_expires_at, auth.uid())
  returning * into v;
  return v;
end $$;

-- release_proof_to_sales_agent_v6 (was 20261025110000_246_proof_reaches_the_surfaces_it_was_made_for.sql; preamble only)
-- ---------------------------------------------------------------------------
-- G10: which proof a sales agent may cite
-- ---------------------------------------------------------------------------

-- A reference placement, and the one of the three that is a decision rather
-- than bookkeeping: releasing proof to an agent is a person saying it may be
-- quoted in conversations nobody reads one by one. So it goes through the
-- normal approval path and this only records the release.
create or replace function public.release_proof_to_sales_agent_v6(p_placement_id uuid, p_deployment_id uuid)
returns public.proof_placements
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v public.proof_placements%rowtype;
  v_deployment public.client_sales_agent_deployments%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v from public.proof_placements where id = p_placement_id for update;
  if not found then raise exception 'No such placement.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(auth.uid() = public.active_video_approval_manager(v.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can release proof to an agent.'
      using errcode = 'P0001';
  end if;
  if v.destination_key <> 'sales_conversation' then
    raise exception 'That placement is for %, not a sales conversation.', v.destination_key
      using errcode = 'P0001';
  end if;
  if v.status <> 'approved' then
    raise exception 'That placement is %, not approved.', v.status using errcode = 'P0001';
  end if;

  select * into v_deployment from public.client_sales_agent_deployments where id = p_deployment_id;
  if not found then raise exception 'No such deployment.' using errcode = 'P0001'; end if;
  if v_deployment.client_id <> v.client_id then
    raise exception 'That deployment belongs to a different client.' using errcode = 'P0001';
  end if;
  if not v_deployment.enabled then
    raise exception 'That deployment is disabled, so nothing would cite the proof.'
      using errcode = 'P0001';
  end if;

  update public.proof_placements
     set status = 'placed', external_id = p_deployment_id::text, placed_at = now(),
         placed_by = auth.uid()
   where id = p_placement_id returning * into v;

  insert into public.proof_placement_events (placement_id, client_id, kind, detail)
  values (p_placement_id, v.client_id, 'placed',
          'Released to sales agent deployment ' || p_deployment_id::text || '.');
  return v;
end $$;

-- create_lead_capture_endpoint_v6 (was 20261024090000_235_a_lead_can_arrive_from_outside.sql; preamble only)
-- ---------------------------------------------------------------------------
-- Creating the endpoint
-- ---------------------------------------------------------------------------

-- The token is returned once, here, and never stored. Whoever calls this is
-- responsible for putting it somewhere useful; the database keeps only the
-- hash, so losing it means issuing a new one rather than reading the old one
-- back out.
create or replace function public.create_lead_capture_endpoint_v6(
  p_client_id uuid,
  p_purpose text,
  p_token_hash text,
  p_consent_wording text,
  p_campaign_id uuid default null,
  p_page_id uuid default null,
  p_source_channel text default null,
  p_days integer default 90,
  p_max_submissions integer default 500
) returns public.lead_capture_endpoints
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_row public.lead_capture_endpoints%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can open a capture endpoint.'
      using errcode = 'P0001';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A hashed token is required.' using errcode = 'P0001';
  end if;
  -- The campaign has to belong to the client, or an endpoint could attribute
  -- one client's leads to another's campaign.
  if p_campaign_id is not null and not exists (
    select 1 from public.client_campaigns
     where id = p_campaign_id and client_id = p_client_id) then
    raise exception 'That campaign does not belong to this client.' using errcode = 'P0001';
  end if;
  if p_page_id is not null and not exists (
    select 1 from public.client_pages where id = p_page_id and client_id = p_client_id) then
    raise exception 'That page does not belong to this client.' using errcode = 'P0001';
  end if;

  insert into public.lead_capture_endpoints (
    client_id, purpose, token_hash, campaign_id, page_id, source_channel,
    consent_wording, expires_at, max_submissions, created_by)
  values (
    p_client_id, p_purpose, p_token_hash, p_campaign_id, p_page_id, p_source_channel,
    btrim(p_consent_wording),
    now() + make_interval(days => greatest(coalesce(p_days, 90), 1)),
    greatest(coalesce(p_max_submissions, 500), 1),
    nullif(auth.uid(), null))
  returning * into v_row;
  return v_row;
end $$;

-- approve_proof_artifact_v6 (was 20261016020000_209_v6_proof_artifacts.sql; preamble only)
create or replace function public.approve_proof_artifact_v6(p_artifact_version_id uuid)
returns public.proof_artifact_signoffs
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_artifact public.proof_artifact_versions%rowtype;
  v_proof public.client_proof_assets%rowtype;
  v_signoff public.proof_artifact_signoffs%rowtype;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if auth.role() <> 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in human must approve a proof artifact.';
  end if;
  select * into v_artifact from public.proof_artifact_versions where id = p_artifact_version_id;
  if not found then raise exception 'Proof artifact not found.'; end if;
  if not (coalesce(public.is_admin(), false) or
    coalesce(auth.uid() = public.active_video_approval_manager(v_artifact.client_id), false)) then
    raise exception 'Only an admin or the active client manager may approve.';
  end if;
  select * into v_proof from public.client_proof_assets
    where id = v_artifact.source_proof_id and client_id = v_artifact.client_id for share;
  if not found or v_proof.usage_rights <> 'approved'
     or nullif(btrim(v_proof.permission_basis), '') is null
     or (v_proof.expires_on is not null and v_proof.expires_on < current_date)
     or public.proof_snapshot_hash_v6(public.proof_source_snapshot_v6(v_proof)) <> v_artifact.source_hash then
    raise exception 'The proof source is uncleared, expired or changed. Refresh the artifact.';
  end if;
  if exists (select 1 from public.proof_artifact_signoffs
    where artifact_version_id = p_artifact_version_id) then
    raise exception 'This proof artifact is already approved.';
  end if;
  insert into public.proof_artifact_signoffs(artifact_version_id, client_id, approved_by)
  values (p_artifact_version_id, v_artifact.client_id, auth.uid()) returning * into v_signoff;
  return v_signoff;
end;
$$;

-- A bot review is not a human sign-off. Migration 105 kept human_approved_at
-- null for a bot; review_media_asset had started writing it, and schedule_asset
-- treated that stamp as permission to enter the organic calendar.
alter table public.client_media_assets
  add column if not exists bot_reviewed_at timestamptz;

comment on column public.client_media_assets.bot_reviewed_at is
  'When a bot approved this asset. Null after a rejection. A bot never writes human_approved_at. A human schedule of a bot-reviewed asset calls review_media_asset, which stamps human_approved_at. organic_publication_source_snapshot_v6 is the publisher gate and still requires that human stamp; bot_reviewed_at is not publication authority.';

-- review_media_asset (was 20261025120000_247_creative_decisions_have_a_seat.sql)
-- ---------------------------------------------------------------------------
-- The decision, now recording its seat
-- ---------------------------------------------------------------------------

-- Replaced in full rather than wrapped. Every existing refusal is kept
-- verbatim and in the same order, so the sentence a person already knows is
-- the sentence they still get; the two additions are the opt-in creative
-- director gate and the seat written onto the review row.
create or replace function public.review_media_asset(
  p_asset_id uuid, p_decision review_status, p_reason text default null)
returns void language plpgsql security definer
set search_path = public as $function$
declare
  a client_media_assets%rowtype;
  v_state jsonb;
  v_seat text;
  v_required boolean;
  v_director uuid;
  v_caller_is_bot boolean;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     )
     and not public.bot_may('approve_content') then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null then raise exception 'Asset not found'; end if;
  if not can_access_client(a.client_id) then raise exception 'Not permitted for this client'; end if;
  if a.media_type = 'video' and a.human_approved_at is not null then
    raise exception 'This video version has already been finalized.';
  end if;
  if p_decision = 'pending' then raise exception 'Decision must be approved or rejected'; end if;
  if p_decision = 'approved' and a.edit_stage <> 'review_ready' then
    raise exception 'Edit the source footage before approving a finished video.';
  end if;
  if p_decision = 'approved' and a.content_format = 'reel'
     and nullif(btrim(a.render_path), '') is null then
    raise exception 'Finish the reel cut before approving it';
  end if;

  -- G12: the opt-in seat gate. Only on approval, and only where a client has
  -- asked for it -- a rejection should never be blocked, because refusing
  -- work is not an act that needs authority.
  if p_decision = 'approved' then
    select coalesce(creative_director_required, false) into v_required
      from client_engine_settings where client_id = a.client_id;
    if coalesce(v_required, false) then
      v_director := active_creative_director(a.client_id);
      if v_director is null then
        raise exception 'This client requires creative director sign-off and nobody holds that seat. Assign one before approving creative.';
      end if;
      if not coalesce(public.is_human_admin(), false) and auth.uid() is distinct from v_director then
        raise exception 'Only the assigned creative director or an admin can approve creative for this client.';
      end if;
    end if;
  end if;

  if p_decision = 'approved' and a.media_type = 'video' then
    v_state := video_approval_state(a.id);
    if (v_state->>'owner_user_id') is null then
      raise exception 'Configure an owner account before approving video.';
    end if;
    if (v_state->>'manager_user_id') is null then
      raise exception 'Assign an active SMM to this client before approving video.';
    end if;
    if auth.uid() is distinct from (v_state->>'owner_user_id')::uuid
       and auth.uid() is distinct from (v_state->>'manager_user_id')::uuid then
      raise exception 'Only the owner or active SMM can finalize video approval.';
    end if;
    if not coalesce((v_state->>'owner_approved')::boolean, false)
       or not coalesce((v_state->>'manager_approved')::boolean, false)
       or ((v_state->>'client_user_id') is not null
           and not coalesce((v_state->>'client_approved')::boolean, false)) then
      raise exception 'Wait for the owner, SMM and requested client sign-offs.';
    end if;
  end if;

  v_seat := creative_seat_of(a.client_id, auth.uid());

  -- Aggregate so a missing profile is false, not an unassigned variable.
  -- A bot sets review_status and bot_reviewed_at and does not write
  -- human_approved_at. A human writes human_approved_at exactly as before.
  select coalesce(bool_or(p.is_bot), false)
    into v_caller_is_bot
    from public.profiles p
   where p.id = auth.uid();

  update client_media_assets set
    review_status = p_decision,
    human_approved_at = case
      when p_decision is distinct from 'approved'::public.review_status then null
      when v_caller_is_bot then human_approved_at
      else now()
    end,
    bot_reviewed_at = case
      when not v_caller_is_bot then bot_reviewed_at
      when p_decision = 'approved' then now()
      else null
    end
    where id = p_asset_id;
  insert into client_asset_reviews (asset_id, decision, reason, reviewed_by, decided_in_seat)
    values (p_asset_id, p_decision, p_reason, auth.uid(), v_seat);
end;
$function$;

comment on function public.review_media_asset(uuid, review_status, text) is
  'Records a creative decision and the seat it was made from. A human approval stamps human_approved_at. A bot approval stamps bot_reviewed_at and leaves human_approved_at untouched.';

-- approve_idea_and_generate_brief (was 20260903104816_05_content_chain_proof_ideas_briefs_media.sql; preamble only)
-- Approve an idea and enqueue its brief in one call. This is the
-- trigger the mapping doc is missing — Briefs renders a table that
-- nothing currently writes.
create or replace function public.approve_idea_and_generate_brief(p_idea_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_job    uuid;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     )
     and not public.bot_may('approve_content') then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select client_id into v_client from client_ideas where id = p_idea_id;
  if v_client is null then
    raise exception 'Idea not found';
  end if;
  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client';
  end if;

  update client_ideas set status = 'approved' where id = p_idea_id;
  v_job := enqueue_agent_job('brief', v_client, 'client_ideas', p_idea_id);
  update client_ideas set status = 'briefed' where id = p_idea_id;
  return v_job;
end;
$$;

-- approve_campaign_plan_v6 (was 20261105010000_309_a_plan_is_reviewed_before_the_agents_run.sql; preamble only)
create or replace function public.approve_campaign_plan_v6(
  p_campaign_id uuid,
  p_note text default null
) returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  c public.client_campaigns%rowtype;
  v_fingerprint text;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     )
     and not public.bot_may('approve_content') then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into c from public.client_campaigns where id = p_campaign_id;
  if c.id is null then
    raise exception 'That campaign no longer exists.' using errcode = 'P0001';
  end if;
  -- Approving a plan releases real work: pages written, agents built, content
  -- briefed. It takes the standing the rest of a campaign's shape needs, and
  -- deliberately no service_role branch -- the whole point is that a machine
  -- does not approve its own plan.
  if auth.role() is distinct from 'authenticated'
     or not public.can_access_client(c.client_id) then
    raise exception 'Only a person with access to this client can approve its plan.'
      using errcode = 'P0001';
  end if;
  if c.built_at is null then
    raise exception 'This campaign has no plan yet. There is nothing to approve.'
      using errcode = 'P0001';
  end if;

  v_fingerprint := public.campaign_plan_fingerprint(c);
  if c.plan_approved_at is not null and c.plan_approved_fingerprint = v_fingerprint then
    raise exception 'This exact plan is already approved.' using errcode = 'P0001';
  end if;

  update public.client_campaigns
     set plan_approved_at = now(),
         plan_approved_by = auth.uid(),
         plan_approved_fingerprint = v_fingerprint,
         plan_review_note = nullif(btrim(p_note), ''),
         updated_at = now()
   where id = p_campaign_id;
end $$;

-- approve_slot (was 20261006220000_159_approval_inbox.sql; preamble only)
-- The one human commit.
--
-- M4. Everything before this point can happen without a person: the engine
-- plans a slot, picks an idea, approves it by policy, briefs it, builds it,
-- writes its copy and checks its own work. This is where that stops.
--
-- `human_approved_at` has been the gate since migration 105 and nothing in
-- the engine touches it — migration 152 has a test asserting the string does
-- not appear in the policy functions at all. What was missing is the other
-- half: a person approving an asset did not move the slot that produced it,
-- so the engine's work could be signed off and still never reach a calendar.
--
-- Two acts, and they are deliberately not one function with a flag. Approving
-- creates a scheduled post; rejecting sends the work back to be remade. They
-- share a slot and nothing else, and a single `review_slot(decision)` would
-- read as though they were variations of each other.

-- ---------------------------------------------------------------------------
-- Yes
-- ---------------------------------------------------------------------------

create or replace function public.approve_slot(p_slot_id uuid, p_note text default null)
returns content_slots
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot content_slots;
  v_post uuid;
begin

  -- Bot console users are admins so agency reads keep working, and AAL2 does
  -- not make them human. Refuse before any later admin, manager, or AAL2 gate.
  -- service_role executors are unchanged.
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v_slot from content_slots where id = p_slot_id for update;
  if not found then
    raise exception 'No such slot: %.', p_slot_id using errcode = 'P0001';
  end if;
  if not can_access_client(v_slot.client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if v_slot.stage <> 'awaiting_approval' then
    raise exception 'That slot is %, not waiting for approval.', v_slot.stage using errcode = 'P0001';
  end if;
  if v_slot.asset_id is null then
    raise exception 'That slot has no asset to approve.' using errcode = 'P0001';
  end if;

  -- The commit itself, through the same function every other screen uses, so
  -- the decision is recorded in client_asset_reviews and attributed to the
  -- person exactly as a hand-made asset's approval is.
  perform public.review_media_asset(v_slot.asset_id, 'approved'::review_status, p_note);

  -- The calendar entry. scheduled_at is what the planner chose, in the
  -- client's own time (migration 144), so an approved post goes out when it
  -- was planned to rather than whenever it was approved.
  -- client_id set here rather than left to sync_scheduled_post_from_asset:
  -- this function already knows it, and post_copy's own trigger resolves a
  -- post's client from this column the moment the copy below is inserted.
  insert into scheduled_posts (client_id, asset_id, scheduled_for, scheduled_at, channel, platform, created_by)
  values (
    v_slot.client_id,
    v_slot.asset_id,
    (v_slot.scheduled_at at time zone client_timezone(v_slot.client_id))::date,
    v_slot.scheduled_at,
    'organic'::post_channel,
    v_slot.platform,
    auth.uid()
  )
  returning id into v_post;

  -- Copy written against the asset becomes copy for this post, so the
  -- publisher reads one row rather than resolving the fallback itself.
  insert into post_copy (scheduled_post_id, platform, caption, hashtags, alt_text,
                         link_url, first_comment, cta, source)
  select v_post, pc.platform, pc.caption, pc.hashtags, pc.alt_text,
         pc.link_url, pc.first_comment, pc.cta, pc.source
    from post_copy pc
   where pc.asset_id = v_slot.asset_id
  on conflict (scheduled_post_id, platform) where scheduled_post_id is not null
  do nothing;

  perform advance_slot(
    p_slot_id, 'scheduled', 'human',
    coalesce(p_note, 'Approved.'), null, null, null, null, null, null, v_post);

  select * into v_slot from content_slots where id = p_slot_id;
  return v_slot;
end;
$$;

-- enqueue_agent_job (was 20261101070000_293_meta_legacy_producer_containment.sql; preamble only)
-- B010 / 290: contain every legacy browser Meta build producer while the
-- exact AAL2 Inbox decision and per-provider-write attestation are absent.
-- Existing jobs and Meta IDs remain readable for assisted reconciliation.

create or replace function public.enqueue_agent_job(
  p_agent_key text, p_client_id uuid default null,
  p_input_table text default null, p_input_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
begin

  -- Live delivery, spend, credential, and profile workers stay human-only.
  -- Other workers remain available to a bot admin.
  if exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     )
     and p_agent_key in (
       'publisher', 'proof_placer', 'outbound_courier', 'lead_magnet_courier',
       'profile_updater', 'campaign_action_executor', 'token_health'
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  if public.current_role_of() is null then
    raise exception 'A provisioned console account is required.' using errcode = '42501';
  end if;
  if p_agent_key in ('meta_build', 'recruitment_meta_build') then
    raise exception 'Meta object creation requires an exact AAL2 Approval Inbox decision and a bound prewrite executor.'
      using errcode = '42501';
  end if;
  if p_client_id is null and not public.is_admin() then
    raise exception 'Only an admin may queue agency-wide work.' using errcode = '42501';
  end if;
  if p_client_id is not null and not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;
  return public.enqueue_agent_job_internal(
    p_agent_key, p_client_id, p_input_table, p_input_id, auth.uid()
  );
end;
$$;

-- schedule_asset (was 20261101040000_290_organic_schedule_route.sql)
-- Human-only. A bot review may set bot_reviewed_at; it must not be enough
-- to insert a scheduled post. The human who schedules stamps
-- human_approved_at, which claim_posts_for_publishing still requires.
-- client_media_assets has no human_approved_by column. Who scheduled is
-- scheduled_posts.created_by.
create or replace function public.schedule_asset(
  p_asset_id uuid,
  p_date date,
  p_channel public.post_channel default 'organic'::public.post_channel,
  p_platform public.post_platform default null::public.post_platform,
  p_time time default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_asset public.client_media_assets%rowtype;
  v_brief public.client_briefs%rowtype;
  v_idea public.client_ideas%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in console user must schedule this asset.' using errcode = '42501';
  end if;
  if p_date is null then
    raise exception 'Choose a date before scheduling.' using errcode = 'P0001';
  end if;
  if p_channel is distinct from 'organic'::public.post_channel then
    raise exception 'Paid scheduling uses the Ads Studio route, not organic distribution.' using errcode = 'P0001';
  end if;

  select * into v_asset from public.client_media_assets
   where id = p_asset_id for share;
  if not found then
    raise exception 'Asset not found.' using errcode = 'P0001';
  end if;
  if public.can_access_client(v_asset.client_id) is not true then
    raise exception 'Not permitted for this client.' using errcode = '42501';
  end if;
  if v_asset.review_status is distinct from 'approved'::public.review_status then
    raise exception 'Asset must be approved before it can be scheduled.' using errcode = 'P0001';
  end if;
  if v_asset.human_approved_at is null and v_asset.bot_reviewed_at is null then
    raise exception 'That asset has not been approved by a person yet. Approve it in Approvals before scheduling it.' using errcode = 'P0001';
  end if;
  if v_asset.brief_id is null then
    raise exception 'Scheduling blocked: this asset has no verified organic campaign brief.' using errcode = 'P0001';
  end if;

  select * into v_brief from public.client_briefs
   where id = v_asset.brief_id for share;
  if not found or v_brief.client_id is distinct from v_asset.client_id
     or v_brief.source_idea_id is null then
    raise exception 'Scheduling blocked: the asset brief has no same-client campaign idea.' using errcode = 'P0001';
  end if;

  select * into v_idea from public.client_ideas
   where id = v_brief.source_idea_id for share;
  if not found or v_idea.client_id is distinct from v_asset.client_id
     or v_idea.campaign_id is null then
    raise exception 'Scheduling blocked: the brief idea has no same-client campaign.' using errcode = 'P0001';
  end if;

  select * into v_campaign from public.client_campaigns
   where id = v_idea.campaign_id for share;
  if not found or v_campaign.client_id is distinct from v_asset.client_id then
    raise exception 'Scheduling blocked: the campaign belongs to another client or is missing.' using errcode = 'P0001';
  end if;
  if v_campaign.acquisition_mode = 'paid' then
    raise exception 'Scheduling blocked: this asset belongs to a paid campaign. Use Ads Studio.' using errcode = 'P0001';
  end if;
  if v_campaign.acquisition_mode is distinct from 'organic' or v_campaign.paid_platform is not null then
    raise exception 'Scheduling blocked: this campaign has no explicit organic route.' using errcode = 'P0001';
  end if;

  -- A bot review is not authority to publish. The human who schedules must
  -- be a human admin, the creative director, or the active SMM, and the
  -- approval goes back through review_media_asset so the seat, video and
  -- staff gates run and a client_asset_reviews row records the actor.
  -- An asset a person already approved keeps that earlier stamp.
  if v_asset.human_approved_at is null then
    if not (
      coalesce(public.is_human_admin(), false)
      or coalesce(auth.uid() = public.active_creative_director(v_asset.client_id), false)
      or coalesce(auth.uid() = public.active_video_approval_manager(v_asset.client_id), false)
    ) then
      raise exception 'Only a human admin, the creative director, or the active SMM may schedule a bot-reviewed asset.'
        using errcode = '42501';
    end if;
    perform public.review_media_asset(
      p_asset_id,
      'approved'::public.review_status,
      'Approved by scheduling a bot-reviewed asset');
  end if;

  insert into public.scheduled_posts
    (asset_id, scheduled_for, scheduled_at, channel, platform, created_by)
  values (
    p_asset_id, p_date,
    case when p_time is null then null
         else (p_date + p_time) at time zone public.client_timezone(v_asset.client_id) end,
    p_channel, p_platform, auth.uid()
  ) returning id into v_id;
  return v_id;
end
$function$;

comment on function public.schedule_asset(uuid, date, public.post_channel, public.post_platform, time) is
  'Human scheduling. A bot-reviewed asset may be scheduled only by a human admin, the creative director, or the active SMM, and that schedule re-enters review_media_asset so the human stamp and the review row are written there. Bots are refused. organic_publication_source_snapshot_v6 still requires human_approved_at and a matching scheduled Engine slot.';

revoke all on function public.schedule_asset(uuid, date, public.post_channel, public.post_platform, time)
  from public, anon, service_role;
grant execute on function public.schedule_asset(uuid, date, public.post_channel, public.post_platform, time)
  to authenticated;

-- revoke_lead_magnet_approval_v6 (was 20261024100000_236_lead_magnets.sql)
-- Cancels queued and failed deliveries. Bots must not do that, including a
-- bot that is the assigned manager.
create or replace function public.revoke_lead_magnet_approval_v6(p_approval_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_approval public.lead_magnet_approvals%rowtype;
begin
  if auth.role() is distinct from 'service_role'
     and not coalesce(public.is_human_admin(), false)
     and exists (
       select 1
         from public.profiles as bot_identity
        where bot_identity.id = auth.uid()
          and bot_identity.is_bot
     ) then
    raise exception 'Bot accounts cannot perform this action' using errcode = '42501';
  end if;

  select * into v_approval from public.lead_magnet_approvals where id = p_approval_id for update;
  if not found then raise exception 'No such approval.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_human_admin(), false)
          or coalesce(auth.uid() = public.active_video_approval_manager(v_approval.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can revoke this.'
      using errcode = 'P0001';
  end if;
  if v_approval.status <> 'approved' then
    raise exception 'Only an approved magnet can be revoked.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why it is being revoked.' using errcode = 'P0001';
  end if;
  update public.lead_magnet_approvals
     set status = 'revoked', revoked_at = now(), revoked_reason = btrim(p_reason)
   where id = p_approval_id;
  update public.lead_magnet_deliveries
     set status = 'cancelled', last_error = 'The magnet approval was revoked: ' || btrim(p_reason)
   where magnet_version_id = v_approval.magnet_version_id
     and status in ('queued', 'failed');
end $$;

revoke all on function public.revoke_lead_magnet_approval_v6(uuid, text) from public, anon;
grant execute on function public.revoke_lead_magnet_approval_v6(uuid, text) to authenticated;

-- A bot-sales approval is internal. The courier reads lead_magnet_due, and
-- claim_lead_magnet_deliveries only takes rows whose blocker is null.
-- decided_by_bot is the frozen decision. A null decided_by on an approved
-- row is also blocked. The per-client delivery switch is unchanged.
create or replace view public.lead_magnet_due with (security_invoker = true) as
select
  d.id as delivery_id,
  d.client_id,
  d.submission_id,
  d.lead_id,
  d.magnet_version_id,
  m.name as magnet_name,
  d.channel,
  d.recipient,
  d.status,
  d.attempts,
  d.provider_ref,
  d.last_error,
  case
    when a.id is null
      then 'Nobody has approved this magnet.'
    when a.status = 'revoked'
      then 'The approval was revoked: ' || coalesce(a.revoked_reason, 'no reason recorded') || '.'
    when a.status <> 'approved'
      then 'The approval is ' || a.status || '.'
    when a.decided_by_bot or a.decided_by is null
      then 'A bot approved this magnet. A person still has to approve this version before it can be sent.'
    when a.payload_hash <> public.lead_magnet_payload_hash_v6(d.magnet_version_id)
      then 'The file or the message changed after approval. Ask again.'
    when not coalesce(ces.lead_magnet_delivery_enabled, false)
      then 'Magnet delivery is off for this client.'
    when d.status = 'sent' then 'Already sent.'
    when d.status = 'cancelled' then 'Cancelled.'
    when d.status = 'sending' and d.lease_until > now() then 'Being sent now.'
    when d.attempts >= 5
      then 'Failed ' || d.attempts::text || ' times. Last error: '
           || coalesce(d.last_error, 'none recorded') || '.'
    else null
  end as blocker
from public.lead_magnet_deliveries d
join public.lead_magnet_versions v on v.id = d.magnet_version_id
join public.lead_magnets m on m.id = v.magnet_id
left join public.lead_magnet_approvals a
  on a.magnet_version_id = d.magnet_version_id and a.status in ('approved', 'revoked')
left join public.client_engine_settings ces on ces.client_id = d.client_id;

comment on view public.lead_magnet_due is
  'Every owed magnet and the one sentence saying why it has not gone. A null blocker means the courier would take it next. A bot approval is never a null blocker.';

create or replace function public.claim_lead_magnet_deliveries(p_limit integer default 5)
returns table (
  delivery_id uuid, client_id uuid, magnet_version_id uuid, channel text,
  recipient text, storage_path text, media_type text, content_sha256 text,
  delivery_subject text, delivery_body text, magnet_name text, attempt integer)
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may claim a delivery.';
  end if;
  return query
  with ready as (
    select d.id from public.lead_magnet_deliveries d
     where d.status in ('queued', 'failed')
       and d.id in (select u.delivery_id from public.lead_magnet_due u where u.blocker is null)
       and not exists (
         select 1
           from public.lead_magnet_approvals bot_approval
          where bot_approval.magnet_version_id = d.magnet_version_id
            and bot_approval.status = 'approved'
            and (bot_approval.decided_by_bot or bot_approval.decided_by is null)
       )
     order by d.created_at
     limit greatest(coalesce(p_limit, 5), 1)
     for update skip locked
  ), claimed as (
    update public.lead_magnet_deliveries d
       set status = 'sending', claimed_at = now(),
           lease_until = now() + interval '10 minutes', attempts = d.attempts + 1
     where d.id in (select r.id from ready r)
     returning d.*
  )
  select c.id, c.client_id, c.magnet_version_id, c.channel, c.recipient,
         v.storage_path, v.media_type, v.content_sha256,
         v.delivery_subject, v.delivery_body, m.name, c.attempts
    from claimed c
    join public.lead_magnet_versions v on v.id = c.magnet_version_id
    join public.lead_magnets m on m.id = v.magnet_id;
end $$;

revoke all on function public.claim_lead_magnet_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_lead_magnet_deliveries(integer) to service_role;
-- <<end security-review-preambles>>

select public.lock_down_definer_functions();
grant execute on function public.is_human_admin() to authenticated, service_role;
grant execute on function public.revoke_bot_sessions(uuid) to service_role;
revoke all on function public.schedule_asset(uuid, date, public.post_channel, public.post_platform, time)
  from public, anon, service_role;
grant execute on function public.schedule_asset(uuid, date, public.post_channel, public.post_platform, time)
  to authenticated;
revoke all on function public.revoke_bot_sessions(uuid) from public, anon, authenticated;
revoke execute on function public.guard_profile_bot_identity() from public, anon, authenticated;
revoke execute on function public.sync_profile_bot_app_metadata() from public, anon, authenticated;
