-- v6.1 / 1.2: say how many opportunities to look for.
--
-- The notes: "for the 'find opportunities' button to actually run, there is no
-- way to instruct it how many opportunities to assess; this full control is
-- important, and the functionality should be added so we can search for
-- however many opportunities we want".
--
-- WHY THIS IS NOT A FORM FIELD
--
-- `enqueue_agent_job`, the RPC the browser calls, takes an agent key, a client
-- and an optional input row. It has no parameter channel at all. The column
-- exists -- `agent_jobs.params` is jsonb and 395 jobs carry real values in it
-- -- but everything that writes it today is the MCP gateway, a cron, or an
-- internal service-role caller. No browser has ever set a job parameter.
--
-- The quick version would have been to add `p_params jsonb` to
-- `enqueue_agent_job`. That hands any signed-in caller the ability to shape the
-- input of every agent in the system, for one screen's benefit. The agents read
-- their params to decide what to produce and how much of it, so that is a
-- widening of what a browser can tell the runtime to do, and it would be
-- invisible at the call site.
--
-- So this is a narrow writer instead, the same shape as 281's and 282's: one
-- named thing, one validated argument, one agent. The generic enqueuer is
-- untouched and no other agent becomes browser-steerable.
--
-- THE CEILING STAYS WHERE IT IS
--
-- The agent refuses a submission of more than 8 and its prompt asks for between
-- two and eight. That limit is about cost and about the model holding a set of
-- genuinely distinct buying situations in one pass, so this does not raise it
-- on its own authority: the argument is bounded to the range the agent already
-- proves it can honour. Raising it is a deliberate decision with a provider
-- bill attached, and it belongs with evidence rather than with a screen.

create or replace function public.request_opportunity_discovery_v6(
  p_client_id uuid,
  p_count integer default 4
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_running integer;
  v_job uuid;
begin
  if public.current_role_of() is null then
    raise exception 'A provisioned console account is required.' using errcode = '42501';
  end if;
  if p_client_id is null or not public.can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;

  -- The agent's own ceiling, stated here so the refusal arrives before a job
  -- is queued rather than as a failed run the operator has to go and read.
  if p_count is null or p_count < 2 or p_count > 8 then
    raise exception 'Ask for between 2 and 8 opportunities in one pass. One is not a comparison and more than eight stops being distinct.'
      using errcode = 'P0001';
  end if;

  -- A second pass while the first is still running produces two sets of
  -- hypotheses against the same intelligence and no way to tell which run
  -- proposed what.
  select count(*) into v_running from public.agent_jobs j
   where j.agent_key = 'opportunity_discovery'
     and j.client_id = p_client_id
     and j.status in ('queued', 'claimed', 'running');
  if v_running > 0 then
    raise exception 'A discovery pass is already queued or running for this client.'
      using errcode = 'P0001';
  end if;

  v_job := public.enqueue_agent_job_internal(
    'opportunity_discovery', p_client_id, null, null, auth.uid(),
    jsonb_build_object('opportunity_count', p_count),
    'Queued: look for ' || p_count || ' opportunities'
  );
  return v_job;
end $$;

comment on function public.request_opportunity_discovery_v6(uuid, integer) is
  'Queues one opportunity discovery pass for this client, asking for a given number of opportunities. The only browser-reachable way to set a job parameter, deliberately narrow: the generic enqueue_agent_job still takes none, so no other agent becomes steerable from a browser.';

revoke all on function public.request_opportunity_discovery_v6(uuid, integer) from public, anon;
grant execute on function public.request_opportunity_discovery_v6(uuid, integer) to authenticated, service_role;

select lock_down_definer_functions();
