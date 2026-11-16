-- A page or sales-agent producer can be retried without replacing its sibling
-- work or asking the operator to restart the campaign sweep.
create function public.retry_campaign_conversion_step_v7(p_step_id uuid)
returns public.workflow_steps
language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  s public.workflow_steps%rowtype;
  r public.workflow_runs%rowtype;
  d public.campaign_conversion_drafts_v7%rowtype;
  c public.client_campaigns%rowtype;
  w public.delivery_work_items_v6%rowtype;
  j public.agent_jobs%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
     or public.current_role_of() is null then
    raise exception 'A signed-in console operator is required.' using errcode='42501';
  end if;
  select * into s from public.workflow_steps where id=p_step_id;
  if not found then raise exception 'Workflow step not found.'; end if;
  select * into r from public.workflow_runs where id=s.run_id for update;
  select * into s from public.workflow_steps where id=p_step_id for update;
  if r.kind<>'campaign_sweep' or r.sealed_at is null
     or r.deadline_at<=now() or s.status not in ('blocked','failed')
     or s.step_key not in ('conversion_page','conversion_sales_agent')
     or exists(select 1 from public.workflow_artifacts where step_id=s.id) then
    raise exception 'This conversion step is not eligible for retry.';
  end if;
  if not public.can_access_client(r.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  select * into c from public.client_campaigns where id=r.campaign_id;
  select * into d from public.campaign_conversion_drafts_v7 where run_id=r.id;
  if c.id is null or d.run_id is null
     or public.campaign_sweep_blocker_v6(c.id) is not null
     or d.plan_fingerprint<>public.campaign_plan_fingerprint(c)
     or d.run_id<>(select newer.run_id from public.campaign_conversion_drafts_v7 newer
       where newer.campaign_id=c.id order by newer.created_at desc,newer.run_id desc limit 1)
  then raise exception 'The current approved campaign package is required.'; end if;
  select w0.* into w from public.campaign_conversion_work_bindings_v7 b
    join public.delivery_work_items_v6 w0 on w0.id=b.work_item_id
    where b.run_id=r.id and b.step_key=s.step_key;
  if not found or w.state<>'held' then
    raise exception 'The blocked step has no held conversion work item.';
  end if;
  if s.job_id is not null then
    select * into j from public.agent_jobs where id=s.job_id;
    if j.status not in ('failed','cancelled','completed') then
      raise exception 'The prior producer job is still active.';
    end if;
  end if;
  insert into public.campaign_sweep_step_retries_v7
    (client_id,campaign_id,run_id,step_id,prior_job_id,prior_blocker,requested_by)
  values(r.client_id,c.id,r.id,s.id,s.job_id,
    coalesce(nullif(btrim(s.blocker),''),'Conversion producer failed.'),auth.uid());
  update public.workflow_steps set status='pending',blocker=null,job_id=null,
    resolved_input_id=null,completed_at=null,updated_at=now()
    where id=s.id returning * into s;
  update public.workflow_runs run set
    status=case when exists(select 1 from public.workflow_steps other
      where other.run_id=run.id and other.status in ('blocked','failed'))
      then 'blocked' else 'running' end,
    blocker=(select other.blocker from public.workflow_steps other
      where other.run_id=run.id and other.status in ('blocked','failed')
      order by other.created_at,other.id limit 1),updated_at=now()
    where id=r.id;
  return s;
end $$;

revoke all on function public.retry_campaign_conversion_step_v7(uuid)
  from public,anon;
grant execute on function public.retry_campaign_conversion_step_v7(uuid)
  to authenticated;
select public.lock_down_definer_functions();
