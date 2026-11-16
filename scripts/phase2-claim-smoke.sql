-- Run against a local database with migrations through 325 applied.
-- This checks the outer fail-closed boundary without creating an approval.
do $checks$
declare
  v_worker text := 'agent-runtime:1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_sha text := repeat('a', 40);
begin
  if has_function_privilege('service_role', 'public.claim_campaign_actions(integer)', 'execute') then
    raise exception 'Legacy unfiltered claim remains executable';
  end if;
  if has_function_privilege('anon', 'public.claim_campaign_actions_owned_v6(text,text,jsonb,integer)', 'execute') then
    raise exception 'Anonymous caller can execute owned claim';
  end if;
  if not has_function_privilege('service_role', 'public.claim_campaign_actions_owned_v6(text,text,jsonb,integer)', 'execute') then
    raise exception 'Internal service cannot execute owned claim';
  end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  begin
    perform * from public.claim_campaign_actions_owned_v6(
      v_worker, v_sha, '{"proof_publish":"proof_distribution"}'::jsonb, 1);
    raise exception 'Human caller passed the service-role guard';
  exception when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  begin
    perform * from public.claim_campaign_actions_owned_v6(v_worker, v_sha, '{}'::jsonb, 1);
    raise exception 'Empty handler map was accepted';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform * from public.claim_campaign_actions_owned_v6(
      v_worker, v_sha, '{"proof_publish":"proof_distribution"}'::jsonb, 1);
    raise exception 'A worker with no fresh heartbeat claimed work';
  exception when check_violation then null;
  end;
end;
$checks$;
