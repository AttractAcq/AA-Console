-- Exact campaign page and sales-agent outputs pass internal QA before their
-- work items may reach human review. A blocked page holds its dependent agent.
create function public.accept_ready_campaign_conversion_steps_v7(p_limit integer default 20)
returns table(steps_accepted integer,steps_blocked integer)
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare
  s public.workflow_steps%rowtype;
  r public.workflow_runs%rowtype;
  j public.agent_jobs%rowtype;
  d public.campaign_conversion_drafts_v7%rowtype;
  v_output jsonb;
  v_kind text;
  v_version text;
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
      and x.status='needs_internal_qa'
      and x.step_key in ('conversion_page','conversion_sales_agent')
    order by r0.deadline_at,x.created_at for update of x skip locked limit p_limit
  loop
    select * into r from public.workflow_runs where id=s.run_id;
    select * into j from public.agent_jobs where id=s.job_id;
    select * into d from public.campaign_conversion_drafts_v7 where run_id=r.id;
    v_reason:=null;
    v_output:=null;
    if j.status is distinct from 'completed' then
      v_reason:='The conversion producer job is not complete.';
    elsif d.run_id is null or d.plan_fingerprint is distinct from
        (select public.campaign_plan_fingerprint(c) from public.client_campaigns c
         where c.id=r.campaign_id) then
      v_reason:='The reviewed campaign plan changed before conversion QA.';
    elsif s.step_key='conversion_page' then
      v_kind:='page';
      select to_jsonb(p) into v_output from public.client_pages p
        where p.id=d.page_id and p.id=s.resolved_input_id
          and p.client_id=r.client_id and p.job_id=j.id;
      if v_output is null or length(btrim(coalesce(v_output->>'html','')))<500
         or length(btrim(coalesce(v_output->>'body','')))<40
         or v_output->>'built_at' is null then
        v_reason:='Campaign page is missing the exact job output, HTML or readable copy.';
      end if;
    else
      v_kind:='sales_agent';
      select to_jsonb(a) into v_output from public.client_sales_agents a
        where a.id=d.sales_agent_id and a.id=s.resolved_input_id
          and a.client_id=r.client_id and a.job_id=j.id;
      if v_output is null or v_output->>'built_at' is null
         or length(btrim(coalesce(v_output->>'system_prompt','')))<400
         or nullif(btrim(v_output->>'greeting'),'') is null
         or nullif(btrim(v_output->>'guardrails'),'') is null
         or nullif(btrim(v_output->>'escalation_rule'),'') is null
         or jsonb_typeof(v_output->'qualification') is distinct from 'array'
         or jsonb_array_length(coalesce(v_output->'qualification','[]'::jsonb))<3
         or (d.page_id is not null
           and v_output->>'page_id' is distinct from d.page_id::text) then
        v_reason:='Sales agent is missing its exact job output, guardrails, qualification or page link.';
      end if;
    end if;
    if v_reason is not null then
      update public.workflow_steps set status='blocked',blocker=v_reason,
        updated_at=now() where id=s.id;
      update public.workflow_runs set status='blocked',blocker=v_reason,
        updated_at=now() where id=r.id;
      v_blocked:=v_blocked+1;
      continue;
    end if;
    v_version:=case when v_kind='page' then md5(jsonb_build_object(
      'html',v_output->'html','body',v_output->'body',
      'meta_title',v_output->'meta_title',
      'meta_description',v_output->'meta_description')::text)
      else md5(jsonb_build_object('system_prompt',v_output->'system_prompt',
        'greeting',v_output->'greeting','qualification',v_output->'qualification',
        'objections',v_output->'objections','booking_rule',v_output->'booking_rule',
        'escalation_rule',v_output->'escalation_rule',
        'guardrails',v_output->'guardrails')::text) end;
    perform public.accept_workflow_step(s.id,v_kind,(v_output->>'id')::uuid,
      v_version,jsonb_build_object('result','pass','job_id',j.id,
        'checks',case when v_kind='page' then jsonb_build_array(
          'plan_bound_draft','exact_job','html_and_copy','page_link')
          else jsonb_build_array('plan_bound_draft','exact_job',
            'qualification','guardrails','page_link') end,
        'output_hash',v_version,
        'source_fingerprint',(select fingerprint from public.delivery_source_catalog_v6
          where client_id=r.client_id and entity_kind=v_kind
            and source_key=v_output->>'id')));
    v_accepted:=v_accepted+1;
  end loop;
  return query select v_accepted,v_blocked;
end $$;

revoke all on function public.accept_ready_campaign_conversion_steps_v7(integer)
  from public,anon,authenticated;
grant execute on function public.accept_ready_campaign_conversion_steps_v7(integer)
  to service_role;

