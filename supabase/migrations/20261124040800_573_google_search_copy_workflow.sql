-- Connect exact Google search copy to the campaign sweep's internal QA and work ledger.
-- No Google Ads external action is enabled.
begin;

insert into public.agents(agent_key,name,initials,domain,description,requires_upstream,requires_input)
values('google_search_copy','Google Search Copy','GS','production',
  'Creates bounded search ad copy for exact human review; never builds or activates an ad.',
  array[]::text[],true)
on conflict(agent_key) do nothing;

create or replace view public.delivery_source_catalog_v6 with (security_invoker = true) as
select 'opportunity'::text as entity_kind, o.id::text as source_key,
  o.client_id, null::uuid as campaign_id,
  encode(sha256(convert_to((to_jsonb(o) - array[
    'updated_at','status','status_note','archived_at'
  ])::text, 'UTF8')), 'hex') as fingerprint
from public.market_opportunities o
union all
select 'source_model', r.id::text, r.client_id, null::uuid,
  encode(sha256(convert_to((to_jsonb(r) - array[
    'updated_at','created_at','job_id'
  ])::text, 'UTF8')), 'hex')
from public.client_agent_records r
union all
select 'offer', o.id::text, o.client_id, null::uuid,
  encode(sha256(convert_to(jsonb_build_object(
    'service_name', o.service_name,
    'latest_version', v.id,
    'latest_hash', v.content_hash
  )::text, 'UTF8')), 'hex')
from public.service_offers o
left join lateral (
  select id, content_hash from public.service_offer_versions v
  where v.offer_id = o.id and v.client_id = o.client_id
  order by v.version desc limit 1
) v on true
union all
select 'offer_version', v.id::text, v.client_id, null::uuid,
  v.content_hash
from public.service_offer_versions v
union all
select 'campaign', c.id::text, c.client_id, c.id,
  encode(sha256(convert_to(public.campaign_plan_fingerprint(c) || ':' ||
    coalesce(c.offer_version_id::text,''), 'UTF8')), 'hex')
from public.client_campaigns c
union all
select 'route_package', p.id::text, p.client_id, p.campaign_id,
  encode(sha256(convert_to(p.plan_fingerprint || ':' || p.route || ':' ||
    coalesce(p.paid_platform,''), 'UTF8')), 'hex')
from public.campaign_route_packages_v6 p
union all
select 'content_asset', a.id::text, a.client_id, null::uuid,
  encode(sha256(convert_to((to_jsonb(a) - array[
    'updated_at','created_at','review_status','archived_at','job_id'
  ])::text, 'UTF8')), 'hex')
from public.client_media_assets a
union all
select 'proof_source', p.id::text, p.client_id, null::uuid,
  encode(sha256(convert_to(jsonb_build_object(
    'source', to_jsonb(p) - array['created_at','updated_at'],
    'usage_rights', p.usage_rights,
    'expires_on', p.expires_on,
    'permission_basis', p.permission_basis
  )::text, 'UTF8')), 'hex')
from public.client_proof_assets p
union all
select 'proof_artifact', v.id::text, v.client_id, null::uuid,
  v.content_hash
from public.proof_artifact_versions v
union all
select 'destination', d.client_id::text || ':' || d.destination_key,
  d.client_id, null::uuid,
  encode(sha256(convert_to(jsonb_build_object(
    'key', d.destination_key, 'enabled', d.enabled,
    'account_ref', d.account_ref
  )::text, 'UTF8')), 'hex')
from public.client_proof_destinations d
union all
select 'page', p.id::text, p.client_id, null::uuid,
  encode(sha256(convert_to((to_jsonb(p) - array[
    'updated_at','created_at','status','published_url','job_id','archived_at'
  ])::text, 'UTF8')), 'hex')
from public.client_pages p
union all
select 'magnet_version', v.id::text, v.client_id, m.campaign_id,
  v.content_sha256
from public.lead_magnet_versions v
join public.lead_magnets m on m.id = v.magnet_id and m.client_id = v.client_id
union all
select 'sales_agent', a.id::text, a.client_id, null::uuid,
  encode(sha256(convert_to((to_jsonb(a) - array[
    'updated_at','created_at','status','archived_at','job_id'
  ])::text, 'UTF8')), 'hex')
from public.client_sales_agents a
union all
select 'approval', r.id::text, r.client_id, null::uuid,
  r.payload_hash
