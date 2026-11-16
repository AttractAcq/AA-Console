-- An AAL2 owner may request a read-only check after an uncertain Page write.
-- A finished different-value check can be requested again; no write is retried.
begin;

insert into public.agents
 (agent_key,name,initials,domain,description,requires_upstream,config,paused)
values ('meta_profile_field_reconciler','Meta Page Readback','MR','meta',
 'Reads an uncertain Facebook Page field and records what the provider shows.',
 '{}','{}',false)
on conflict (agent_key) do nothing;

create unique index meta_profile_one_active_reconciliation_job_v6
 on public.agent_jobs(input_id)
 where agent_key='meta_profile_field_reconciler'
  and input_table='meta_profile_execution_attempts_v6'
  and input_id is not null and status in ('queued','claimed','running','paused');

create function public.request_meta_profile_reconciliation_v6(p_attempt_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.meta_profile_execution_attempts_v6%rowtype;
 v_job uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null
  or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 owner must request this Page readback.'
   using errcode='42501'; end if;
 select * into a from public.meta_profile_execution_attempts_v6
  where id=p_attempt_id for update;
 if a.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(a.client_id),false)) then
  raise exception 'Only the client approval owner may request Page readback.'
   using errcode='42501'; end if;
 if a.status<>'uncertain' or exists(select 1
  from public.meta_profile_reconciliation_checks_v6 c
  where c.attempt_id=a.id and c.result='matched') then
  raise exception 'Only an uncertain Page write can be reconciled.'
   using errcode='23514'; end if;
 select id into v_job from public.agent_jobs
  where agent_key='meta_profile_field_reconciler'
   and input_table='meta_profile_execution_attempts_v6'
   and input_id=a.id and status in ('queued','claimed','running','paused')
  order by created_at desc limit 1;
 if v_job is not null then return v_job; end if;
 insert into public.agent_jobs
  (agent_key,client_id,input_table,input_id,params,created_by)
 values ('meta_profile_field_reconciler',a.client_id,
  'meta_profile_execution_attempts_v6',a.id,
  jsonb_build_object('attempt_id',a.id,'change_id',a.change_id),auth.uid())
 returning id into v_job;
 return v_job;
end $$;

revoke all on function public.request_meta_profile_reconciliation_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.request_meta_profile_reconciliation_v6(uuid)
 to authenticated;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (23,7,'meta_profile_change','Meta profile change',
 'verified','387 exact proposal; 469 epoch; 470 Page target binding',
 'verified','387 AAL2 decision; 475 controlled write; 480 AAL2 read-only reconciliation request',
 'blocked','474 one-shot attempt; 476 confirmed source; 479 immutable uncertain readback; 480 separate read-only job',
 'Audit historical approvals, verify live Page token, review release of the held writer and observe a provider receipt.');

select public.lock_down_definer_functions();
commit;
