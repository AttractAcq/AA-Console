-- 271 · A signed-in Auth identity is not a provisioned console account.
-- Migration 270 stops automatically creating profiles. This closes the
-- remaining table and RPC paths that still treated any authenticated JWT as
-- a console user. Keep public signup disabled until this is released and
-- verified. All views in the production public schema are security-invoker;
-- these policies also govern their underlying rows.

-- Reference data is shared across console roles, but not with a newly
-- registered Auth identity that has no trusted profile. Preserve access for
-- every role provisioned through create_console_user().
drop policy if exists agents_read on public.agents;
create policy agents_read on public.agents for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists awareness_audience_map_read on public.awareness_audience_map;
create policy awareness_audience_map_read on public.awareness_audience_map for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists campaign_action_executors_read on public.campaign_action_executors;
create policy campaign_action_executors_read on public.campaign_action_executors for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists campaign_template_matrix_read on public.campaign_template_matrix;
create policy campaign_template_matrix_read on public.campaign_template_matrix for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists ec_read on public.engine_controls;
create policy ec_read on public.engine_controls for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists message_channels_read on public.message_channels;
create policy message_channels_read on public.message_channels for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists opportunity_score_factors_read on public.opportunity_score_factors;
create policy opportunity_score_factors_read on public.opportunity_score_factors for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists opportunity_transitions_read on public.opportunity_transitions;
create policy opportunity_transitions_read on public.opportunity_transitions for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists pfp_read on public.platform_format_publishing;
create policy pfp_read on public.platform_format_publishing for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists pp_read on public.platform_publishing;
create policy pp_read on public.platform_publishing for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists profile_field_support_read on public.profile_field_support;
create policy profile_field_support_read on public.profile_field_support for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists proof_destinations_read on public.proof_destinations;
create policy proof_destinations_read on public.proof_destinations for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists proof_placement_transitions_read on public.proof_placement_transitions;
create policy proof_placement_transitions_read on public.proof_placement_transitions for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists record_templates_read on public.record_templates;
create policy record_templates_read on public.record_templates for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists sp_read on public.slot_pipeline;
create policy sp_read on public.slot_pipeline for select to authenticated
  using (public.current_role_of() is not null);
drop policy if exists st_read on public.slot_transitions;
create policy st_read on public.slot_transitions for select to authenticated
  using (public.current_role_of() is not null);

-- A null client_id is an agency-wide record, not a wildcard client. Admin
-- policies already permit those records; scoped policies must not do so.
drop policy if exists agent_jobs_scoped_read on public.agent_jobs;
create policy agent_jobs_scoped_read on public.agent_jobs for select to authenticated
  using (client_id is not null and public.can_access_client(client_id));
drop policy if exists agent_job_events_scoped_read on public.agent_job_events;
create policy agent_job_events_scoped_read on public.agent_job_events for select to authenticated
  using (exists (
    select 1 from public.agent_jobs j
     where j.id = job_id and j.client_id is not null
       and public.can_access_client(j.client_id)
  ));
drop policy if exists campaigns_scoped_read on public.campaigns;
create policy campaigns_scoped_read on public.campaigns for select to authenticated
  using (client_id is not null and public.can_access_client(client_id));
drop policy if exists post_copy_scoped_read on public.post_copy;
create policy post_copy_scoped_read on public.post_copy for select to authenticated
  using (client_id is not null and public.can_access_client(client_id));
drop policy if exists sp_scoped_read on public.scheduled_posts;
create policy sp_scoped_read on public.scheduled_posts for select to authenticated
  using (client_id is not null and public.can_access_client(client_id));

-- This security-invoker view reads the system catalog, which has no RLS.
-- Keep its useful audit output for admins without exposing the full function
-- inventory to an arbitrary signed-in identity.
create or replace view public.security_definer_exposure with (security_invoker = true) as
select
  n.nspname as schema,
  p.proname as function,
  pg_get_function_identity_arguments(p.oid) as arguments,
  has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as signed_in_can_execute,
  (p.prosrc ~* public.caller_gate_markers()) as body_checks_the_caller
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'mcp_internal')
  and p.prosecdef
  and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'))
  and public.is_admin()
order by anon_can_execute desc, body_checks_the_caller, n.nspname, p.proname;

-- The human entry point from migration 63 allowed a null-client run without
-- checking the caller at all. All browser Run forms provide a client ID.
-- Agency-wide jobs can still be queued by a provisioned admin; client jobs
-- retain their existing per-client check and upstream gate.
create or replace function public.enqueue_agent_job(
  p_agent_key text, p_client_id uuid default null,
  p_input_table text default null, p_input_id uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_of() is null then
    raise exception 'A provisioned console account is required.' using errcode = '42501';
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

-- These two SECURITY DEFINER helpers resolve staff user IDs from arbitrary
-- client IDs. RLS policies use them, so keep authenticated EXECUTE while
-- making profileless calls return no person. Service workers and cron retain
-- their existing behavior when there is no human JWT.
create or replace function public.active_video_approval_manager(p_client_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select tm.user_id from public.client_assignments ca
  join public.team_members tm on tm.id = ca.member_id
  where ca.client_id = p_client_id and ca.ended_at is null
    and tm.active and tm.category = 'smm' and tm.user_id is not null
    and (auth.role() is distinct from 'authenticated'
         or public.current_role_of() is not null)
  order by ca.created_at desc, ca.id desc limit 1;
$$;

create or replace function public.active_creative_director(p_client_id uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, public as $$
  select tm.user_id from public.client_assignments ca
  join public.team_members tm on tm.id = ca.member_id
  where ca.client_id = p_client_id and ca.ended_at is null
    and tm.active and tm.category::text = 'creative_director' and tm.user_id is not null
    and (auth.role() is distinct from 'authenticated'
         or public.current_role_of() is not null)
  order by ca.created_at desc, ca.id desc limit 1;
$$;

-- Workers and cron, not browsers, enqueue these global sweeps. The worker
-- effect paths keep their exact-version Approval Inbox checks; revoking these
-- browser grants does not change those checks.
-- PostgreSQL function owners can call nested functions from SECURITY DEFINER
-- RPCs even when authenticated EXECUTE is removed here.
revoke execute on function public.enqueue_campaign_action_sweep() from authenticated;
revoke execute on function public.enqueue_lead_magnet_sweep() from authenticated;
revoke execute on function public.enqueue_outbound_sweep() from authenticated;
revoke execute on function public.enqueue_profile_update_sweep() from authenticated;
revoke execute on function public.enqueue_proof_placement_sweep() from authenticated;
revoke execute on function public.enqueue_publish_sweep() from authenticated;
revoke execute on function public.enqueue_sequence_sweep() from authenticated;
revoke execute on function public.enqueue_token_health_job() from authenticated;
revoke execute on function public.available_slots_v6(uuid, integer) from authenticated;
revoke execute on function public.can_run_agent(text, uuid) from authenticated;

select public.lock_down_definer_functions();
