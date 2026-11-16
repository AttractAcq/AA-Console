-- Readiness and immutable snapshots include the required magnet work.
create or replace function public.campaign_package_readiness_v7(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  c public.client_campaigns%rowtype;
  r public.workflow_runs%rowtype;
  p jsonb;
  v_position integer := 0;
  v_expected integer := 0;
  v_ready integer := 0;
  v_blockers jsonb := '[]'::jsonb;
  v_work public.delivery_work_effective_v6%rowtype;
  v_route public.campaign_route_packages_v6%rowtype;
  v_draft public.campaign_conversion_drafts_v7%rowtype;
  v_magnet_draft public.campaign_magnet_drafts_v7%rowtype;
  v_label text;
  v_id uuid;
begin
  select * into c from public.client_campaigns where id=p_campaign_id;
  if c.id is null then raise exception 'Campaign unavailable.' using errcode='P0001'; end if;
  if auth.role() not in ('authenticated','service_role')
     or (auth.role()='authenticated' and not public.can_access_client(c.client_id)) then
    raise exception 'Campaign access required.' using errcode='42501';
  end if;
  if c.acquisition_mode='legacy' then
    return jsonb_build_object('status','unsupported','blockers',
      jsonb_build_array('Legacy campaigns have no reviewed route package.'));
  end if;
  if c.plan_approved_fingerprint is distinct from public.campaign_plan_fingerprint(c)
     or c.plan_approved_at is null then
    v_blockers:=v_blockers || jsonb_build_array('The current campaign plan needs approval.');
  end if;
  select * into r from public.workflow_runs
    where campaign_id=c.id and client_id=c.client_id and kind='campaign_sweep'
      and workflow_version like 'v7.%'
    order by created_at desc,id desc limit 1;
  if r.id is null then
    v_blockers:=v_blockers || jsonb_build_array('No route-aware campaign sweep has been prepared.');
  elsif r.input_snapshot->>'plan_fingerprint' is distinct from public.campaign_plan_fingerprint(c)
      or r.input_snapshot->>'content_spec_hash' is distinct from c.content_spec_hash then
    v_blockers:=v_blockers || jsonb_build_array('The latest sweep belongs to an older plan.');
  elsif r.sealed_at is null then
    v_blockers:=v_blockers || jsonb_build_array('The latest sweep has not been sealed.');
  end if;
  if c.content_spec_id is null then
    v_blockers:=v_blockers || jsonb_build_array('The plan has no exact content specification.');
  else
    for p in select value from public.campaign_content_spec_versions_v7 s,
      jsonb_array_elements(s.pieces) where s.id=c.content_spec_id
        and s.client_id=c.client_id and s.campaign_id=c.id loop
      v_position:=v_position+1;
      v_expected:=v_expected+1;
      v_label:='Content piece ' || v_position;
      select * into v_route from public.campaign_route_packages_v6
        where campaign_id=c.id and route=p->>'route'
        order by version desc limit 1;
      if v_route.id is null or v_route.plan_fingerprint<>public.campaign_plan_fingerprint(c) then
        v_blockers:=v_blockers || jsonb_build_array(v_label || ': current route package missing.');
        continue;
      end if;
      select w.* into v_work from public.campaign_sweep_work_bindings_v7 b
        join public.delivery_work_effective_v6 w on w.id=b.work_item_id
        where b.run_id=r.id and b.piece_key='piece' || v_position
          and w.route_package_id=v_route.id and w.item_key='content_piece' || v_position
          and w.input_snapshot->>'workflow_run_id'=r.id::text
          and w.expected_output->>'platform'=p->>'platform'
          and w.expected_output->>'media_type'=p->>'media_type'
          and w.expected_output->>'content_format'=p->>'content_format';
      if v_work.id is null then
        v_blockers:=v_blockers || jsonb_build_array(v_label || ': current sweep work missing.');
      elsif v_work.effective_state not in ('ready_for_review','approved')
          or v_work.qa_state<>'passed' or v_work.output_fingerprint is null
          or v_work.output_fingerprint is distinct from public.delivery_work_output_hash_v6(v_work.id) then
        v_blockers:=v_blockers || jsonb_build_array(v_label || ': ' ||
          coalesce(v_work.effective_blocker,nullif(v_work.effective_state,''),'internal QA pending') || '.');
      else v_ready:=v_ready+1;
      end if;
    end loop;
  end if;
  select * into v_draft from public.campaign_conversion_drafts_v7
    where run_id=r.id and campaign_id=c.id and client_id=c.client_id
      and plan_fingerprint=public.campaign_plan_fingerprint(c);
  for v_label,v_id in select 'Campaign page',v_draft.page_work_item_id where c.needs_landing_page
    union all select 'Sales agent',v_draft.sales_work_item_id where c.needs_sales_agent loop
    v_expected:=v_expected+1;
    select * into v_work from public.delivery_work_effective_v6
      where id=v_id and client_id=c.client_id and campaign_id=c.id
        and input_snapshot->>'workflow_run_id'=r.id::text;
    if v_work.id is null then
      v_blockers:=v_blockers || jsonb_build_array(v_label || ': current sweep work missing.');
    elsif v_work.effective_state not in ('ready_for_review','approved')
        or v_work.qa_state<>'passed' or v_work.output_fingerprint is null
        or v_work.output_fingerprint is distinct from public.delivery_work_output_hash_v6(v_work.id) then
      v_blockers:=v_blockers || jsonb_build_array(v_label || ': ' ||
        coalesce(v_work.effective_blocker,nullif(v_work.effective_state,''),'internal QA pending') || '.');
    else v_ready:=v_ready+1;
    end if;
  end loop;
  if c.needs_lead_magnet then
    v_expected:=v_expected+1;
    select * into v_magnet_draft from public.campaign_magnet_drafts_v7
      where run_id=r.id and client_id=c.client_id and campaign_id=c.id
        and plan_fingerprint=public.campaign_plan_fingerprint(c);
    select * into v_work from public.delivery_work_effective_v6
      where id=v_magnet_draft.work_item_id and client_id=c.client_id
        and campaign_id=c.id and owner_module='lead_magnet_studio'
        and input_snapshot->>'workflow_run_id'=r.id::text;
    if v_work.id is null then
      v_blockers:=v_blockers || jsonb_build_array('Lead magnet: plan-bound work missing.');
    elsif v_work.effective_state not in ('ready_for_review','approved')
        or v_work.qa_state<>'passed' or v_work.output_fingerprint is null
        or v_work.output_fingerprint is distinct from public.delivery_work_output_hash_v6(v_work.id) then
      v_blockers:=v_blockers || jsonb_build_array('Lead magnet: ' ||
        coalesce(v_work.effective_blocker,
          case when v_work.effective_state='draft' then 'awaiting production'
            else nullif(v_work.effective_state,'') end,
          'internal QA pending') || '.');
    else v_ready:=v_ready+1;
    end if;
  end if;
  return jsonb_build_object('status',case when jsonb_array_length(v_blockers)=0
      and v_expected>0 then 'ready_for_review' else 'preparing' end,
    'run_id',r.id,'expected',v_expected,'ready',v_ready,'blockers',v_blockers);
end $$;

create or replace function public.campaign_preparation_snapshot_v7(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  c public.client_campaigns%rowtype;
  v_readiness jsonb;
  v_run uuid;
  v_routes jsonb;
  v_outputs jsonb;
begin
  select * into c from public.client_campaigns where id=p_campaign_id;
  if c.id is null then raise exception 'Campaign unavailable.' using errcode='P0001'; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(c.client_id)) then
    raise exception 'Campaign access required.' using errcode='42501';
  end if;
  v_readiness:=public.campaign_package_readiness_v7(c.id);
  if v_readiness->>'status'<>'ready_for_review' then return null; end if;
  v_run:=(v_readiness->>'run_id')::uuid;
  select jsonb_agg(jsonb_build_object('id',r.id,'route',r.route,
    'version',r.version,'paid_platform',r.paid_platform,
    'plan_fingerprint',r.plan_fingerprint) order by r.route)
    into v_routes
  from public.campaign_route_packages_v6 r
  where r.campaign_id=c.id and r.id in (
    select w.route_package_id from public.delivery_work_items_v6 w
    where w.campaign_id=c.id and w.input_snapshot->>'workflow_run_id'=v_run::text
      and w.route_package_id is not null);
  select jsonb_agg(jsonb_build_object(
    'work_item_id',w.id,'item_key',w.item_key,'route_key',w.route_key,
    'route_package_id',w.route_package_id,'work_version',w.work_version,
    'owner_module',w.owner_module,'input_fingerprint',w.input_fingerprint,
    'expected_output',w.expected_output,'output_fingerprint',w.output_fingerprint,
    'output_refs',w.output_refs) order by
      case when w.owner_module='content_production_factory' then 0
        when w.owner_module='website_studio' then 1 else 2 end,
      w.item_key)
    into v_outputs
  from public.delivery_work_items_v6 w
  where w.campaign_id=c.id and w.client_id=c.client_id and w.required
    and w.input_snapshot->>'workflow_run_id'=v_run::text
    and w.owner_module in ('content_production_factory','website_studio',
      'sales_os','lead_magnet_studio');
  if jsonb_array_length(coalesce(v_outputs,'[]'::jsonb))
      <> (v_readiness->>'expected')::integer then
    return null;
  end if;
  return jsonb_build_object('client_id',c.client_id,'campaign_id',c.id,
    'run_id',v_run,'plan_fingerprint',public.campaign_plan_fingerprint(c),
    'content_spec_id',c.content_spec_id,'content_spec_hash',c.content_spec_hash,
    'offer_version_id',c.offer_version_id,'routes',coalesce(v_routes,'[]'::jsonb),
    'outputs',v_outputs);
end $$;
select public.lock_down_definer_functions();
