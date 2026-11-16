-- The approval owner explicitly requests a GET-only check of an uncertain reply.
begin;

insert into public.agents
 (agent_key,name,initials,domain,description,requires_upstream,config,paused)
values ('google_reply_reconciler','Google Reply Readback','GR','google',
 'Reads one uncertain Business Profile review reply and records its moderation state.',
 '{}','{}',false)
on conflict (agent_key) do nothing;

create unique index google_reply_one_active_reconciliation_job_v6
 on public.agent_jobs(input_id)
 where agent_key='google_reply_reconciler'
  and input_table='google_reply_execution_attempts_v6'
  and input_id is not null and status in ('queued','claimed','running','paused');

create function public.request_google_reply_reconciliation_v6(p_attempt_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.google_reply_execution_attempts_v6%rowtype;
 v_job uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null
  or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 owner must request reply readback.'
   using errcode='42501'; end if;
 select * into a from public.google_reply_execution_attempts_v6
  where id=p_attempt_id for update;
 if a.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(a.client_id),false)) then
  raise exception 'Only the client approval owner may request reply readback.'
   using errcode='42501'; end if;
 if a.status<>'uncertain' or exists(select 1
  from public.google_reply_reconciliation_checks_v6 c
  where c.attempt_id=a.id and c.result='matched') then
  raise exception 'Only an unresolved uncertain reply can be checked.'
   using errcode='23514'; end if;
 select id into v_job from public.agent_jobs
  where agent_key='google_reply_reconciler'
   and input_table='google_reply_execution_attempts_v6'
   and input_id=a.id and status in ('queued','claimed','running','paused')
  order by created_at desc limit 1;
 if v_job is not null then return v_job; end if;
 insert into public.agent_jobs
  (agent_key,client_id,input_table,input_id,params,created_by)
 values ('google_reply_reconciler',a.client_id,
  'google_reply_execution_attempts_v6',a.id,
  jsonb_build_object('attempt_id',a.id,'reply_id',a.reply_id),auth.uid())
 returning id into v_job;
 return v_job;
end $$;

revoke all on function public.request_google_reply_reconciliation_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.request_google_reply_reconciliation_v6(uuid)
 to authenticated;

select public.lock_down_definer_functions();
commit;
