-- Phase 2: the client switch can be enabled only against a fresh, matching
-- deployed owned-claim worker. The old unfiltered claim stays revoked.
begin;
create or replace function public.set_campaign_actions_enabled(
  p_client_id uuid, p_enabled boolean)
returns public.client_engine_settings
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_row public.client_engine_settings%rowtype;
  v_runtime jsonb;
  v_sha text;
  v_supported integer;
begin
  if p_client_id is null or public.can_access_client(p_client_id) is not true then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;
  if not (coalesce(public.is_admin(),false) or
    coalesce(auth.uid() = public.active_video_approval_manager(p_client_id),false)) then
    raise exception 'Only an admin or the active client manager may change this.'
      using errcode = '42501';
  end if;
  if p_enabled is null then raise exception 'Choose on or off.' using errcode = '22023'; end if;
  if p_enabled then
    if auth.role() is distinct from 'authenticated' or auth.uid() is null
      or public.current_role_of() is null or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
      raise exception 'A provisioned human with AAL2 must enable campaign actions.'
        using errcode = '42501';
    end if;
    v_runtime := public.client_runtime_controls_v6(p_client_id);
    v_sha := v_runtime->>'version';
    if v_runtime->>'state' is distinct from 'observed'
      or v_runtime->>'workerEnabled' is distinct from 'true'
      or v_runtime->'controls'->>'campaignActions' is distinct from 'true'
      or nullif(v_runtime->'holds'->>'campaignActions','') is not null
      or v_sha is null or v_sha !~ '^[0-9a-f]{40}$' then
      raise exception 'A live owned-claim runtime is not verified for this client.'
        using errcode = '23514';
    end if;
    select count(*) into v_supported
      from public.campaign_action_executors e
     where e.supported and e.handler_attested_sha = v_sha
       and (e.action_key,e.executor_module) in (
         ('proof_publish','proof_distribution'),
         ('page_deploy','website_studio'),
         ('lead_message','sales_os'),
         ('budget_change','meta_ads_studio'));
    if v_supported <> 4 then
      raise exception 'The four runtime handlers are not attested to this build.'
        using errcode = '23514';
    end if;
  end if;
  insert into public.client_engine_settings
    (client_id,campaign_actions_enabled,campaign_actions_enabled_at,campaign_actions_enabled_by)
  values (p_client_id,p_enabled,case when p_enabled then now() end,
    case when p_enabled then auth.uid() end)
  on conflict (client_id) do update set
    campaign_actions_enabled = excluded.campaign_actions_enabled,
    campaign_actions_enabled_at = case when excluded.campaign_actions_enabled
      then now() else client_engine_settings.campaign_actions_enabled_at end,
    campaign_actions_enabled_by = case when excluded.campaign_actions_enabled
      then auth.uid() else client_engine_settings.campaign_actions_enabled_by end
  returning * into v_row;
  return v_row;
end $$;
revoke all on function public.set_campaign_actions_enabled(uuid,boolean)
  from public,anon,service_role;
grant execute on function public.set_campaign_actions_enabled(uuid,boolean)
  to authenticated;
select public.lock_down_definer_functions();
commit;