from public.approval_requests_v6 r where r.client_id is not null
union all
select 'distribution_attempt', x.id::text, x.client_id, x.campaign_id,
  encode(sha256(convert_to(jsonb_build_object(
    'approval_id', x.approval_id, 'version', x.artifact_version_hash,
    'action', x.action_key, 'manifest_id', x.manifest_id
  )::text, 'UTF8')), 'hex')
from public.campaign_action_executions x
union all
select 'lead', l.id::text, l.client_id, l.source_client_campaign_id,
  encode(sha256(convert_to(jsonb_build_object(
    'id', l.id, 'source_client_campaign_id', l.source_client_campaign_id,
    'source_post_id', l.source_post_id, 'source_click_id', l.source_click_id,
    'source_utm', l.source_utm, 'consent_given_at', l.consent_given_at
  )::text, 'UTF8')), 'hex')
from public.client_leads l
union all
select 'outcome', e.id::text, e.client_id, l.source_client_campaign_id,
  encode(sha256(convert_to(jsonb_build_object(
    'lead_id', e.lead_id, 'kind', e.kind, 'body', e.body,
    'occurred_at', e.occurred_at
  )::text, 'UTF8')), 'hex')
from public.lead_events e
join public.client_leads l on l.id = e.lead_id and l.client_id = e.client_id
where e.kind = 'outcome'
union all
select 'google_search_copy'::text, g.id::text, g.client_id, g.campaign_id, g.copy_hash
from public.campaign_google_search_copy_versions_v7 g;

alter table public.delivery_entity_versions_v6
  drop constraint delivery_entity_versions_v6_entity_kind_check;
alter table public.delivery_entity_versions_v6
  add constraint delivery_entity_versions_v6_entity_kind_check
  check (entity_kind in (
    'opportunity','source_model','offer','offer_version','campaign','route_package',
    'content_asset','google_search_copy','proof_source','proof_artifact','destination','page',
    'magnet_version','sales_agent','approval','distribution_attempt','lead','outcome'
  ));


