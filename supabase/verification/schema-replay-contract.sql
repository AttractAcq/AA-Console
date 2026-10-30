-- A deliberately small, stable contract for the released acquisition spine.
-- The catalog fingerprint and generated type diff cover the wider schema.
do $contract$
declare
  item text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron missing after migration replay';
  end if;

  foreach item in array array[
    'public.clients', 'public.lead_magnets', 'public.proof_placements',
    'public.outbound_messages', 'mcp_internal.mcp_bots', 'storage.objects'
  ] loop
    if to_regclass(item) is null then
      raise exception 'Required relation % is missing', item;
    end if;
  end loop;

  foreach item in array array[
    'public.lead_magnets', 'public.proof_placements', 'public.outbound_messages',
    'mcp_internal.mcp_bots', 'storage.objects'
  ] loop
    if not coalesce((select relrowsecurity from pg_class where oid = to_regclass(item)), false) then
      raise exception 'RLS disabled on %', item;
    end if;
  end loop;

  if has_schema_privilege('anon', 'mcp_internal', 'USAGE')
     or has_schema_privilege('authenticated', 'mcp_internal', 'USAGE')
     or not has_schema_privilege('service_role', 'mcp_internal', 'USAGE') then
    raise exception 'mcp_internal schema grants drifted';
  end if;

  foreach item in array array[
    'public.claim_outbound_messages(integer)',
    'public.queue_lead_message_v6(uuid,uuid)',
    'public.client_for_meta_recipient_v6(text)',
    'public.engine_tick(timestamp with time zone)',
    'public.prune_agent_runtime_heartbeats()'
  ] loop
    if to_regprocedure(item) is null then
      raise exception 'Required function % is missing', item;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.claim_outbound_messages(integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.claim_outbound_messages(integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.claim_outbound_messages(integer)', 'EXECUTE') then
    raise exception 'Outbound claim function grants drifted';
  end if;
  if has_function_privilege('anon', 'public.client_for_meta_recipient_v6(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.client_for_meta_recipient_v6(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.client_for_meta_recipient_v6(text)', 'EXECUTE') then
    raise exception 'Meta recipient lookup grants drifted';
  end if;
  if has_function_privilege('anon', 'public.prune_agent_runtime_heartbeats()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.prune_agent_runtime_heartbeats()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.prune_agent_runtime_heartbeats()', 'EXECUTE') then
    raise exception 'Runtime heartbeat retention grants drifted';
  end if;

  -- Low-level state machines are internal writers. Human decisions enter
  -- through named, gated wrappers, never through a stage parameter.
  foreach item in array array[
    'public.advance_slot(uuid,public.slot_stage,text,text,text,uuid,numeric,uuid,uuid,uuid,uuid,text)',
    'public.advance_assignment(uuid,public.assignment_stage,text,text,uuid)',
    'public.may_advance_slot(uuid)',
    'public.may_touch_assignment(uuid)'
  ] loop
    if has_function_privilege('anon', item, 'EXECUTE')
       or has_function_privilege('authenticated', item, 'EXECUTE')
       or not has_function_privilege('service_role', item, 'EXECUTE') then
      raise exception 'Low-level transition grants drifted: %', item;
    end if;
  end loop;
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.job_assignments'::regclass
       and tgname = 'ja_asset_client_guard' and tgenabled = 'O'
  ) or not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.client_media_assets'::regclass
       and tgname = 'cma_assignment_client_guard' and tgenabled = 'O'
  ) then
    raise exception 'Assignment asset/client guard missing';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.job_assignments'::regclass
       and conname = 'job_assignments_asset_client_fk'
       and contype = 'f' and convalidated
  ) or not exists (
    select 1 from pg_constraint
     where conrelid = 'public.job_assignments'::regclass
       and conname = 'job_assignments_asset_requires_client'
       and contype = 'c' and convalidated
  ) then
    raise exception 'Validated assignment asset/client constraints missing';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.client_onboarding_steps'::regclass
       and tgname = 'cos_protect_identity_and_completion'
       and tgenabled = 'O'
  ) or not exists (
    select 1 from pg_policy p
     where p.polrelid = 'public.client_onboarding_steps'::regclass
       and p.polname = 'cos_client_update'
       and p.polwithcheck is not null
       and pg_get_expr(p.polwithcheck, p.polrelid) <> 'true'
  ) then
    raise exception 'Client onboarding update guard or scoped WITH CHECK missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'outbound_messages'
       and column_name = 'client_id' and is_nullable = 'NO'
  ) then
    raise exception 'outbound_messages.client_id is missing or nullable';
  end if;
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'app_role' and e.enumlabel = 'admin'
  ) then
    raise exception 'app_role.admin enum value missing';
  end if;

  foreach item in array array[
    'engine-tick', 'publish-sweep', 'campaign-action-sweep',
    'lead-magnet-sweep', 'outbound-sweep', 'prune-runtime-heartbeats'
  ] loop
    if (select count(*) from cron.job where jobname = item and active) <> 1 then
      raise exception 'Expected exactly one active cron job named %', item;
    end if;
  end loop;

  -- Migration 11 must never leave its known fallback password in the local
  -- fixture, even before B004 removes that fallback from source control.
  if exists (
    select 1 from auth.users
     where encrypted_password = extensions.crypt('change-me', encrypted_password)
  ) then
    raise exception 'Known fallback password present after replay';
  end if;
end
$contract$;
