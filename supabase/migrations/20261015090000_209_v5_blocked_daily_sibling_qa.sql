-- A failed reel must not hide already completed story/static work. Keep the
-- package blocked, but settle independent completed jobs with the same daily
-- QA rules and evidence used by a healthy run. No blocked step is reopened.
create function settle_completed_blocked_daily_siblings(p_limit integer default 5)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_run workflow_runs;
  v_before integer;
  v_after integer;
  v_accepted integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if p_limit not between 1 and 20 then raise exception 'Limit must be 1..20.'; end if;
  for v_run in select r.* from workflow_runs r
    where r.kind = 'daily_content_package' and r.status = 'blocked'
      and exists (select 1 from workflow_steps blocked
        where blocked.run_id = r.id and blocked.status = 'blocked')
      and exists (select 1 from workflow_steps s
        left join agent_jobs j on j.id = s.job_id
        where s.run_id = r.id and (s.status = 'needs_internal_qa'
          or (s.status in ('queued', 'running') and j.status = 'completed')))
    order by r.deadline_at, r.created_at
    for update skip locked limit p_limit
  loop
    select count(*) into v_before from workflow_steps
      where run_id = v_run.id and status = 'completed';
    update workflow_steps s set status = 'needs_internal_qa', updated_at = now()
      from agent_jobs j where s.run_id = v_run.id and s.job_id = j.id
        and s.status in ('queued', 'running') and j.status = 'completed';
    -- The existing QA function requires this run state. It and the caller
    -- share one transaction and hold the run lock; no other worker observes
    -- this temporary state. A failed QA remains an honest blocked step.
    update workflow_runs set status = 'needs_internal_qa', blocker = null,
      updated_at = now() where id = v_run.id;
    perform accept_ready_daily_workflow_steps(50);
    update workflow_runs r set status = 'blocked',
      blocker = (select s.blocker from workflow_steps s
        where s.run_id = r.id and s.status = 'blocked'
        order by s.created_at, s.id limit 1), updated_at = now()
      where r.id = v_run.id;
    select count(*) into v_after from workflow_steps
      where run_id = v_run.id and status = 'completed';
    v_accepted := v_accepted + v_after - v_before;
  end loop;
  return v_accepted;
end;
$$;
revoke all on function settle_completed_blocked_daily_siblings(integer)
  from public, anon, authenticated;
grant execute on function settle_completed_blocked_daily_siblings(integer)
  to service_role;
select lock_down_definer_functions();
