-- Inspect an uncertain GitHub page publish through a GET. A file match does
-- not release the action or claim that the public form passed an intake probe.
begin;

create table public.campaign_page_readbacks_v6 (
 id uuid primary key default gen_random_uuid(),
 execution_id uuid not null references public.campaign_action_executions(id) on delete restrict,
 client_id uuid not null references public.clients(id) on delete restrict,
 repository_owner text not null,
 repository_name text not null,
 site_path text not null,
 checked_ref text not null,
 observed_sha256 text check (observed_sha256 is null or observed_sha256 ~ '^[0-9a-f]{64}$'),
 result text not null check (result in ('matches_expected','different','missing')),
 checked_at timestamptz not null default clock_timestamp()
);
create index campaign_page_readbacks_execution_idx
 on public.campaign_page_readbacks_v6(execution_id,checked_at desc,id desc);
alter table public.campaign_page_readbacks_v6 enable row level security;
revoke all on public.campaign_page_readbacks_v6 from public,anon,authenticated,service_role;

insert into public.agents
 (agent_key,name,initials,domain,description,requires_upstream,config,paused)
values ('campaign_page_reconciler','Campaign Page Readback','PR','website',
 'Reads a frozen GitHub page target after an uncertain publish without another commit.',
 '{}','{}',false)
on conflict (agent_key) do nothing;
create unique index campaign_page_one_active_readback_job_v6
 on public.agent_jobs(input_id)
 where agent_key='campaign_page_reconciler'
  and input_table='campaign_action_executions'
  and input_id is not null and status in ('queued','claimed','running','paused');

create function public.request_campaign_page_readback_v6(p_execution_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare e public.campaign_action_executions%rowtype;
 a public.campaign_action_approvals%rowtype;
 v_job uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null
  or public.current_role_of() is null or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 owner must request page readback.'
   using errcode='42501'; end if;
 select * into e from public.campaign_action_executions where id=p_execution_id for update;
 if e.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(e.client_id),false)) then
  raise exception 'Only the client approval owner may request page readback.'
   using errcode='42501'; end if;
 select * into a from public.campaign_action_approvals
  where id=e.approval_id and client_id=e.client_id;
 if a.id is null or a.action_key<>'page_deploy'
  or not (e.status='uncertain' or
   (e.status='executing' and (e.lease_until is null or e.lease_until<=now())))
  or not exists(select 1 from public.campaign_page_approval_snapshots s
   where s.approval_id=a.id and s.client_id=e.client_id) then
  raise exception 'An uncertain exact page publish is required.'
   using errcode='23514'; end if;
 select id into v_job from public.agent_jobs
  where agent_key='campaign_page_reconciler'
   and input_table='campaign_action_executions' and input_id=e.id
   and status in ('queued','claimed','running','paused')
  order by created_at desc limit 1;
 if v_job is not null then return v_job; end if;
 insert into public.agent_jobs
  (agent_key,client_id,input_table,input_id,params,created_by)
 values ('campaign_page_reconciler',e.client_id,'campaign_action_executions',e.id,
  jsonb_build_object('execution_id',e.id,'approval_id',a.id),auth.uid())
 returning id into v_job;
 return v_job;
end $$;

