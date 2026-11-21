-- File the provider's final USD estimate once per durable Lambda attempt.
-- It is an estimate, not the reconciled AWS invoice or a licensing charge.
create function public.record_video_project_render_cost_v1(
  p_attempt_id uuid,p_job_id uuid,p_billing_ms bigint,
  p_estimated_usd numeric,p_currency text
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_render_attempts_v1%rowtype;
  p public.video_projects%rowtype;
  j public.agent_jobs%rowtype;
  saved public.video_project_costs%rowtype;
  v_key text;
  v_id uuid;
  v_usd numeric(12,6);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video render cost only.' using errcode='42501'; end if;
  if p_billing_ms is null or p_billing_ms not between 1 and 9999999999
    or p_estimated_usd is null or p_estimated_usd<0
    or p_estimated_usd>10000 or p_currency is distinct from 'USD' then
    raise exception 'Invalid Lambda billing estimate.' using errcode='22023'; end if;
  v_usd:=round(p_estimated_usd,6);
  select * into a from public.video_project_render_attempts_v1
    where id=p_attempt_id for update;
  select * into p from public.video_projects where id=a.project_id for update;
  select * into j from public.agent_jobs where id=p_job_id;
  if a.id is null or p.id is null or j.id is null
    or a.job_id is distinct from p_job_id
    or a.client_id is distinct from p.client_id
    or j.client_id is distinct from p.client_id
    or j.input_table is distinct from 'video_projects'
    or j.input_id is distinct from p.id
    or j.agent_key is distinct from 'video_render'
    or a.render_id is null or a.serve_url is null then
    raise exception 'Lambda cost differs from its exact render attempt.'
      using errcode='23514'; end if;
  v_key:='video-render:'||a.id::text;
  select * into saved from public.video_project_costs
    where attempt_key=v_key;
  if saved.id is not null then
    if saved.project_id is distinct from p.id
      or saved.client_id is distinct from p.client_id
      or saved.job_id is distinct from j.id
      or saved.stage is distinct from 'render'
      or saved.provider is distinct from 'remotion_lambda_estimate'
      or saved.units is distinct from p_billing_ms
      or saved.unit is distinct from 'billing_ms'
      or saved.usd is distinct from v_usd then
      raise exception 'Lambda cost replay differs from its receipt.'
        using errcode='23514'; end if;
    return saved.id;
  end if;
  if a.state is distinct from 'started'
    or p.stage is distinct from 'timed'
    or p.ir_version is distinct from a.ir_version
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Lambda cost requires a current started render.'
      using errcode='23514'; end if;
  insert into public.video_project_costs(project_id,client_id,job_id,stage,
    provider,units,unit,usd,attempt_key)
  values(p.id,p.client_id,j.id,'render','remotion_lambda_estimate',
    p_billing_ms,'billing_ms',v_usd,v_key)
  returning id into v_id;
  update public.video_projects set cost_usd=cost_usd+v_usd where id=p.id;
  return v_id;
end $$;
revoke all on function public.record_video_project_render_cost_v1(
  uuid,uuid,bigint,numeric,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_video_project_render_cost_v1(
  uuid,uuid,bigint,numeric,text) to service_role;

create function public.video_project_render_candidate_cost_gate_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_render_attempts_v1%rowtype;
begin
  select * into a from public.video_project_render_attempts_v1
    where id=new.attempt_id;
  if a.id is null or a.project_id is distinct from new.project_id
    or a.client_id is distinct from new.client_id
    or not exists(select 1 from public.video_project_costs cost
      where cost.attempt_key='video-render:'||a.id::text
        and cost.project_id=a.project_id and cost.client_id=a.client_id
        and cost.job_id=a.job_id and cost.stage='render'
        and cost.provider='remotion_lambda_estimate') then
    raise exception 'A Lambda cost receipt is required before the candidate.'
      using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.video_project_render_candidate_cost_gate_v1()
  from public,anon,authenticated,service_role;
create trigger video_project_render_candidate_cost_gate_v1
  before insert on public.video_project_render_candidates_v1
  for each row execute function public.video_project_render_candidate_cost_gate_v1();
