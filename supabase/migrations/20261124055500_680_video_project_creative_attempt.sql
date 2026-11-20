-- A paid creative review has one durable claim before the model call. A
-- claimed/uncertain attempt cannot automatically start a second model call.
-- Cost and the exact candidate decision commit together after a result.
create table public.video_project_creative_attempts_v1 (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique
    references public.video_project_render_candidates_v1(id) on delete cascade,
  project_id uuid not null,
  client_id uuid not null,
  ir_version integer not null check (ir_version>0),
  job_id uuid not null references public.agent_jobs(id),
  state text not null default 'claimed'
    check (state in ('claimed','uncertain','decided')),
  report jsonb,
  model text,
  input_tokens bigint,
  output_tokens bigint,
  usd numeric(12,6),
  claimed_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  foreign key (project_id,client_id) references public.video_projects(id,client_id),
  check ((state='decided' and report is not null and model is not null
    and input_tokens is not null and output_tokens is not null
    and usd is not null and decided_at is not null)
    or (state<>'decided' and report is null and decided_at is null))
);
create index video_project_creative_attempts_client_v1
  on public.video_project_creative_attempts_v1(client_id,project_id,claimed_at desc);
alter table public.video_project_creative_attempts_v1 enable row level security;
create policy video_project_creative_attempts_read_v1
  on public.video_project_creative_attempts_v1 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.video_project_creative_attempts_v1
  from public,anon,authenticated,service_role;
grant select on public.video_project_creative_attempts_v1
  to authenticated,service_role;

create function public.claim_video_project_creative_v1(
  p_candidate_id uuid,p_job_id uuid
) returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare c public.video_project_render_candidates_v1%rowtype;
  p public.video_projects%rowtype;
  j public.agent_jobs%rowtype;
  a public.video_project_creative_attempts_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service creative claim only.' using errcode='42501'; end if;
  select * into c from public.video_project_render_candidates_v1
    where id=p_candidate_id for update;
  select * into p from public.video_projects where id=c.project_id for update;
  select * into j from public.agent_jobs where id=p_job_id;
  if c.id is null or p.id is null or j.id is null
    or p.client_id is distinct from c.client_id
    or p.ir_version is distinct from c.ir_version
    or p.stage is distinct from 'timed'
    or c.aspect is distinct from p.aspects[1]
    or c.probe_result is distinct from 'pass'
    or j.agent_key is distinct from 'video_render'
    or j.input_table is distinct from 'video_projects'
    or j.input_id is distinct from p.id
    or j.client_id is distinct from p.client_id
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Creative claim differs from current render.'
      using errcode='23514'; end if;
  select * into a from public.video_project_creative_attempts_v1
    where candidate_id=c.id;
  if a.id is not null then
    if a.job_id is distinct from j.id or a.ir_version is distinct from p.ir_version then
      raise exception 'Creative claim belongs to another job or version.'
        using errcode='23514'; end if;
    return jsonb_build_object('attempt_id',a.id,'state',
      case a.state when 'claimed' then 'already_claimed' else a.state end);
  end if;
  if c.verdict is distinct from 'pending' then
    raise exception 'Candidate already has a creative decision.'
      using errcode='23514'; end if;
  insert into public.video_project_creative_attempts_v1
    (candidate_id,project_id,client_id,ir_version,job_id)
  values(c.id,p.id,p.client_id,p.ir_version,j.id)
  returning * into a;
  return jsonb_build_object('attempt_id',a.id,'state','claimed');
