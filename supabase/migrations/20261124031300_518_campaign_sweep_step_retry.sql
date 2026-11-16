-- Phase 4: an operator may retry one blocked internal campaign producer.
-- Prior jobs and outputs remain in the audit trail; sibling steps are untouched.
create table public.campaign_sweep_step_retries_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid not null references public.client_campaigns(id) on delete cascade,
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  step_id uuid not null references public.workflow_steps(id) on delete cascade,
  prior_job_id uuid references public.agent_jobs(id) on delete set null,
  prior_blocker text not null,
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now()
);
create index campaign_sweep_step_retries_v7_step_idx
  on public.campaign_sweep_step_retries_v7(step_id, requested_at desc);
alter table public.campaign_sweep_step_retries_v7 enable row level security;
create policy campaign_sweep_step_retries_v7_read
  on public.campaign_sweep_step_retries_v7 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.campaign_sweep_step_retries_v7 from public, anon, authenticated;
grant select on public.campaign_sweep_step_retries_v7 to authenticated;
grant all on public.campaign_sweep_step_retries_v7 to service_role;

create function public.retry_campaign_sweep_step_v7(p_step_id uuid)
returns public.workflow_steps
language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  v_run public.workflow_runs%rowtype;
  v_step public.workflow_steps%rowtype;
  v_job public.agent_jobs%rowtype;
  v_work public.delivery_work_items_v6%rowtype;
  v_route public.campaign_route_packages_v6%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_blocker text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
     or public.current_role_of() is null then
    raise exception 'A signed-in console operator is required.' using errcode = '42501';
  end if;
  select * into v_step from public.workflow_steps where id = p_step_id;
  if not found then raise exception 'Workflow step not found.'; end if;
  select * into v_run from public.workflow_runs where id = v_step.run_id for update;
  select * into v_step from public.workflow_steps where id = p_step_id for update;
  if v_run.kind <> 'campaign_sweep' or v_run.sealed_at is null
     or v_run.deadline_at <= now() or v_step.status not in ('blocked','failed')
     or exists (select 1 from public.workflow_artifacts where step_id = v_step.id) then
    raise exception 'This step is not eligible for retry.';
  end if;
  if not public.can_access_client(v_run.client_id) then
    raise exception 'Not permitted for this client.' using errcode = '42501';
  end if;
  select * into v_campaign from public.client_campaigns where id = v_run.campaign_id;
  if not found or public.campaign_sweep_blocker_v6(v_campaign.id) is not null then
    raise exception 'The campaign plan must be current and approved before retry.';
  end if;
  select w.* into v_work from public.campaign_sweep_work_bindings_v7 b
    join public.delivery_work_items_v6 w on w.id = b.work_item_id
    where b.run_id = v_run.id
      and left(v_step.step_key, length(b.piece_key) + 1) = b.piece_key || '_';
  if not found or v_work.state <> 'held' then
    raise exception 'The blocked step has no held campaign work item.';
  end if;
  select * into v_route from public.campaign_route_packages_v6
    where id = v_work.route_package_id;
  if not found or v_route.plan_fingerprint <> public.campaign_plan_fingerprint(v_campaign)
     or v_route.version <> (select max(version) from public.campaign_route_packages_v6
       where campaign_id = v_campaign.id and route = v_route.route) then
    raise exception 'The route package has been superseded; review the current plan.';
  end if;
  if v_step.job_id is not null then
    select * into v_job from public.agent_jobs where id = v_step.job_id;
    if v_job.status not in ('failed','cancelled','completed') then
      raise exception 'The prior job is still active.';
    end if;
  end if;
  v_blocker := coalesce(nullif(btrim(v_step.blocker),''), 'Internal producer failed.');
  insert into public.campaign_sweep_step_retries_v7
    (client_id,campaign_id,run_id,step_id,prior_job_id,prior_blocker,requested_by)
  values (v_run.client_id,v_campaign.id,v_run.id,v_step.id,v_step.job_id,
    v_blocker,auth.uid());
  update public.workflow_steps set status='pending', blocker=null,
    job_id=null, resolved_input_id=null, completed_at=null, updated_at=now()
    where id=v_step.id returning * into v_step;
  update public.workflow_runs r set
    status=case when exists (select 1 from public.workflow_steps s
      where s.run_id=r.id and s.status in ('blocked','failed'))
      then 'blocked' else 'running' end,
    blocker=(select s.blocker from public.workflow_steps s
      where s.run_id=r.id and s.status in ('blocked','failed')
      order by s.created_at,s.id limit 1), updated_at=now()
    where id=v_run.id;
  return v_step;
end $$;

revoke all on function public.retry_campaign_sweep_step_v7(uuid)
  from public, anon;
grant execute on function public.retry_campaign_sweep_step_v7(uuid)
  to authenticated;
select public.lock_down_definer_functions();
