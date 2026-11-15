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
    || '|require_active_bot|require_bot_client_grant'
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

-- <<end rls-split>>

select public.lock_down_definer_functions();
grant execute on function public.is_human_admin() to authenticated, service_role;
revoke execute on function public.guard_profile_bot_identity() from public, anon, authenticated;
revoke execute on function public.sync_profile_bot_app_metadata() from public, anon, authenticated;