end $$;
revoke all on function public.claim_video_project_creative_v1(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_video_project_creative_v1(uuid,uuid)
  to service_role;

create function public.mark_video_project_creative_uncertain_v1(
  p_attempt_id uuid,p_job_id uuid
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_creative_attempts_v1%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service creative reconciliation only.' using errcode='42501'; end if;
  select * into a from public.video_project_creative_attempts_v1
    where id=p_attempt_id for update;
  if a.id is null or a.job_id is distinct from p_job_id
    or a.state not in ('claimed','uncertain') then
    raise exception 'Creative attempt cannot be marked uncertain.'
      using errcode='23514'; end if;
  update public.video_project_creative_attempts_v1 set state='uncertain'
    where id=a.id;
  return true;
end $$;
revoke all on function public.mark_video_project_creative_uncertain_v1(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.mark_video_project_creative_uncertain_v1(uuid,uuid)
  to service_role;

create function public.finish_video_project_creative_v1(
  p_attempt_id uuid,p_job_id uuid,p_report jsonb,p_model text,
  p_input_tokens bigint,p_output_tokens bigint,p_usd numeric
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_creative_attempts_v1%rowtype;
  c public.video_project_render_candidates_v1%rowtype;
  p public.video_projects%rowtype;
  saved public.video_project_costs%rowtype;
  v_key text;
  v_usd numeric(12,6);
  v_verdict text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service creative completion only.' using errcode='42501'; end if;
  if p_report is null or jsonb_typeof(p_report)<>'object'
    or p_report->>'result' is null
    or p_report->>'result' not in ('pass','fail')
    or jsonb_typeof(p_report->'checks') is distinct from 'array'
    or p_model is null or length(btrim(p_model)) not between 1 and 65
    or p_input_tokens is null or p_input_tokens not between 1 and 10000000
    or p_output_tokens is null or p_output_tokens not between 1 and 10000000
    or p_usd is null or p_usd<0 or p_usd>100 then
    raise exception 'Creative report or cost is invalid.' using errcode='22023'; end if;
  if (p_report->>'result'='fail' and not exists (
      select 1 from jsonb_array_elements(p_report->'checks') item
      where item->>'verdict'='fail'))
    or (p_report->>'result'='pass' and exists (
      select 1 from jsonb_array_elements(p_report->'checks') item
      where item->>'verdict' is distinct from 'pass')) then
    raise exception 'Creative result contradicts its checks.'
      using errcode='23514'; end if;
  v_usd:=round(p_usd,6);
  v_verdict:=case p_report->>'result' when 'pass' then 'accepted'
    else 'rejected' end;
  select * into a from public.video_project_creative_attempts_v1
    where id=p_attempt_id for update;
  if a.id is null or a.job_id is distinct from p_job_id then
    raise exception 'Creative attempt does not match job.' using errcode='23514'; end if;
  v_key:='video-creative:'||a.id::text;
  if a.state='decided' then
    select * into saved from public.video_project_costs where attempt_key=v_key;
    if a.report is distinct from p_report or a.model is distinct from p_model
      or a.input_tokens is distinct from p_input_tokens
      or a.output_tokens is distinct from p_output_tokens
      or a.usd is distinct from v_usd or saved.id is null
      or saved.usd is distinct from v_usd then
      raise exception 'Creative completion replay differs from receipt.'
        using errcode='23514'; end if;
    return a.candidate_id;
  end if;
  select * into c from public.video_project_render_candidates_v1
    where id=a.candidate_id for update;
  select * into p from public.video_projects where id=a.project_id for update;
  if a.state is distinct from 'claimed'
    or c.id is null or p.id is null
    or c.project_id is distinct from p.id
    or c.client_id is distinct from a.client_id
    or c.ir_version is distinct from a.ir_version
    or p.ir_version is distinct from a.ir_version
    or p.stage is distinct from 'timed'
    or c.verdict is distinct from 'pending'
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Creative attempt is not current or needs reconciliation.'
      using errcode='23514'; end if;
  insert into public.video_project_costs
    (project_id,client_id,job_id,stage,provider,units,unit,usd,attempt_key)
  values(p.id,p.client_id,a.job_id,'creative',
    'anthropic:'||btrim(p_model),p_input_tokens+p_output_tokens,
    'tokens',v_usd,v_key);
  perform public.decide_video_project_render_candidate_v1(c.id,v_verdict,
    p_report,case when v_verdict='rejected' then p_report->>'summary'
      else null end);
  update public.video_project_creative_attempts_v1
    set state='decided',report=p_report,model=btrim(p_model),
      input_tokens=p_input_tokens,output_tokens=p_output_tokens,
      usd=v_usd,decided_at=clock_timestamp() where id=a.id;
  update public.video_projects set cost_usd=cost_usd+v_usd,
    stage=case when v_verdict='rejected' then 'needs_human' else stage end,
    stage_error=case when v_verdict='rejected'
      then left('Creative review failed: '||coalesce(p_report->>'summary',''),1000)
      else stage_error end
    where id=p.id;
  return c.id;
end $$;
revoke all on function public.finish_video_project_creative_v1(
  uuid,uuid,jsonb,text,bigint,bigint,numeric)
  from public,anon,authenticated,service_role;
grant execute on function public.finish_video_project_creative_v1(
  uuid,uuid,jsonb,text,bigint,bigint,numeric)
  to service_role;

-- The existing service-only decision is kept for probe failures and
-- derivatives. A passing first aspect cannot be accepted or rejected by a
-- model without the durable paid review claim and cost receipt.
create function public.video_project_creative_cost_gate_v1()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  a public.video_project_creative_attempts_v1%rowtype;
begin
  if old.verdict is distinct from 'pending' or new.verdict='pending'
    or old.probe_result is distinct from 'pass' then return new; end if;
  select * into p from public.video_projects where id=new.project_id;
  if new.aspect is distinct from p.aspects[1] then return new; end if;
  select * into a from public.video_project_creative_attempts_v1
    where candidate_id=new.id;
  if a.id is null or a.state is distinct from 'claimed'
    or not exists(select 1 from public.video_project_costs cost
      where cost.attempt_key='video-creative:'||a.id::text
        and cost.project_id=new.project_id and cost.client_id=new.client_id
        and cost.job_id=a.job_id and cost.stage='creative') then
    raise exception 'First-aspect creative decision needs a paid review receipt.'
      using errcode='23514'; end if;
  return new;
end $$;
revoke all on function public.video_project_creative_cost_gate_v1()
  from public,anon,authenticated,service_role;
create trigger video_project_creative_cost_gate_v1
  before update of verdict on public.video_project_render_candidates_v1
  for each row execute function public.video_project_creative_cost_gate_v1();
