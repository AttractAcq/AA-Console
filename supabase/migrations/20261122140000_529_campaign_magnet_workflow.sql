-- The PDF producer is an internal campaign sweep step. Its exact bytes must
-- be downloaded by the trusted runtime before SQL may accept the output.
insert into public.agents(agent_key,name,initials,domain,description,requires_upstream,requires_input)
values('lead_magnet_build','Lead Magnet Builder','LM','production',
  'Builds a plan-bound PDF guide and an immutable file version; never delivers it.',
  array[]::text[],true)
on conflict(agent_key) do nothing;

create table public.campaign_magnet_byte_checks_v7 (
  version_id uuid primary key references public.lead_magnet_versions(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  content_sha256 text not null check(content_sha256 ~ '^[0-9a-f]{64}$'),
  file_bytes bigint not null check(file_bytes>0),
  checked_at timestamptz not null default now()
);
alter table public.campaign_magnet_byte_checks_v7 enable row level security;
revoke all on public.campaign_magnet_byte_checks_v7 from public,anon,authenticated;
grant all on public.campaign_magnet_byte_checks_v7 to service_role;

create function public.accept_ready_campaign_magnet_steps_v7(p_limit integer default 20)
returns table(steps_accepted integer,steps_blocked integer)
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare s public.workflow_steps%rowtype;
  r public.workflow_runs%rowtype;
  j public.agent_jobs%rowtype;
  d public.campaign_magnet_drafts_v7%rowtype;
  v public.lead_magnet_versions%rowtype;
  b public.campaign_magnet_byte_checks_v7%rowtype;
  c public.client_campaigns%rowtype;
  v_reason text;
  v_accepted integer:=0;
  v_blocked integer:=0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted QA worker is required.' using errcode='42501';
  end if;
  if p_limit not between 1 and 50 then raise exception 'Limit must be 1..50.'; end if;
  for s in select x.* from public.workflow_steps x
    join public.workflow_runs r0 on r0.id=x.run_id
    where r0.kind='campaign_sweep' and r0.status='needs_internal_qa'
      and x.status='needs_internal_qa' and x.step_key='conversion_lead_magnet'
    order by r0.deadline_at,x.created_at for update of x skip locked limit p_limit
  loop
    select * into r from public.workflow_runs where id=s.run_id for update;
    select * into j from public.agent_jobs where id=s.job_id;
    select * into d from public.campaign_magnet_drafts_v7 where run_id=r.id;
    select * into c from public.client_campaigns where id=r.campaign_id;
    select * into v from public.lead_magnet_versions
      where magnet_id=d.magnet_id and client_id=r.client_id
        and created_by_job_id=j.id order by version desc limit 1;
    select * into b from public.campaign_magnet_byte_checks_v7 where version_id=v.id;
    v_reason:=null;
    if j.status is distinct from 'completed' then
      v_reason:='The magnet producer job is not complete.';
    elsif d.run_id is null or c.id is null or d.campaign_id<>c.id
        or d.plan_fingerprint is distinct from public.campaign_plan_fingerprint(c)
        or c.plan_approved_fingerprint is distinct from d.plan_fingerprint then
      v_reason:='The reviewed campaign plan changed before magnet QA.';
    elsif v.id is null or s.resolved_input_id is distinct from d.magnet_id
        or v.media_type<>'application/pdf' or v.file_bytes<100
        or v.delivery_channel<>'download_link' then
      v_reason:='The magnet has no exact PDF version from this producer job.';
    elsif b.version_id is null then
      -- Storage download may be temporarily unavailable. Keep QA pending.
      continue;
    elsif b.job_id<>j.id or b.client_id<>r.client_id
        or b.content_sha256<>v.content_sha256 or b.file_bytes<>v.file_bytes then
      v_reason:='Stored magnet bytes differ from the immutable version.';
    end if;
    if v_reason is not null then
      update public.workflow_steps set status='blocked',blocker=v_reason,
        updated_at=now() where id=s.id;
      update public.workflow_runs set status='blocked',blocker=v_reason,
        updated_at=now() where id=r.id;
      v_blocked:=v_blocked+1;
      continue;
    end if;
    insert into public.workflow_artifacts
      (run_id,step_id,artifact_kind,record_id,version_key,qa_evidence)
    values(r.id,s.id,'magnet_version',v.id,v.content_sha256,
      jsonb_build_object('result','pass','job_id',j.id,
        'checks',jsonb_build_array('plan_bound_draft','exact_job',
          'immutable_version','stored_bytes_sha256'),
        'output_hash',v.content_sha256,'source_fingerprint',
          (select fingerprint from public.delivery_source_catalog_v6
           where client_id=r.client_id and entity_kind='magnet_version'
             and source_key=v.id::text)))
    on conflict(step_id,artifact_kind,record_id,version_key) do nothing;
    update public.workflow_steps set status='completed',blocker=null,
      completed_at=now(),updated_at=now() where id=s.id;
    if not exists(select 1 from public.workflow_steps
      where run_id=r.id and status<>'completed') then
      update public.workflow_runs set status='awaiting_human_approval',
        blocker=null,updated_at=now() where id=r.id;
    end if;
    v_accepted:=v_accepted+1;
  end loop;
  return query select v_accepted,v_blocked;
end $$;
revoke all on function public.accept_ready_campaign_magnet_steps_v7(integer)
  from public,anon,authenticated;
grant execute on function public.accept_ready_campaign_magnet_steps_v7(integer)
  to service_role;
select public.lock_down_definer_functions();
