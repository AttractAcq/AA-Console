-- Phase 8: extend the existing tracking ledger, never compensated assignments.
alter table mcp_internal.mcp_delivery_tasks add column assignee text,
  add column completed_at timestamptz;
create table mcp_internal.mcp_task_mutations (
  bot_id text not null references mcp_internal.mcp_bots(bot_id),
  execution_id text not null, request_id text not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  payload jsonb not null, result jsonb not null,
  created_at timestamptz not null default now(), primary key(bot_id,execution_id)
);
alter table mcp_internal.mcp_task_mutations enable row level security;
alter table mcp_internal.mcp_task_mutations force row level security;
revoke all on mcp_internal.mcp_task_mutations from public,anon,authenticated;

create function mcp_internal.workflow_task(p_bot_id text,p_client_id uuid,p_action text,
 p_task_id uuid default null,p_title text default null,p_summary text default null,
 p_assignee text default null,p_limit integer default 25,p_after uuid default null,
 p_request_id text default null,p_execution_id text default null)
returns jsonb language plpgsql volatile security definer set search_path=mcp_internal,public as $$
declare t mcp_internal.mcp_delivery_tasks; payload jsonb; receipt mcp_internal.mcp_task_mutations;
 result jsonb; items jsonb; next_id uuid;
begin
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 if p_action is null or p_action not in ('list_tasks','get_task','create_task','assign_task','complete_task')
   or p_limit is null or p_limit not between 1 and 100 then
   raise exception using message='invalid_request',errcode='P0001'; end if;
 if p_action='list_tasks' then
   select coalesce(jsonb_agg(x.item order by x.id),'[]') into items from (
     select id,jsonb_build_object('id',id,'title',title,'summary',summary,'assignee',assignee,
       'completed_at',completed_at,'created_at',created_at,'status',case when completed_at is null then 'open' else 'complete' end) item
     from mcp_internal.mcp_delivery_tasks where client_id=p_client_id and (p_after is null or id>p_after)
     order by id limit p_limit+1) x;
   if jsonb_array_length(items)>p_limit then
     items := items - p_limit; next_id := (items->(p_limit-1)->>'id')::uuid;
   end if;
   return jsonb_build_object('client_id',p_client_id,'tasks',items,'next_cursor',next_id);
 end if;
 if p_action<>'create_task' then
   select * into t from mcp_internal.mcp_delivery_tasks where id=p_task_id for update;
   if not found then raise exception using message='task_not_found',errcode='P0001'; end if;
   if t.client_id is distinct from p_client_id then raise exception using message='client_mismatch',errcode='P0001'; end if;
 end if;
 if p_action<>'get_task' then
   perform mcp_internal.require_mcp_ids(p_request_id,p_execution_id);
   if p_action='create_task' and (p_title is null or length(btrim(p_title))<1 or length(p_title)>200 or length(p_summary)>4000)
     then raise exception using message='invalid_request',errcode='P0001'; end if;
   payload := jsonb_build_object('action',p_action,'client_id',p_client_id,'task_id',p_task_id,
     'title',p_title,'summary',p_summary,'assignee',p_assignee);
   perform pg_advisory_xact_lock(hashtextextended(p_bot_id||':workflow:'||p_execution_id,0));
   select * into receipt from mcp_internal.mcp_task_mutations where bot_id=p_bot_id and execution_id=p_execution_id;
   if found then
     if receipt.payload is distinct from payload then raise exception using message='idempotency_conflict',errcode='P0001'; end if;
     return receipt.result || jsonb_build_object('replayed',true);
   end if;
   if p_action='create_task' then
     -- Namespace the underlying Phase 7 key to avoid collisions with delivery.create_task.
     insert into mcp_internal.mcp_delivery_tasks(bot_id,execution_id,request_id,client_id,title,summary)
       values(p_bot_id,'workflow:'||p_execution_id,p_request_id,p_client_id,p_title,p_summary) returning * into t;
   elsif p_action='assign_task' then
     if t.completed_at is not null then raise exception using message='task_completed',errcode='P0001'; end if;
     if p_assignee is null then raise exception using message='invalid_request',errcode='P0001'; end if;
     if p_assignee ~ '^bot_[a-z0-9_]+$' then
       perform 1 from mcp_internal.mcp_bots where bot_id=p_assignee and status='active' for share;
       if not found then raise exception using message='invalid_assignee',errcode='P0001'; end if;
     elsif p_assignee ~ '^member:[0-9a-fA-F-]{36}$' then
       perform 1 from public.team_members where id::text=substring(p_assignee from 8) and active for share;
       if not found then raise exception using message='invalid_assignee',errcode='P0001'; end if;
     else raise exception using message='invalid_assignee',errcode='P0001'; end if;
     update mcp_internal.mcp_delivery_tasks set assignee=p_assignee where id=t.id returning * into t;
   else
     update mcp_internal.mcp_delivery_tasks set completed_at=coalesce(completed_at,now()) where id=t.id returning * into t;
   end if;
 end if;
 result := jsonb_build_object('client_id',p_client_id,'task',jsonb_build_object('id',t.id,'title',t.title,
   'summary',t.summary,'assignee',t.assignee,'completed_at',t.completed_at,'created_at',t.created_at,
   'status',case when t.completed_at is null then 'open' else 'complete' end));
 if p_action<>'get_task' then
   insert into mcp_internal.mcp_task_mutations(bot_id,execution_id,request_id,client_id,payload,result)
     values(p_bot_id,p_execution_id,p_request_id,p_client_id,payload,result);
   result := result || jsonb_build_object('replayed',false);
 end if;
 return result;
