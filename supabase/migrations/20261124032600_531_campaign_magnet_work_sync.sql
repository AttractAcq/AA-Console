-- The accepted magnet version is linked to the same delivery lineage and
-- readiness contract as campaign content, pages and agents.
create function public.sync_campaign_magnet_work_v7(p_limit integer default 100)
returns integer language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare d public.campaign_magnet_drafts_v7%rowtype;
  w public.delivery_work_items_v6%rowtype;
  s public.workflow_steps%rowtype;
  a public.workflow_artifacts%rowtype;
  v_entity_id uuid;
  v_hash text;
  v_count integer:=0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted module worker is required.' using errcode='42501';
  end if;
  if p_limit not between 1 and 500 then raise exception 'Limit must be 1..500.'; end if;
  for d in select x.* from public.campaign_magnet_drafts_v7 x
    join public.delivery_work_items_v6 item on item.id=x.work_item_id
    join public.workflow_runs r on r.id=x.run_id
    where r.sealed_at is not null and item.state in ('draft','prepared','held')
    order by x.created_at,x.run_id limit p_limit
  loop
    select * into w from public.delivery_work_items_v6 where id=d.work_item_id for update;
    select * into s from public.workflow_steps
      where run_id=d.run_id and step_key='conversion_lead_magnet';
    if s.id is null then continue; end if;
    if s.status='completed' then
      select * into a from public.workflow_artifacts where step_id=s.id
        and artifact_kind='magnet_version' and qa_evidence->>'result'='pass'
        order by accepted_at desc limit 1;
      if a.id is null or not exists(select 1 from public.lead_magnet_versions v
        where v.id=a.record_id and v.magnet_id=d.magnet_id
          and v.client_id=d.client_id and v.content_sha256=a.version_key
          and v.created_by_job_id=s.job_id)
        or a.qa_evidence->>'source_fingerprint' is distinct from
          (select fingerprint from public.delivery_source_catalog_v6
            where client_id=d.client_id and entity_kind='magnet_version'
              and source_key=a.record_id::text) then
        if w.state='draft' then
          perform public.advance_delivery_work_item_v6(w.id,w.owner_module,'prepared');
        end if;
        if w.state<>'held' then
          perform public.advance_delivery_work_item_v6(w.id,w.owner_module,'held',
            '{"blocker":"Accepted magnet version failed current lineage checks."}'::jsonb);
          v_count:=v_count+1;
        end if;
        continue;
      end if;
      v_entity_id:=public.refresh_delivery_entity_v6('magnet_version',a.record_id::text,d.client_id);
      perform public.link_delivery_work_output_v6(w.id,w.owner_module,v_entity_id);
      v_hash:=public.delivery_work_output_hash_v6(w.id);
      if w.state in ('draft','held') then
        perform public.advance_delivery_work_item_v6(w.id,w.owner_module,'prepared',
          '{"blocker":null}'::jsonb);
      end if;
      perform public.advance_delivery_work_item_v6(w.id,w.owner_module,'ready_for_review',
        jsonb_build_object('qa_state','passed','blocker',null,'job_id',s.job_id,
          'output_fingerprint',v_hash,'output_refs',jsonb_build_array(
            jsonb_build_object('kind','magnet_version','record_id',a.record_id,
              'version',a.version_key,'qa',a.qa_evidence))));
      v_count:=v_count+1;
    elsif s.status in ('blocked','failed') then
      if w.state='draft' then
        perform public.advance_delivery_work_item_v6(w.id,w.owner_module,'prepared');
      end if;
      if w.state<>'held' then
        perform public.advance_delivery_work_item_v6(w.id,w.owner_module,'held',
          jsonb_build_object('blocker',coalesce(nullif(s.blocker,''),
            'Magnet producer failed.'),'job_id',s.job_id,
            'remediation','Retry the magnet step after correcting its cause.'));
        v_count:=v_count+1;
      end if;
    elsif w.state in ('draft','held') then
      perform public.advance_delivery_work_item_v6(w.id,w.owner_module,'prepared',
        '{"blocker":null}'::jsonb);
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end $$;
revoke all on function public.sync_campaign_magnet_work_v7(integer)
  from public,anon,authenticated;
grant execute on function public.sync_campaign_magnet_work_v7(integer) to service_role;
select public.lock_down_definer_functions();
