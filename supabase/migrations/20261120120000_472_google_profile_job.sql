-- A provisioned AAL2 owner may request one exact approved Google profile
-- field operation. Runtime release is separate and remains off by default.
begin;

insert into public.agents
 (agent_key,name,initials,domain,description,requires_upstream,config,paused)
values ('google_profile_field_writer','Google Profile Field Writer','GP','google',
 'Applies one exact approved Business Profile field proposal with provider readback.',
 '{}','{}',false)
on conflict (agent_key) do nothing;

create unique index google_profile_one_write_job_v6
 on public.agent_jobs(input_id)
 where agent_key='google_profile_field_writer'
  and input_table='google_profile_changes' and input_id is not null;

create function public.request_google_profile_write_v6(p_change_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare m public.google_profile_changes%rowtype;
 l public.client_google_locations%rowtype;
 q public.google_profile_review_requests_v6%rowtype;
 i public.approval_inbox_v6%rowtype;
 v_job uuid;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null
  or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 owner must request this Google profile write.'
   using errcode='42501'; end if;
 select * into m from public.google_profile_changes where id=p_change_id for update;
 if m.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(m.client_id),false)) then
  raise exception 'Only the client approval owner may request this profile write.'
   using errcode='42501'; end if;
 if m.status<>'approved' or m.approved_request_id is null then
  raise exception 'An exact approved profile proposal is required.'
   using errcode='23514'; end if;
 select * into l from public.client_google_locations
  where id=m.location_id and client_id=m.client_id;
 select * into q from public.google_profile_review_requests_v6
  where canonical_request_id=m.approved_request_id and change_id=m.id
   and client_id=m.client_id;
 select * into i from public.approval_inbox_v6 where id=m.approved_request_id;
 if l.id is null or l.verification_state<>'verified'
  or q.id is null or i.id is null or i.status<>'approved'
  or i.source_kind<>'google_profile_change'
  or i.artifact_hash is distinct from m.approved_content_hash
  or q.source_hash is distinct from m.approved_content_hash
  or public.google_profile_review_source_state_v6(m.approved_request_id)<>'source_decided'
  or not exists(select 1 from public.profile_field_support f
    where f.surface='google_business' and f.platform='google'
     and f.field=m.field and f.writable) then
  raise exception 'The profile decision, location or field is no longer executable.'
   using errcode='23514'; end if;
 select id into v_job from public.agent_jobs
  where agent_key='google_profile_field_writer'
   and input_table='google_profile_changes' and input_id=m.id;
 if v_job is not null then return v_job; end if;
 if exists(select 1 from public.google_profile_execution_attempts_v6 a
  where a.change_id=m.id) then
  raise exception 'This profile proposal already has a reserved provider attempt.'
   using errcode='23514'; end if;
 insert into public.agent_jobs
  (agent_key,client_id,input_table,input_id,params,created_by)
 values ('google_profile_field_writer',m.client_id,'google_profile_changes',m.id,
  jsonb_build_object('change_id',m.id,'approval_request_id',m.approved_request_id),auth.uid())
 returning id into v_job;
 return v_job;
end $$;

revoke all on function public.request_google_profile_write_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.request_google_profile_write_v6(uuid)
 to authenticated;

select public.lock_down_definer_functions();
commit;