end $$;

create function mcp_internal.campaign_read(p_bot_id text,p_client_id uuid,p_action text,
 p_campaign_id uuid default null,p_limit integer default 25,p_after uuid default null,
 p_start_date date default current_date-29,p_end_date date default current_date)
returns jsonb language plpgsql volatile security definer set search_path=mcp_internal,public as $$
declare owner_id uuid; items jsonb; next_id uuid; result jsonb;
begin
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 if p_action is null or p_action not in ('list','get','get_status','get_campaign_performance')
   or p_limit is null or p_limit not between 1 and 100 then
   raise exception using message='invalid_request',errcode='P0001'; end if;
 if p_action<>'list' then
   select client_id into owner_id from public.campaigns where id=p_campaign_id for share;
   if not found then raise exception using message='campaign_not_found',errcode='P0001'; end if;
   if owner_id is distinct from p_client_id then raise exception using message='client_mismatch',errcode='P0001'; end if;
 end if;
 if p_action='get_campaign_performance' then
   if p_start_date is null or p_end_date is null or p_end_date<p_start_date or p_end_date-p_start_date>365 then
     raise exception using message='invalid_request',errcode='P0001'; end if;
   select jsonb_build_object('observations',count(*),'impressions',sum(impressions),'clicks',sum(clicks),
     'conversions',sum(conversions),'last_fetched_at',max(fetched_at),
     'availability',case when count(*)=0 then 'unknown' else 'observed' end) into result
     from public.metrics_daily where client_id=p_client_id and campaign_id=p_campaign_id
     and surface='paid' and entity_type='campaign' and metric_date between p_start_date and p_end_date;
   return jsonb_build_object('client_id',p_client_id,'campaign_id',p_campaign_id,
     'projection','observed_paid_campaign_metrics_not_causal_attribution','start_date',p_start_date,'end_date',p_end_date,'performance',result);
 end if;
 select coalesce(jsonb_agg(x.item order by x.id),'[]') into items from (
   select id,jsonb_build_object('id',id,'campaign_ref',campaign_ref,'target_role',target_role,
     'status',status,'started_on',started_on,'ended_on',ended_on) item
   from public.campaigns where client_id=p_client_id and (p_action='list' or id=p_campaign_id)
     and (p_action<>'list' or p_after is null or id>p_after) order by id limit p_limit+1) x;
 if p_action='list' then
   if jsonb_array_length(items)>p_limit then items:=items-p_limit; next_id:=(items->(p_limit-1)->>'id')::uuid; end if;
   return jsonb_build_object('client_id',p_client_id,'campaigns',items,'next_cursor',next_id);
 end if;
 return jsonb_build_object('client_id',p_client_id,'campaign',items->0,'projection','aa_campaign_operations');
end $$;

create function public.mcp_workflow_task(p_bot_id text,p_client_id uuid,p_action text,p_task_id uuid default null,p_title text default null,p_summary text default null,p_assignee text default null,p_limit integer default 25,p_after uuid default null,p_request_id text default null,p_execution_id text default null) returns jsonb language plpgsql volatile security definer
set search_path=mcp_internal,public as $$ begin
 perform mcp_internal.require_service_role();
 return mcp_internal.workflow_task(p_bot_id,p_client_id,p_action,p_task_id,p_title,p_summary,p_assignee,p_limit,p_after,p_request_id,p_execution_id);
end $$;
revoke all on function public.mcp_workflow_task(text,uuid,text,uuid,text,text,text,integer,uuid,text,text) from public,anon,authenticated;
revoke all on function mcp_internal.workflow_task(text,uuid,text,uuid,text,text,text,integer,uuid,text,text) from public,anon,authenticated;
grant execute on function public.mcp_workflow_task(text,uuid,text,uuid,text,text,text,integer,uuid,text,text) to service_role;
grant execute on function mcp_internal.workflow_task(text,uuid,text,uuid,text,text,text,integer,uuid,text,text) to service_role;

create function public.mcp_campaign_read(p_bot_id text,p_client_id uuid,p_action text,p_campaign_id uuid default null,p_limit integer default 25,p_after uuid default null,p_start_date date default current_date-29,p_end_date date default current_date) returns jsonb language plpgsql volatile security definer
set search_path=mcp_internal,public as $$ begin
 perform mcp_internal.require_service_role();
 return mcp_internal.campaign_read(p_bot_id,p_client_id,p_action,p_campaign_id,p_limit,p_after,p_start_date,p_end_date);
end $$;
revoke all on function public.mcp_campaign_read(text,uuid,text,uuid,integer,uuid,date,date) from public,anon,authenticated;
revoke all on function mcp_internal.campaign_read(text,uuid,text,uuid,integer,uuid,date,date) from public,anon,authenticated;
grant execute on function public.mcp_campaign_read(text,uuid,text,uuid,integer,uuid,date,date) to service_role;
grant execute on function mcp_internal.campaign_read(text,uuid,text,uuid,integer,uuid,date,date) to service_role;

create or replace function mcp_internal.delivery_read(p_bot_id text, p_client_id uuid, p_view text)
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
      from mcp_internal.mcp_delivery_tasks where client_id=p_client_id and completed_at is null
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


do $$ begin perform mcp_internal.assert_cos_prohibitions(); end $$;