create function public.campaign_page_readback_target_v6(
 p_execution_id uuid,p_client_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare e public.campaign_action_executions%rowtype;
 a public.campaign_action_approvals%rowtype;
 s public.campaign_page_approval_snapshots%rowtype;
 r public.client_site_repositories%rowtype;
 v_expected text;
 v_ref text;
begin
 if auth.role() is distinct from 'service_role' then return null; end if;
 select * into e from public.campaign_action_executions
  where id=p_execution_id and client_id=p_client_id;
 select * into a from public.campaign_action_approvals
  where id=e.approval_id and client_id=e.client_id;
 select * into s from public.campaign_page_approval_snapshots
  where approval_id=a.id and client_id=e.client_id;
 select * into r from public.client_site_repositories
  where id=s.site_repository_id and client_id=e.client_id;
 if e.id is null or a.id is null or s.approval_id is null or r.id is null
  or a.action_key<>'page_deploy'
  or not (e.status='uncertain' or
   (e.status='executing' and (e.lease_until is null or e.lease_until<=now())))
  or a.artifact_version_hash is distinct from s.rendered_sha256
  or a.scope->>'page_id' is distinct from s.page_id::text
  or a.scope->>'site_repository_id' is distinct from r.id::text
  or a.scope->>'site_path' is distinct from s.site_path
  or a.scope->>'owner' is distinct from r.owner
  or a.scope->>'repository' is distinct from r.repo
  or a.scope->>'default_branch' is distinct from r.default_branch
  or r.owner !~ '^[A-Za-z0-9_.-]+$'
  or r.repo !~ '^[A-Za-z0-9_.-]+$'
  or s.site_path !~ '^[A-Za-z0-9_./-]+$'
  or s.site_path like '%..%' then return null; end if;
 v_expected:=case when e.result->>'published_sha256' ~ '^[0-9a-f]{64}$'
  then e.result->>'published_sha256' else s.rendered_sha256 end;
 v_ref:=case when e.external_id ~ '^[0-9a-f]{40}$'
  then e.external_id else r.default_branch end;
 return jsonb_build_object('execution_id',e.id,'client_id',e.client_id,
  'repository_owner',r.owner,'repository_name',r.repo,
  'site_path',s.site_path,'checked_ref',v_ref,
  'expected_sha256',v_expected,
  'expected_kind',case when v_expected=s.rendered_sha256 then 'reviewed_html'
   else 'published_bytes' end);
end $$;

create function public.record_campaign_page_readback_v6(
 p_execution_id uuid,p_client_id uuid,p_repository_owner text,
 p_repository_name text,p_site_path text,p_checked_ref text,
 p_observed_sha256 text)
returns text language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare v_target jsonb; v_result text;
begin
 if auth.role() is distinct from 'service_role' then
  raise exception 'Only the trusted GitHub reader may record page readback.'
   using errcode='42501'; end if;
 perform 1 from public.campaign_action_executions
  where id=p_execution_id and client_id=p_client_id for update;
 v_target:=public.campaign_page_readback_target_v6(p_execution_id,p_client_id);
 if v_target is null
  or p_repository_owner is distinct from v_target->>'repository_owner'
  or p_repository_name is distinct from v_target->>'repository_name'
  or p_site_path is distinct from v_target->>'site_path'
  or p_checked_ref is distinct from v_target->>'checked_ref'
  or (p_observed_sha256 is not null and p_observed_sha256 !~ '^[0-9a-f]{64}$') then
  raise exception 'The uncertain page target or observation changed.'
   using errcode='23514'; end if;
 v_result:=case when p_observed_sha256 is null then 'missing'
  when p_observed_sha256=v_target->>'expected_sha256' then 'matches_expected'
  else 'different' end;
 insert into public.campaign_page_readbacks_v6
  (execution_id,client_id,repository_owner,repository_name,site_path,
   checked_ref,observed_sha256,result)
 values (p_execution_id,p_client_id,p_repository_owner,p_repository_name,p_site_path,
  p_checked_ref,p_observed_sha256,v_result);
 return v_result;
end $$;

create view public.campaign_page_readback_overview_v6
with (security_barrier=true) as
select r.id,r.execution_id,r.client_id,r.repository_owner,r.repository_name,
 r.site_path,r.checked_ref,r.observed_sha256,r.result,r.checked_at
from public.campaign_page_readbacks_v6 r
where public.can_access_client(r.client_id);

revoke all on function public.request_campaign_page_readback_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.request_campaign_page_readback_v6(uuid) to authenticated;
revoke all on function public.campaign_page_readback_target_v6(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.campaign_page_readback_target_v6(uuid,uuid) to service_role;
revoke all on function public.record_campaign_page_readback_v6(uuid,uuid,text,text,text,text,text)
 from public,anon,authenticated,service_role;
grant execute on function public.record_campaign_page_readback_v6(uuid,uuid,text,text,text,text,text)
 to service_role;
revoke all on public.campaign_page_readback_overview_v6
 from public,anon,authenticated,service_role;
grant select on public.campaign_page_readback_overview_v6 to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','274 exact HTML preview and page snapshot',
 'verified','274 AAL2 action decision; 330 prewrite recheck',
 'blocked','page-deploy GitHub commit and intake probe; 490 uncertainty; 494 owner-requested read-only GitHub observation',
 'Verify an authorized live publish and intake probe; inspect uncertain commits and historical page effects.'
from public.approval_class_coverage_v6 c where c.class_id=27;

select public.lock_down_definer_functions();
commit;
