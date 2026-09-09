-- Phase 7: scoped delivery projections and durable, unassigned tracking tasks.
create table mcp_internal.mcp_delivery_tasks (
  id uuid primary key default gen_random_uuid(),
  bot_id text not null references mcp_internal.mcp_bots(bot_id),
  execution_id text not null,
  request_id text not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  title text not null,
  summary text,
  due_date date,
  brief_id uuid references public.client_briefs(id),
  created_at timestamptz not null default now(),
  unique(bot_id, execution_id)
);
create index mcp_delivery_tasks_client_idx on mcp_internal.mcp_delivery_tasks(client_id);
alter table mcp_internal.mcp_delivery_tasks enable row level security;
alter table mcp_internal.mcp_delivery_tasks force row level security;
revoke all on mcp_internal.mcp_delivery_tasks from public, anon, authenticated;

create function mcp_internal.delivery_list_clients(p_bot_id text, p_limit integer default 25, p_after uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = mcp_internal, public as $$
declare r record; c record; result jsonb := '[]'; last_id uuid; n integer := 0;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception using message='invalid_request', errcode='P0001'; end if;
  for r in select client_id from public.mcp_bot_clients where bot_id=p_bot_id
    and (p_after is null or client_id>p_after) order by client_id limit p_limit+1 for share
  loop
    perform mcp_internal.require_bot_client_grant(p_bot_id,r.client_id);
    if n = p_limit then return jsonb_build_object('clients',result,'next_cursor',last_id); end if;
    select id,name,initials,sector,location into c from public.clients where id=r.client_id;
    result := result || jsonb_build_array(to_jsonb(c)); last_id := r.client_id; n := n+1;
  end loop;
  return jsonb_build_object('clients',result,'next_cursor',null);
end $$;

create function mcp_internal.delivery_read(p_bot_id text, p_client_id uuid, p_view text)
returns jsonb language plpgsql volatile security definer set search_path = mcp_internal, public as $$
declare c jsonb; items jsonb; blockers jsonb; result jsonb; total integer;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
  if p_view is null or p_view not in ('get_client','get_status','get_plan','get_blockers','get_next_action','get_client_health') then
    raise exception using message='invalid_request', errcode='P0001'; end if;
  select jsonb_build_object('id',id,'name',name,'initials',initials,'sector',sector,'location',location)
    into c from public.clients where id=p_client_id;
  if c is null then raise exception using message='client_not_found', errcode='P0001'; end if;
  if p_view='get_client' then return jsonb_build_object('client_id',p_client_id,'client',c); end if;
  -- Explicit projections exclude compensation, job inputs/errors and personal data.
  with work as (
    select 'onboarding'::text as source,id,title,status::text as status,null::date as due_date,
      null::uuid as brief_id, false as blocked,display_order::text as ordering
      from public.client_onboarding_steps where client_id=p_client_id and status<>'complete'
    union all
    select 'job_assignment',id,title,'open',due_date,brief_id,coalesce(due_date<current_date,false),id::text
      from public.job_assignments where client_id=p_client_id and completed_at is null
    union all
    select 'client_assignment',id,'Active client assignment','active',due_date,null,coalesce(due_date<current_date,false),id::text
      from public.client_assignments where client_id=p_client_id and ended_at is null
    union all
    select 'agent_job',id,agent_key,status::text,null,null,status='failed',id::text
      from public.agent_jobs where client_id=p_client_id and status in ('queued','running','failed')
    union all
    select 'delivery_task',id,title,'open',due_date,brief_id,coalesce(due_date<current_date,false),id::text
      from mcp_internal.mcp_delivery_tasks where client_id=p_client_id
  ), ranked as (
    select *, row_number() over(order by blocked desc,due_date nulls last,source,ordering,id) as rn from work
  ) select coalesce(jsonb_agg(to_jsonb(ranked)-'rn'-'ordering' order by rn) filter(where rn<=50),'[]'),
    coalesce(jsonb_agg(to_jsonb(ranked)-'rn'-'ordering' order by rn) filter(where blocked and rn<=50),'[]'),count(*)
    into items,blockers,total from ranked;
  result := jsonb_build_object('client_id',p_client_id,'projection','existing_operational_records_v1',
    'truncated',total>50,'total_open_records',total);
  return result || case p_view
    when 'get_plan' then jsonb_build_object('plan',items)
    when 'get_blockers' then jsonb_build_object('blockers',blockers)
    when 'get_next_action' then jsonb_build_object('next_action',items->0)
    when 'get_client_health' then jsonb_build_object('health',case when jsonb_array_length(blockers)>0 then 'attention_required' else 'unknown' end,'blockers',blockers)
    else jsonb_build_object('client',c,'plan',items,'blockers',blockers,'next_action',items->0,
      'health',case when jsonb_array_length(blockers)>0 then 'attention_required' else 'unknown' end) end;
end $$;

create function mcp_internal.delivery_create_task(p_bot_id text,p_request_id text,p_execution_id text,p_client_id uuid,
  p_title text,p_summary text default null,p_due_date date default null,p_brief_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = mcp_internal, public as $$
declare t mcp_internal.mcp_delivery_tasks; owner_id uuid; replay boolean := false;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
  perform mcp_internal.require_mcp_ids(p_request_id,p_execution_id);
  if p_title is null or length(btrim(p_title))<1 or length(p_title)>200 or length(p_summary)>4000 then
    raise exception using message='invalid_request', errcode='P0001'; end if;
  if p_brief_id is not null then
    select client_id into owner_id from public.client_briefs where id=p_brief_id for share;
    if not found then raise exception using message='brief_not_found',errcode='P0001'; end if;
    if owner_id is distinct from p_client_id then raise exception using message='client_mismatch',errcode='P0001'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_bot_id||':'||p_execution_id,0));
  select * into t from mcp_internal.mcp_delivery_tasks where bot_id=p_bot_id and execution_id=p_execution_id;
  if found then
    if t.client_id is distinct from p_client_id or t.title is distinct from p_title or t.summary is distinct from p_summary
      or t.due_date is distinct from p_due_date or t.brief_id is distinct from p_brief_id then
      raise exception using message='idempotency_conflict',errcode='P0001'; end if;
    replay := true;
  else
    insert into mcp_internal.mcp_delivery_tasks(bot_id,request_id,execution_id,client_id,title,summary,due_date,brief_id)
      values(p_bot_id,p_request_id,p_execution_id,p_client_id,p_title,p_summary,p_due_date,p_brief_id) returning * into t;
  end if;
  return jsonb_build_object('client_id',p_client_id,'task',jsonb_build_object('id',t.id,'title',t.title,
    'summary',t.summary,'due_date',t.due_date,'brief_id',t.brief_id,'created_at',t.created_at,'status','open'),'replayed',replay);