-- Keep the social/media QA worker from blocking the dedicated search-copy step.
create or replace function public.accept_ready_campaign_workflow_steps_v7(p_limit integer default 20)
returns table (steps_accepted integer, steps_blocked integer)
language plpgsql security definer set search_path = public as $$
declare
  v_step workflow_steps;
  v_run workflow_runs;
  v_job agent_jobs;
  v_output jsonb;
  v_source jsonb;
  v_candidate jsonb;
  v_kind text;
  v_reason text;
  v_count integer;
  v_missing integer;
  v_record_id uuid;
  v_version text;
  v_evidence jsonb;
  v_accepted integer := 0;
  v_blocked integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if p_limit not between 1 and 50 then raise exception 'Limit must be 1..50'; end if;

  for v_step in
    select s.* from workflow_steps s
    join workflow_runs r on r.id = s.run_id
    where r.kind = 'campaign_sweep'
      and r.status = 'needs_internal_qa'
      and s.status = 'needs_internal_qa'
      and s.agent_key <> 'google_search_copy'
    order by r.deadline_at, s.created_at, s.id
    for update of s skip locked limit p_limit
  loop
    select * into v_run from workflow_runs where id = v_step.run_id;
    select * into v_job from agent_jobs where id = v_step.job_id;
    v_output := null;
    v_source := null;
    v_candidate := null;
    v_kind := null;
    v_reason := null;
    v_count := 0;
    v_missing := 0;
    if v_job.status is distinct from 'completed' then
      v_reason := 'The workflow job is not completed.';
    elsif v_step.agent_key = 'ideation' then
      select count(*), (array_agg(to_jsonb(i) order by i.created_at))[1]
        into v_count, v_output from client_ideas i where i.job_id = v_job.id;
      v_kind := 'idea';
      if v_count <> 1 then v_reason := 'Daily ideation must produce exactly one idea.';
      elsif nullif(btrim(v_output->>'title'), '') is null
         or length(btrim(coalesce(v_output->>'body', ''))) < 20
         or nullif(btrim(v_output->>'source_question'), '') is null
         or v_output->>'client_id' is distinct from v_run.client_id::text
         or v_output->>'campaign_id' is distinct from v_run.campaign_id::text
         or (v_step.input_params ? 'pillar_id'
           and v_output->>'pillar_id' is distinct from v_step.input_params->>'pillar_id')
         or v_output->>'target_platform' is distinct from v_step.input_params->>'target_platform'
         or v_output->>'content_format' is distinct from v_step.input_params->>'content_format'
         or v_output->>'media_type' is distinct from v_step.input_params->>'media_type'
      then v_reason := 'Generated idea failed client, campaign, pillar, format or source checks.';
      end if;
    elsif v_step.agent_key = 'brief' then
      select count(*), (array_agg(to_jsonb(b) order by b.created_at))[1]
        into v_count, v_output from client_briefs b where b.job_id = v_job.id;
      select to_jsonb(i) into v_source from client_ideas i
        where i.id = v_step.resolved_input_id;
      v_kind := 'brief';
      if v_count <> 1 then v_reason := 'Daily briefing must produce exactly one brief.';
      elsif v_source is null or v_output->>'client_id' is distinct from v_run.client_id::text
         or v_output->>'source_idea_id' is distinct from v_step.resolved_input_id::text
         or length(btrim(coalesce(v_output->>'body', ''))) < 80
         or v_output->>'content_format' is distinct from v_source->>'content_format'
         or v_output->>'media_type' is distinct from v_source->>'media_type'
         or v_output->>'target_platform' is distinct from v_source->>'target_platform'
      then v_reason := 'Generated brief failed idea lineage, format or substance checks.';
      end if;
    elsif v_step.agent_key = 'creative_build' then
      select count(*), (array_agg(to_jsonb(a) order by a.created_at))[1]
        into v_count, v_output from client_media_assets a
        where a.brief_id = v_step.resolved_input_id
          and a.client_id = v_run.client_id and a.created_at >= v_job.created_at;
      select to_jsonb(b) into v_source from client_briefs b
        where b.id = v_step.resolved_input_id;
      v_kind := 'asset';
      if v_count <> 1 then v_reason := 'Creative build must produce exactly one asset.';
      elsif v_source is null or nullif(btrim(v_output->>'storage_path'), '') is null
         or v_output->>'content_format' is distinct from v_source->>'content_format'
         or v_output->>'media_type' is distinct from v_source->>'media_type'
      then v_reason := 'Created asset failed brief, format or storage checks.';
      end if;
    elsif v_step.agent_key = 'video_build' then
      select to_jsonb(a) into v_output from client_media_assets a
      join workflow_artifacts prior on prior.record_id = a.id and prior.artifact_kind = 'asset'
      join workflow_steps prior_step on prior_step.id = prior.step_id
      where prior.run_id = v_run.id and prior_step.step_key = any(v_step.dependencies)
        and a.brief_id = v_step.resolved_input_id and a.client_id = v_run.client_id
      order by prior.accepted_at desc limit 1;
      v_kind := 'asset';
      if v_output is not null then
        select count(*), count(*) filter (where nullif(btrim(clip_path), '') is null)
          into v_count, v_missing from client_media_frames
          where asset_id = (v_output->>'id')::uuid;
      end if;
      if v_output is null then
        v_reason := 'Video build has no accepted opening asset.';
      elsif v_count < 2 or v_missing > 0 then
        -- video_build completes after scheduling a paid Higgsfield collection.
        -- A queued/running follow-up is not a finished motion step; leave QA
        -- pending until it persists every clip or fails with no continuation.
        if exists (select 1 from agent_jobs follow_up
          where follow_up.id <> v_job.id and follow_up.agent_key = 'video_build'
            and follow_up.input_table = 'client_briefs'
            and follow_up.input_id = v_step.resolved_input_id
            and follow_up.params->>'v5_workflow_run_id' = v_run.id::text
            and follow_up.params->>'v5_step_key' = v_step.step_key
            and follow_up.status in ('queued', 'claimed', 'running')) then
          continue;
        end if;
        v_reason := 'Video build has no complete clips and no active collection job.';
      end if;
    elsif v_step.agent_key = 'video_edit' then
      select to_jsonb(a) into v_output from client_media_assets a
        where a.id = v_step.resolved_input_id and a.client_id = v_run.client_id;
      select to_jsonb(c) into v_candidate from video_render_candidates c
        where c.job_id = v_job.id and c.asset_id = v_step.resolved_input_id
          and c.verdict = 'accepted'
        order by c.attempt desc limit 1;
      v_kind := 'asset';
      if v_output is null or v_candidate is null
         or v_output->>'render_path' is distinct from v_candidate->>'render_path'
         or v_candidate->'media_probe'->>'result' is distinct from 'pass'
         or v_candidate->'creative_review'->>'result' is distinct from 'pass'
      then v_reason := 'Final reel has no matching accepted media and creative review.';
      end if;
    else
      v_reason := 'No internal QA policy exists for this daily step.';
    end if;

    if v_reason is not null then
      update workflow_steps set status = 'blocked', blocker = v_reason,
        updated_at = now() where id = v_step.id;
      update workflow_runs set status = 'blocked', blocker = v_reason,
        updated_at = now() where id = v_run.id;
      v_blocked := v_blocked + 1;
      continue;
    end if;
    if v_kind='asset' and nullif(v_output->>'delivery_bytes_sha256','') is null then
      update workflow_steps set blocker='Waiting for exact stored-file SHA-256 attestation.',
        updated_at=now() where id=v_step.id;
      continue;
    end if;
    v_record_id := (v_output->>'id')::uuid;
    v_version := case when v_step.agent_key = 'video_edit'
      then md5(v_candidate->>'render_path') else md5(v_output::text) end;
    v_evidence := jsonb_build_object(
      'result', 'pass', 'checks', case v_step.agent_key
        when 'ideation' then jsonb_build_array('one_output', 'client_campaign_pillar', 'destination_format', 'source_question')
        when 'brief' then jsonb_build_array('one_output', 'accepted_idea_lineage', 'destination_format', 'body_substance')
        when 'creative_build' then jsonb_build_array('one_output', 'brief_lineage', 'destination_format', 'stored_asset')
        when 'video_build' then jsonb_build_array('accepted_opening_asset', 'all_shots_rendered')
        else jsonb_build_array('exact_render_path', 'media_probe_pass', 'creative_review_pass') end,
      'job_id', v_job.id, 'output_hash', md5(v_output::text),
      'candidate_id', v_candidate->>'id',
      'candidate_render_path', v_candidate->>'render_path',
      'media_probe', v_candidate->'media_probe',
      'creative_review', v_candidate->'creative_review',
      'source_fingerprint', case when v_kind='asset' then
        (select fingerprint from public.delivery_source_catalog_v6
          where entity_kind='content_asset' and source_key=v_record_id::text
            and client_id=v_run.client_id) else null end);
    perform accept_workflow_step(v_step.id, v_kind, v_record_id, v_version, v_evidence);
    v_accepted := v_accepted + 1;
  end loop;
  return query select v_accepted, v_blocked;
