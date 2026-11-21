-- One paid pre-render visual review per exact IR version. A claimed or
-- uncertain review cannot silently call Lambda or the model again. The
-- render-attempt trigger below makes a passing receipt a database invariant.
create table public.video_project_prerender_attempts_v1 (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  client_id uuid not null,
  ir_version integer not null check (ir_version>0),
  job_id uuid not null references public.agent_jobs(id),
  state text not null default 'claimed'
    check (state in ('claimed','uncertain','decided')),
  result text check (result in ('pass','fail')),
  report jsonb,
  still_receipts jsonb,
  model text,
  input_tokens bigint,
  output_tokens bigint,
  model_usd numeric(12,6),
  still_usd numeric(12,6),
  claimed_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  foreign key(project_id,client_id) references public.video_projects(id,client_id)
    on delete cascade,
  unique(project_id,ir_version),
  check ((state='decided' and result is not null and report is not null
    and still_receipts is not null and model is not null
    and input_tokens is not null and output_tokens is not null
    and model_usd is not null and still_usd is not null
    and decided_at is not null)
    or (state<>'decided' and result is null and report is null
      and still_receipts is null and model is null and input_tokens is null
      and output_tokens is null and model_usd is null and still_usd is null
      and decided_at is null))
);
create index video_project_prerender_attempts_client_v1
  on public.video_project_prerender_attempts_v1
  (client_id,project_id,claimed_at desc);
alter table public.video_project_prerender_attempts_v1 enable row level security;
create policy video_project_prerender_attempts_read_v1
  on public.video_project_prerender_attempts_v1 for select to authenticated
  using(public.can_access_client(client_id));
revoke all on public.video_project_prerender_attempts_v1
  from public,anon,authenticated,service_role;
grant select on public.video_project_prerender_attempts_v1
  to authenticated,service_role;

