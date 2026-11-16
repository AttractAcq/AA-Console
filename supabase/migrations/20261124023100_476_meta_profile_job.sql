-- One operator-requested Facebook Page field job per exact approval.
-- Runtime release remains separately off by default.
begin;

insert into public.agents
 (agent_key,name,initials,domain,description,requires_upstream,config,paused)
values ('meta_profile_field_writer','Meta Page Field Writer','MP','meta',
 'Applies one exact approved Facebook Page field proposal with provider readback.',
 '{}','{}',false)
on conflict (agent_key) do nothing;

create unique index meta_profile_one_write_job_v6
 on public.agent_jobs(input_id)
 where agent_key='meta_profile_field_writer'
  and input_table='meta_profile_changes' and input_id is not null;

create function public.request_meta_profile_write_v6(p_change_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare m public.meta_profile_changes%rowtype;
 q public.meta_profile_review_requests_v6%rowtype;
 i public.approval_inbox_v6%rowtype;
 v_job uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null
  or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 owner must request this Meta Page write.'
   using errcode='42501'; end if;
 select * into m from public.meta_profile_changes where id=p_change_id for update;
 if m.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(m.client_id),false)) then
  raise exception 'Only the client approval owner may request this Meta Page write.'
   using errcode='42501'; end if;
 if m.status<>'approved' or m.platform<>'facebook'
  or m.approved_request_id is null then
  raise exception 'An exact approved Facebook Page proposal is required.'
   using errcode='23514'; end if;
 select * into q from public.meta_profile_review_requests_v6
  where canonical_request_id=m.approved_request_id and change_id=m.id
   and client_id=m.client_id;
 select * into i from public.approval_inbox_v6 where id=m.approved_request_id;
 if q.id is null or i.id is null or i.status<>'approved'
  or i.source_kind<>'meta_profile_change'
  or i.artifact_hash is distinct from m.approved_content_hash
  or q.source_hash is distinct from m.approved_content_hash
  or public.meta_profile_review_source_state_v6(m.approved_request_id)<>'source_decided'
  or i.preview->'target' is distinct from
   public.meta_profile_target_snapshot_v6(m.client_id,m.platform)
  or coalesce(i.preview->'target'->>'account_ref','') !~ '^[0-9]+$'
  or not exists(select 1 from public.profile_field_support f
   where f.surface='meta' and f.platform='facebook'
    and f.field=m.field and f.writable) then
  raise exception 'The Meta Page decision, target or field is no longer executable.'
   using errcode='23514'; end if;
 select id into v_job from public.agent_jobs
  where agent_key='meta_profile_field_writer'
   and input_table='meta_profile_changes' and input_id=m.id;
 if v_job is not null then return v_job; end if;
 if exists(select 1 from public.meta_profile_execution_attempts_v6 a
  where a.change_id=m.id) then
  raise exception 'This Meta proposal already has a reserved provider attempt.'
   using errcode='23514'; end if;
 insert into public.agent_jobs
  (agent_key,client_id,input_table,input_id,params,created_by)
 values ('meta_profile_field_writer',m.client_id,'meta_profile_changes',m.id,
  jsonb_build_object('change_id',m.id,'approval_request_id',m.approved_request_id),auth.uid())
 returning id into v_job;
 return v_job;
end $$;

revoke all on function public.request_meta_profile_write_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.request_meta_profile_write_v6(uuid)
 to authenticated;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (23,4,'meta_profile_change','Meta profile change',
 'verified','387 exact proposal preview; 469 revision epoch; 470 Page target binding',
 'verified','387 source-owned AAL2 decision; 470 current Page/write-credential prewrite; 475 owner-requested job',
 'blocked','474 one-shot outcome ledger; isolated Page-token transport; 475 default-off controlled worker',
 'Verify the live Page token and provider readback, reconcile source status and historical approvals, authorize release and observe a test receipt.');

select public.lock_down_definer_functions();
commit;