end;
$$;

create function public.accept_ready_google_search_copy_steps_v7(p_limit integer default 20)
returns table(steps_accepted integer,steps_blocked integer)
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare s public.workflow_steps%rowtype;
  r public.workflow_runs%rowtype;
  j public.agent_jobs%rowtype;
  b public.campaign_sweep_work_bindings_v7%rowtype;
  w public.delivery_work_items_v6%rowtype;
  v public.campaign_google_search_copy_versions_v7%rowtype;
  c public.client_campaigns%rowtype;
  i public.client_ideas%rowtype;
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
      and x.status='needs_internal_qa' and x.agent_key='google_search_copy'
    order by r0.deadline_at,x.created_at for update of x skip locked limit p_limit
  loop
    select * into r from public.workflow_runs where id=s.run_id for update;
    select * into j from public.agent_jobs where id=s.job_id;
    select * into b from public.campaign_sweep_work_bindings_v7
      where run_id=r.id and final_step_key=s.step_key;
    select * into w from public.delivery_work_items_v6 where id=b.work_item_id;
    select * into v from public.campaign_google_search_copy_versions_v7
      where producer_job_id=j.id and work_item_id=w.id;
    select * into c from public.client_campaigns where id=r.campaign_id;
    select * into i from public.client_ideas where id=v.source_idea_id;
    v_reason:=null;
    if j.status is distinct from 'completed' then
      v_reason:='The Google copy producer job is not complete.';
    elsif b.work_item_id is null or w.client_id<>r.client_id
        or w.route_key<>'paid' or w.expected_output->>'platform'<>'google_ads'
        or w.expected_output->>'artifact_kind'<>'google_search_copy'
        or w.input_snapshot->>'workflow_run_id' is distinct from r.id::text
        or s.input_table<>'client_ideas' or s.resolved_input_id is null then
      v_reason:='The Google copy step has no exact paid-route work binding.';
    elsif c.id is null or c.client_id<>r.client_id
        or c.plan_approved_fingerprint is distinct from public.campaign_plan_fingerprint(c)
        or r.input_snapshot->>'plan_fingerprint' is distinct from c.plan_approved_fingerprint
        or public.campaign_sweep_blocker_v6(c.id) is not null then
      v_reason:='The approved campaign plan changed before Google copy QA.';
    elsif v.id is null or v.client_id<>r.client_id or v.campaign_id<>c.id
        or v.route_package_id<>w.route_package_id
        or v.content_spec_id<>c.content_spec_id
        or v.source_idea_id<>s.resolved_input_id
        or w.input_snapshot->>'planned_idea_id' is distinct from v.source_idea_id::text
        or v.piece_index is distinct from (s.input_params->>'piece_index')::integer
        or i.id is null or i.client_id<>r.client_id or i.campaign_id<>c.id
        or i.title is distinct from v.source_snapshot->>'idea_title'
        or i.body is distinct from v.source_snapshot->>'idea_body'
        or v.copy_hash is distinct from encode(sha256(convert_to(
          jsonb_build_object('source',v.source_snapshot,'headlines',v.headlines,
            'descriptions',v.descriptions,'rationale',v.rationale)::text,'UTF8')),'hex') then
      v_reason:='The Google copy version failed exact source, route or byte checks.';
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
    values(r.id,s.id,'google_search_copy',v.id,v.copy_hash,
      jsonb_build_object('result','pass','job_id',j.id,
        'checks',jsonb_build_array('exact_paid_route','planned_idea',
          'current_plan','bounded_copy','immutable_hash'),
        'output_hash',v.copy_hash,'source_fingerprint',v.copy_hash))
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
revoke all on function public.accept_ready_google_search_copy_steps_v7(integer)
  from public,anon,authenticated;