create function public.claim_video_project_prerender_v1(
  p_project_id uuid,p_job_id uuid,p_ir_version integer
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  j public.agent_jobs%rowtype;
  a public.video_project_prerender_attempts_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service pre-render claim only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into j from public.agent_jobs where id=p_job_id;
  if p.id is null or p.stage is distinct from 'timed'
    or p.ir_version is distinct from p_ir_version
    or j.id is null or j.agent_key is distinct from 'video_render'
    or j.input_table is distinct from 'video_projects'
    or j.input_id is distinct from p.id or j.client_id is distinct from p.client_id
    or j.params->>'ir_version' is distinct from p_ir_version::text
    or not public.video_project_source_current_v1(p.id)
    or not public.complete_video_audio_project_v1(p.id,p_ir_version) then
    raise exception 'Pre-render claim requires an exact timed project and job.'
      using errcode='23514'; end if;
  select * into a from public.video_project_prerender_attempts_v1
    where project_id=p.id and ir_version=p_ir_version;
  if a.id is not null then
    if a.job_id is distinct from j.id then
      raise exception 'Pre-render review belongs to another job.'
        using errcode='23514'; end if;
    return jsonb_build_object('attempt_id',a.id,'state',
      case a.state when 'claimed' then 'already_claimed'
        when 'decided' then 'decided_'||a.result else a.state end);
  end if;
  if exists(select 1 from public.video_project_render_attempts_v1
      where project_id=p.id and ir_version=p_ir_version) then
    raise exception 'Pre-render review cannot follow a Lambda render start.'
      using errcode='23514'; end if;
  insert into public.video_project_prerender_attempts_v1
    (project_id,client_id,ir_version,job_id)
  values(p.id,p.client_id,p_ir_version,j.id) returning * into a;
  update public.video_projects set stage_error=
    'Pre-render visual review claimed; reconcile an interrupted paid attempt.'
    where id=p.id;
  return jsonb_build_object('attempt_id',a.id,'state','claimed');
end $$;
revoke all on function public.claim_video_project_prerender_v1(uuid,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_video_project_prerender_v1(uuid,uuid,integer)
  to service_role;

create function public.mark_video_project_prerender_uncertain_v1(
  p_attempt_id uuid,p_job_id uuid
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_prerender_attempts_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service pre-render reconciliation only.' using errcode='42501'; end if;
  select * into a from public.video_project_prerender_attempts_v1
    where id=p_attempt_id for update;
  if a.id is null or a.job_id is distinct from p_job_id
    or a.state not in ('claimed','uncertain') then
    raise exception 'Pre-render attempt cannot become uncertain.'
      using errcode='23514'; end if;
  update public.video_project_prerender_attempts_v1 set state='uncertain'
    where id=a.id;
  update public.video_projects set stage_error=
    'Pre-render paid outcome is uncertain; reconcile before another attempt.'
    where id=a.project_id;
  return true;
end $$;
revoke all on function public.mark_video_project_prerender_uncertain_v1(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.mark_video_project_prerender_uncertain_v1(uuid,uuid)
  to service_role;

create function public.finish_video_project_prerender_v1(
  p_attempt_id uuid,p_job_id uuid,p_report jsonb,p_still_receipts jsonb,
  p_model text,p_input_tokens bigint,p_output_tokens bigint,
  p_model_usd numeric,p_still_usd numeric
) returns text language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_prerender_attempts_v1%rowtype;
  p public.video_projects%rowtype;
  v_checks integer;
  v_batches integer;
  v_samples integer;
  v_bad integer;
  v_still_sum numeric;
  v_model_usd numeric(12,6);
  v_still_usd numeric(12,6);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service pre-render decision only.' using errcode='42501'; end if;
  if p_report is null or jsonb_typeof(p_report) is distinct from 'object'
    or p_report->>'result' not in ('pass','fail')
    or jsonb_typeof(p_report->'checks') is distinct from 'array'
    or jsonb_typeof(p_report->'patch') is distinct from 'array'
    or jsonb_typeof(p_still_receipts) is distinct from 'array'
    or p_model is null or length(btrim(p_model)) not between 1 and 65
    or p_input_tokens is null or p_input_tokens not between 1 and 10000000
    or p_output_tokens is null or p_output_tokens not between 1 and 10000000
    or p_model_usd is null or p_model_usd not between 0 and 100
    or p_still_usd is null or p_still_usd not between 0 and 10000 then
    raise exception 'Pre-render report or price is invalid.' using errcode='22023'; end if;
  v_model_usd:=round(p_model_usd,6);
  v_still_usd:=round(p_still_usd,6);
  select * into a from public.video_project_prerender_attempts_v1
    where id=p_attempt_id for update;
  if a.id is null or a.job_id is distinct from p_job_id then
    raise exception 'Pre-render attempt differs from its job.'
      using errcode='23514'; end if;
  if a.state='decided' then
    if a.report is distinct from p_report
      or a.still_receipts is distinct from p_still_receipts
      or a.model is distinct from p_model
      or a.input_tokens is distinct from p_input_tokens
      or a.output_tokens is distinct from p_output_tokens
      or a.model_usd is distinct from v_model_usd
      or a.still_usd is distinct from v_still_usd
      or not exists(select 1 from public.video_project_costs c
        where c.attempt_key='video-prerender-model:'||a.id::text)
      or not exists(select 1 from public.video_project_costs c
        where c.attempt_key='video-prerender-stills:'||a.id::text) then
      raise exception 'Pre-render decision replay differs from receipt.'
        using errcode='23514'; end if;
    return a.result;
  end if;
  select * into p from public.video_projects where id=a.project_id for update;
  if a.state is distinct from 'claimed' or p.id is null
    or p.stage is distinct from 'timed'
    or p.client_id is distinct from a.client_id
    or p.ir_version is distinct from a.ir_version
    or not public.video_project_source_current_v1(p.id)
    or not public.complete_video_audio_project_v1(p.id,a.ir_version) then
    raise exception 'Pre-render attempt is not current or needs reconciliation.'
      using errcode='23514'; end if;
  v_samples:=jsonb_array_length(p_still_receipts);
  v_batches:=(v_samples+89)/90;
  v_checks:=jsonb_array_length(p_report->'checks');
  if v_samples<>3*jsonb_array_length(p.ir->'scenes')
    or v_samples not between 9 and 120
    or v_checks<>8*v_batches
    or (p_report->>'sampled_frames')::integer is distinct from v_samples
    or (p_report->>'batches')::integer is distinct from v_batches
    or p_report->>'model' is distinct from btrim(p_model)
    or (p_report->'usage'->>'inputTokens')::bigint is distinct from p_input_tokens
    or (p_report->'usage'->>'outputTokens')::bigint is distinct from p_output_tokens
    or round((p_report->'usage'->>'costUsd')::numeric,6)
      is distinct from v_model_usd
    or jsonb_array_length(p_report->'patch')>40
    or (p_report->>'result'='pass'
      and jsonb_array_length(p_report->'patch')<>0) then
    raise exception 'Pre-render report does not cover the exact scene set.'
      using errcode='23514'; end if;
  select count(*) filter (where item->>'sceneId' is null
      or item->>'frame' is null or item->>'renderId' is null
      or item->>'renderId' !~ '^[A-Za-z0-9-]{3,128}$'
      or item->>'sceneId' is distinct from
        's'||lpad(((ord-1)/3+1)::text,2,'0')
      or (item->>'frame')::integer<0
      or (item->>'costUsd')::numeric<0),
    sum((item->>'costUsd')::numeric)
    into v_bad,v_still_sum
    from jsonb_array_elements(p_still_receipts) with ordinality as still(item,ord);
  if v_bad<>0 or round(v_still_sum,6) is distinct from v_still_usd
    or (select count(distinct item->>'renderId')
      from jsonb_array_elements(p_still_receipts) item)<>v_samples then
    raise exception 'Pre-render still receipts or USD total disagree.'
      using errcode='23514'; end if;
  select count(*) into v_bad from jsonb_array_elements(p_report->'checks') item
    where item->>'area' not in (
      'text_overflow','caption_overlap','contrast','safe_area',
      'reading_time','brand_token','empty_frame','narration_visual_match')
      or item->>'verdict' not in ('pass','fail')
      or nullif(btrim(coalesce(item->>'reason','')),'') is null
      or (item->>'sceneId' is not null and not exists(
        select 1 from public.video_scenes s where s.project_id=p.id
          and s.scene_key=item->>'sceneId'));
  if v_bad<>0
    or exists(select 1 from (
      select item->>'area' area,count(*) n
      from jsonb_array_elements(p_report->'checks') item
      group by item->>'area') counts where n<>v_batches)
    or ((p_report->>'result'='pass') is distinct from
      not exists(select 1 from jsonb_array_elements(p_report->'checks') item
        where item->>'verdict'='fail')) then
    raise exception 'Pre-render checks conflict with the verdict.'
      using errcode='23514'; end if;
  insert into public.video_project_costs
    (project_id,client_id,job_id,stage,provider,units,unit,usd,attempt_key)
  values(p.id,p.client_id,a.job_id,'prerender_stills',
    'remotion_lambda_estimate',v_samples,'images',v_still_usd,
    'video-prerender-stills:'||a.id::text);
  insert into public.video_project_costs
    (project_id,client_id,job_id,stage,provider,units,unit,usd,attempt_key)
  values(p.id,p.client_id,a.job_id,'prerender_critic',
    'anthropic:'||btrim(p_model),p_input_tokens+p_output_tokens,'tokens',
    v_model_usd,'video-prerender-model:'||a.id::text);
  update public.video_project_prerender_attempts_v1
    set state='decided',result=p_report->>'result',report=p_report,
      still_receipts=p_still_receipts,model=btrim(p_model),
      input_tokens=p_input_tokens,output_tokens=p_output_tokens,
      model_usd=v_model_usd,still_usd=v_still_usd,
      decided_at=clock_timestamp() where id=a.id;
  update public.video_projects set
    cost_usd=cost_usd+v_model_usd+v_still_usd,
    critic_reports=critic_reports||jsonb_build_array(
      jsonb_build_object('attempt_id',a.id,'ir_version',a.ir_version,
        'report',p_report,'still_receipts',p_still_receipts)),
    stage=case when p_report->>'result'='fail'
      and jsonb_array_length(p_report->'patch')=0
      then 'needs_human' else stage end,
    stage_error=case when p_report->>'result'='pass'
      then 'Pre-render critic passed; Lambda media render may start.'
      when jsonb_array_length(p_report->'patch')=0
      then 'Pre-render critic failed without an automatic patch.'
      else 'Pre-render critic patch awaits exact-version commit.' end
    where id=p.id;
  return p_report->>'result';
end $$;
revoke all on function public.finish_video_project_prerender_v1(
  uuid,uuid,jsonb,jsonb,text,bigint,bigint,numeric,numeric)
  from public,anon,authenticated,service_role;
grant execute on function public.finish_video_project_prerender_v1(
  uuid,uuid,jsonb,jsonb,text,bigint,bigint,numeric,numeric)
  to service_role;

create function public.video_project_prerender_render_gate_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.video_project_prerender_attempts_v1 a
      where a.project_id=new.project_id and a.client_id=new.client_id
        and a.ir_version=new.ir_version and a.job_id=new.job_id
        and a.state='decided' and a.result='pass') then
    raise exception 'Lambda render requires an exact passing pre-render critic receipt.'
      using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.video_project_prerender_render_gate_v1()
  from public,anon,authenticated,service_role;
create trigger video_project_prerender_render_gate_v1
  before insert on public.video_project_render_attempts_v1
  for each row execute function public.video_project_prerender_render_gate_v1();
