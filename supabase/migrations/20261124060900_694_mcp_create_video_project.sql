-- A Production bot can start one sourced code-video project. Creation,
-- source snapshot and job enqueue are atomic. A paused worker leaves no row.
alter table public.video_projects add column origin_bot_id text
  check (origin_bot_id is null or origin_bot_id='bot_production');

create function public.guard_video_project_bot_origin_v1()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if new.origin_bot_id is distinct from old.origin_bot_id then
    raise exception 'Video project bot origin is immutable.' using errcode='23514';
  end if;
  return new;
end $$;
create trigger video_project_bot_origin_guard_v1
  before update on public.video_projects for each row
  execute function public.guard_video_project_bot_origin_v1();
revoke all on function public.guard_video_project_bot_origin_v1()
  from public,anon,authenticated,service_role;

insert into mcp_internal.mcp_bot_permissions
  (bot_id,permission_pattern,granted_by)
select 'bot_production','content.create_video_project',
  'video-v7:source-bound-create'
where not exists(select 1 from mcp_internal.mcp_bot_permissions
  where bot_id='bot_production'
    and permission_pattern='content.create_video_project');

create function public.mcp_create_video_project_v1(
  p_bot_id text,p_request_id text,p_execution_id text,
  p_client_id uuid,p_idea text,p_audience text,p_tone text,
  p_target_length_sec integer,p_aspects text[],p_record_ids uuid[],
  p_brief_id uuid,p_campaign_id uuid,p_route_package_id uuid,
  p_request_key text
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  p public.video_projects%rowtype;
  b public.client_briefs%rowtype;
  c public.client_campaigns%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  r public.client_agent_records%rowtype;
  s record;
  v_agent public.agents%rowtype;
  v_idea text:=nullif(btrim(p_idea),'');
  v_audience text:=nullif(btrim(p_audience),'');
  v_key text;
  v_ids uuid[];
  v_hash text;
  v_sources jsonb:='[]'::jsonb;
  v_count integer:=0;
  v_chars integer:=0;
  v_digest text;
  v_job uuid;
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
  if p_bot_id<>'bot_production'
    or not mcp_internal.bot_has_permission(
      p_bot_id,'content.create_video_project') then
    raise exception using message='bot_forbidden',errcode='P0001'; end if;
  if p_client_id is null or v_idea is null
    or p_request_id is null or p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_execution_id is null or p_execution_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or length(v_idea) not between 15 and 4000
    or v_audience is null or length(v_audience)>200
    or p_tone is null or p_tone not in ('calm','confident','energetic')
    or p_target_length_sec is null
    or p_target_length_sec not between 30 and 900
    or p_aspects is null or not public.video_aspects_valid_v1(p_aspects)
    or p_record_ids is null or cardinality(p_record_ids) not between 1 and 12
    or exists(select 1 from unnest(p_record_ids) as item(id) where id is null)
    or cardinality(p_record_ids)<>(select count(distinct id)
      from unnest(p_record_ids) as item(id))
    or p_request_key is null
    or p_request_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$'
    or (p_campaign_id is null)<>(p_route_package_id is null)
    or (p_campaign_id is not null and p_brief_id is null) then
    raise exception using message='invalid_request',errcode='P0001'; end if;
  v_key:='mcp:'||p_request_key;
  select array_agg(id order by id) into v_ids
    from unnest(p_record_ids) as item(id);
  v_hash:=encode(sha256(convert_to(jsonb_build_object(
    'idea',v_idea,'audience',v_audience,'tone',p_tone,
    'target_length_sec',p_target_length_sec,'aspects',to_jsonb(p_aspects),
    'record_ids',to_jsonb(v_ids),'brief_id',p_brief_id,
    'campaign_id',p_campaign_id,'route_package_id',p_route_package_id
  )::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    p_client_id::text||':video_project:'||v_key,0));
  select * into p from public.video_projects
    where client_id=p_client_id and request_key=v_key;
  if found then
    if p.origin_bot_id is distinct from p_bot_id
      or p.request_hash is distinct from v_hash or p.job_id is null then
      raise exception using message='idempotency_conflict',errcode='P0001'; end if;
    return jsonb_build_object('client_id',p.client_id,'project_id',p.id,
      'job_id',p.job_id,'stage',p.stage);
  end if;
  if p_brief_id is not null then
    select * into b from public.client_briefs where id=p_brief_id
      and client_id=p_client_id for share;
    if b.id is null or b.media_type<>'video'
      or b.status not in ('approved','in_production','complete') then
      raise exception using message='invalid_brief_status',errcode='P0001'; end if;
  end if;
  if p_route_package_id is not null then
    select * into c from public.client_campaigns
      where id=p_campaign_id and client_id=p_client_id for share;
    select * into route from public.campaign_route_packages_v6
      where id=p_route_package_id and campaign_id=p_campaign_id
        and client_id=p_client_id;
    if c.id is null or c.status in ('cancelled','complete')
      or route.id is null
      or route.plan_fingerprint is distinct from
        public.campaign_plan_fingerprint(c)
      or route.version<>(select max(version)
        from public.campaign_route_packages_v6 rp
        where rp.campaign_id=route.campaign_id and rp.route=route.route) then
      raise exception using message='video_route_stale',errcode='P0001'; end if;
  end if;
  for r in select * from public.client_agent_records
    where id=any(v_ids) order by id for share loop
    select * into s from public.model_section_review_state_v7
      where record_id=r.id;
    if not found or r.client_id<>p_client_id
      or s.review_state is distinct from 'supported'
      or nullif(btrim(coalesce(r.body,'')),'') is null
      or length(r.body)>4000 then
      raise exception using message='video_source_invalid',errcode='P0001'; end if;
    v_count:=v_count+1;
    v_chars:=v_chars+length(r.body);
    v_sources:=v_sources||jsonb_build_array(jsonb_build_object(
      'id',r.id::text,
      'kind',case
        when r.domain::text in ('market','icp','competitors') then 'market'
        when r.domain::text like '%offer%' then 'offer'
        when r.domain::text like '%proof%' then 'proof'
        when r.domain::text like '%campaign%' then 'campaign'
        else 'business' end,
      'asOf',s.observed_on,'text',r.body,
      'review_id',s.review_id,'record_hash',s.record_hash,
      'source_ref',s.source_ref));
  end loop;
  if v_count<>cardinality(v_ids) or v_chars>20000 then
    raise exception using message='video_source_invalid',errcode='P0001'; end if;
  select * into v_agent from public.agents
    where agent_key='video_script' for share;
  if v_agent.agent_key is null or v_agent.paused
    or v_agent.archived_at is not null
    or not public.can_run_agent('video_script',p_client_id) then
    raise exception using message='video_agent_unavailable',errcode='P0001'; end if;
  v_digest:=encode(sha256(convert_to(v_sources::text,'UTF8')),'hex');
  insert into public.video_projects(client_id,idea,audience,tone,
    target_length_sec,aspects,stage,brief_id,campaign_id,route_package_id,
    request_key,request_hash,origin_bot_id)
  values(p_client_id,v_idea,v_audience,p_tone,p_target_length_sec,
    p_aspects,'draft',p_brief_id,p_campaign_id,p_route_package_id,
    v_key,v_hash,p_bot_id) returning * into p;
  v_job:=public.enqueue_agent_job_internal('video_script',p_client_id,
    'video_projects',p.id,null,
    jsonb_build_object('source_digest',v_digest,'ir_version',p.ir_version,
      'origin_bot_id',p_bot_id,'mcp_request_id',p_request_id,
      'mcp_execution_id',p_execution_id),
    'Queued: write a sourced bot video storyboard');
  update public.video_projects set stage='queued',job_id=v_job,
    source_snapshot=v_sources,source_digest=v_digest
    where id=p.id;
  return jsonb_build_object('client_id',p_client_id,'project_id',p.id,
    'job_id',v_job,'stage','queued');
end $$;
revoke all on function public.mcp_create_video_project_v1(
  text,text,text,uuid,text,text,text,integer,text[],uuid[],uuid,uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.mcp_create_video_project_v1(
  text,text,text,uuid,text,text,text,integer,text[],uuid[],uuid,uuid,uuid,text)
  to service_role;
comment on function public.mcp_create_video_project_v1(
  text,text,text,uuid,text,text,text,integer,text[],uuid[],uuid,uuid,uuid,text) is
  'Atomic sourced video start for the Production bot. Paused worker, stale route or invalid source leaves no project/job. No approval or publication.';