grant execute on function public.accept_ready_google_search_copy_steps_v7(integer)
  to service_role;

create function public.sync_google_search_copy_work_v7(p_limit integer default 100)
returns integer language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare b record;
  v_entity_id uuid;
  v_fingerprint text;
  v_count integer:=0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted work reconciler is required.' using errcode='42501';
  end if;
  for b in select w.id as work_item_id,w.client_id,w.state,a.record_id,
      a.version_key,a.qa_evidence,s.job_id
    from public.campaign_sweep_work_bindings_v7 binding
    join public.delivery_work_items_v6 w on w.id=binding.work_item_id
    join public.workflow_steps s on s.run_id=binding.run_id
      and s.step_key=binding.final_step_key
    join public.workflow_artifacts a on a.step_id=s.id
      and a.artifact_kind='google_search_copy'
    where w.expected_output->>'artifact_kind'='google_search_copy'
      and s.status='completed' and w.state in ('draft','prepared','held')
    order by binding.created_at limit greatest(1,least(coalesce(p_limit,100),500))
  loop
    if b.qa_evidence->>'source_fingerprint' is distinct from
      (select fingerprint from public.delivery_source_catalog_v6
        where client_id=b.client_id and entity_kind='google_search_copy'
          and source_key=b.record_id::text) then
      if b.state='draft' then
        perform public.advance_delivery_work_item_v6(
          b.work_item_id,'content_production_factory','prepared');
      end if;
      perform public.advance_delivery_work_item_v6(
        b.work_item_id,'content_production_factory','held',
        '{"blocker":"Google search copy changed after internal QA."}'::jsonb);
      v_count:=v_count+1;
      continue;
    end if;
    v_entity_id:=public.refresh_delivery_entity_v6(
      'google_search_copy',b.record_id::text,b.client_id);
    perform public.link_delivery_work_output_v6(
      b.work_item_id,'content_production_factory',v_entity_id);
    v_fingerprint:=public.delivery_work_output_hash_v6(b.work_item_id);
    if b.state in ('draft','held') then
      perform public.advance_delivery_work_item_v6(
        b.work_item_id,'content_production_factory','prepared',
        '{"blocker":null}'::jsonb);
    end if;
    perform public.advance_delivery_work_item_v6(
      b.work_item_id,'content_production_factory','ready_for_review',
      jsonb_build_object('qa_state','passed','blocker',null,
        'job_id',b.job_id,'output_fingerprint',v_fingerprint,
        'output_refs',jsonb_build_array(jsonb_build_object(
          'kind','google_search_copy','record_id',b.record_id,
          'version',b.version_key,'qa',b.qa_evidence))));
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;
revoke all on function public.sync_google_search_copy_work_v7(integer)
  from public,anon,authenticated;
grant execute on function public.sync_google_search_copy_work_v7(integer)
  to service_role;

select public.lock_down_definer_functions();
commit;