create function public.sync_campaign_conversion_work_v7(p_limit integer default 100)
returns integer language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  b record;
  s public.workflow_steps%rowtype;
  blocked public.workflow_steps%rowtype;
  a public.workflow_artifacts%rowtype;
  v_entity_id uuid;
  v_hash text;
  v_count integer:=0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted module worker is required.' using errcode='42501';
  end if;
  for b in select x.*,w.state,w.owner_module,w.client_id from public.campaign_conversion_work_bindings_v7 x
    join public.delivery_work_items_v6 w on w.id=x.work_item_id
    join public.workflow_runs r on r.id=x.run_id
    where r.sealed_at is not null and w.state in ('draft','prepared','held')
      and (w.state='draft'
        or (w.state='prepared' and exists(select 1 from public.workflow_artifacts a0
          join public.workflow_steps s0 on s0.id=a0.step_id
          where s0.run_id=x.run_id and s0.step_key=x.step_key
            and s0.status='completed'))
        or (w.state='held' and exists(select 1 from public.workflow_artifacts a0
          join public.workflow_steps s0 on s0.id=a0.step_id
          join public.delivery_source_catalog_v6 source
            on source.client_id=w.client_id and source.entity_kind=a0.artifact_kind
              and source.source_key=a0.record_id::text
          where s0.run_id=x.run_id and s0.step_key=x.step_key
            and s0.status='completed'
            and a0.artifact_kind=case when x.step_key='conversion_page'
              then 'page' else 'sales_agent' end
            and a0.qa_evidence->>'source_fingerprint'=source.fingerprint))
        or (w.state='prepared' and exists(select 1 from public.workflow_steps s0
          join public.workflow_steps target on target.run_id=s0.run_id
            and target.step_key=x.step_key
          where s0.run_id=x.run_id and s0.status in ('blocked','failed')
            and (s0.step_key=x.step_key or s0.step_key=any(target.dependencies))))
        or (w.state='held' and not exists(select 1 from public.workflow_steps s0
          join public.workflow_steps target on target.run_id=s0.run_id
            and target.step_key=x.step_key
          where s0.run_id=x.run_id and s0.status in ('blocked','failed')
            and (s0.step_key=x.step_key or s0.step_key=any(target.dependencies)))
          and not exists(select 1 from public.workflow_artifacts a0
            join public.workflow_steps s0 on s0.id=a0.step_id
            where s0.run_id=x.run_id and s0.step_key=x.step_key)))
    order by x.created_at limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    select * into s from public.workflow_steps
      where run_id=b.run_id and step_key=b.step_key;
    if s.status='completed' then
      select * into a from public.workflow_artifacts where step_id=s.id;
      if a.id is null then continue; end if;
      if a.artifact_kind is distinct from
        (case when b.step_key='conversion_page' then 'page' else 'sales_agent' end) then
        if b.state='draft' then
          perform public.advance_delivery_work_item_v6(b.work_item_id,b.owner_module,'prepared');
        end if;
        if b.state<>'held' then
          perform public.advance_delivery_work_item_v6(b.work_item_id,b.owner_module,
            'held','{"blocker":"Conversion step accepted the wrong artifact kind."}'::jsonb);
          v_count:=v_count+1;
        end if;
        continue;
      end if;
      if a.qa_evidence->>'source_fingerprint' is distinct from
        (select fingerprint from public.delivery_source_catalog_v6
          where client_id=b.client_id and entity_kind=a.artifact_kind
            and source_key=a.record_id::text) then
        if b.state='draft' then
          perform public.advance_delivery_work_item_v6(b.work_item_id,b.owner_module,'prepared');
        end if;
        if b.state<>'held' then
          perform public.advance_delivery_work_item_v6(b.work_item_id,b.owner_module,
            'held','{"blocker":"Accepted conversion draft changed after internal QA; review or regenerate it."}'::jsonb);
          v_count:=v_count+1;
        end if;
        continue;
      end if;
      v_entity_id:=public.refresh_delivery_entity_v6(
        a.artifact_kind,a.record_id::text,b.client_id);
      perform public.link_delivery_work_output_v6(
        b.work_item_id,b.owner_module,v_entity_id);
      v_hash:=public.delivery_work_output_hash_v6(b.work_item_id);
      if b.state in ('draft','held') then
        perform public.advance_delivery_work_item_v6(b.work_item_id,b.owner_module,
          'prepared','{"blocker":null}'::jsonb);
      end if;
      perform public.advance_delivery_work_item_v6(b.work_item_id,b.owner_module,
        'ready_for_review',jsonb_build_object('qa_state','passed','blocker',null,
          'job_id',s.job_id,'output_fingerprint',v_hash,
          'output_refs',jsonb_build_array(jsonb_build_object(
            'kind',a.artifact_kind,'record_id',a.record_id,
            'version',a.version_key,'qa',a.qa_evidence))));
      v_count:=v_count+1;
    else
      select s0.* into blocked from public.workflow_steps s0
        where s0.run_id=b.run_id and s0.status in ('blocked','failed')
          and (s0.step_key=b.step_key or s0.step_key=any(s.dependencies))
        order by s0.created_at limit 1;
      if blocked.id is not null and b.state<>'held' then
        if b.state='draft' then
          perform public.advance_delivery_work_item_v6(b.work_item_id,b.owner_module,'prepared');
        end if;
        perform public.advance_delivery_work_item_v6(b.work_item_id,b.owner_module,
          'held',jsonb_build_object('blocker',coalesce(nullif(blocked.blocker,''),
            'Conversion dependency is blocked.'),'job_id',blocked.job_id,
            'remediation','Retry the blocked producer after correcting its cause.'));
        v_count:=v_count+1;
      elsif blocked.id is null and b.state in ('draft','held') then
        perform public.advance_delivery_work_item_v6(b.work_item_id,b.owner_module,
          'prepared','{"blocker":null}'::jsonb);
        v_count:=v_count+1;
      end if;
    end if;
  end loop;
  return v_count;
end $$;

revoke all on function public.sync_campaign_conversion_work_v7(integer)
  from public,anon,authenticated;
grant execute on function public.sync_campaign_conversion_work_v7(integer)
  to service_role;
select public.lock_down_definer_functions();