end $$;

create function public.mcp_delivery_list_clients(p_bot_id text,p_limit integer default 25,p_after uuid default null) returns jsonb language plpgsql volatile security definer
set search_path=mcp_internal,public as $$ begin
  perform mcp_internal.require_service_role();
  return mcp_internal.delivery_list_clients(p_bot_id,p_limit,p_after);
end $$;
revoke all on function public.mcp_delivery_list_clients(text,integer,uuid) from public,anon,authenticated;
revoke all on function mcp_internal.delivery_list_clients(text,integer,uuid) from public,anon,authenticated;
grant execute on function public.mcp_delivery_list_clients(text,integer,uuid) to service_role;
grant execute on function mcp_internal.delivery_list_clients(text,integer,uuid) to service_role;

create function public.mcp_delivery_read(p_bot_id text,p_client_id uuid,p_view text) returns jsonb language plpgsql volatile security definer
set search_path=mcp_internal,public as $$ begin
  perform mcp_internal.require_service_role();
  return mcp_internal.delivery_read(p_bot_id,p_client_id,p_view);
end $$;
revoke all on function public.mcp_delivery_read(text,uuid,text) from public,anon,authenticated;
revoke all on function mcp_internal.delivery_read(text,uuid,text) from public,anon,authenticated;
grant execute on function public.mcp_delivery_read(text,uuid,text) to service_role;
grant execute on function mcp_internal.delivery_read(text,uuid,text) to service_role;

create function public.mcp_delivery_create_task(p_bot_id text,p_request_id text,p_execution_id text,p_client_id uuid,p_title text,p_summary text default null,p_due_date date default null,p_brief_id uuid default null) returns jsonb language plpgsql volatile security definer
set search_path=mcp_internal,public as $$ begin
  perform mcp_internal.require_service_role();
  return mcp_internal.delivery_create_task(p_bot_id,p_request_id,p_execution_id,p_client_id,p_title,p_summary,p_due_date,p_brief_id);
end $$;
revoke all on function public.mcp_delivery_create_task(text,text,text,uuid,text,text,date,uuid) from public,anon,authenticated;
revoke all on function mcp_internal.delivery_create_task(text,text,text,uuid,text,text,date,uuid) from public,anon,authenticated;
grant execute on function public.mcp_delivery_create_task(text,text,text,uuid,text,text,date,uuid) to service_role;
grant execute on function mcp_internal.delivery_create_task(text,text,text,uuid,text,text,date,uuid) to service_role;

do $$ begin perform mcp_internal.assert_cos_prohibitions(); end $$;
