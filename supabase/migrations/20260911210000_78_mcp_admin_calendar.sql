-- Phase 12 AA-native Admin events. No dependency on deferred migration 77.
-- No tokens, client grants, external scheduling or Production connector changes.
begin;
create table mcp_internal.mcp_admin_events (
 id uuid primary key default gen_random_uuid(),
 client_id uuid not null references public.clients(id),
 title text not null check (length(btrim(title)) between 1 and 200),
 notes text check (length(notes) <= 2000),
 event_type text not null check (event_type in ('meeting','reminder','admin')),
 starts_at timestamptz not null check (isfinite(starts_at)),
 ends_at timestamptz check (isfinite(ends_at)),
 status text not null default 'scheduled' check (status in ('scheduled','completed','cancelled')),
 created_by_bot text not null references mcp_internal.mcp_bots(bot_id) check (created_by_bot='bot_admin'),
 updated_by_bot text not null references mcp_internal.mcp_bots(bot_id) check (updated_by_bot='bot_admin'),
 version integer not null default 1 check (version > 0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check (ends_at is null or ends_at > starts_at),
 check (event_type <> 'meeting' or ends_at is not null)
);
create index mcp_admin_events_client_idx on mcp_internal.mcp_admin_events(client_id,id);
create index mcp_admin_events_due_idx on mcp_internal.mcp_admin_events(client_id,starts_at) where status='scheduled';
create table mcp_internal.mcp_admin_requests (
 bot_id text not null references mcp_internal.mcp_bots(bot_id),
 execution_id text not null check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 tool text not null check (tool in ('admin.create_event','admin.update_event')),
 client_id uuid not null references public.clients(id),
 event_id uuid not null references mcp_internal.mcp_admin_events(id),
 payload jsonb not null, result jsonb not null, created_at timestamptz not null default now(),
 primary key(bot_id,execution_id)
);
alter table mcp_internal.mcp_admin_events enable row level security;
alter table mcp_internal.mcp_admin_events force row level security;
alter table mcp_internal.mcp_admin_requests enable row level security;
alter table mcp_internal.mcp_admin_requests force row level security;
revoke all on mcp_internal.mcp_admin_events, mcp_internal.mcp_admin_requests from public,anon,authenticated,service_role;

create function mcp_internal.require_admin_permission(p_bot_id text,p_client_id uuid,p_tool text)
returns void language plpgsql volatile security definer set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
begin
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 if p_bot_id is distinct from 'bot_admin' or p_tool not in
 ('admin.list_events','admin.get_event','admin.create_event','admin.update_event') then
   raise exception using message='bot_forbidden',errcode='P0001';
 end if;
 -- Lock identity and exact permission until the operation/replay finishes.
 perform 1 from mcp_internal.mcp_bots where bot_id=p_bot_id and status='active' for share;
 if not found then raise exception using message='bot_not_active',errcode='P0001'; end if;
 perform 1 from mcp_internal.mcp_bot_permissions where bot_id=p_bot_id and permission_pattern=p_tool for share;
 if not found then raise exception using message='bot_forbidden',errcode='P0001'; end if;
end $$;
revoke all on function mcp_internal.require_admin_permission(text,uuid,text) from public,anon,authenticated,service_role;

create function mcp_internal.admin_list_events(p_bot_id text,p_client_id uuid,p_limit integer default 25,p_after uuid default null,p_status text default null,p_due_before timestamptz default null)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare items jsonb; cursor_id uuid;
begin
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 perform mcp_internal.require_admin_permission(p_bot_id,p_client_id,'admin.list_events');
 if p_limit is null or p_limit not between 1 and 100 or (p_status is not null and p_status not in ('scheduled','completed','cancelled'))
 or (p_due_before is not null and not isfinite(p_due_before)) then
 raise exception using message='invalid_request',errcode='P0001'; end if;
 if p_after is not null and not exists(select 1 from mcp_internal.mcp_admin_events where id=p_after and client_id=p_client_id) then
 raise exception using message='event_not_found',errcode='P0001'; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]') into items from (
 select id,client_id,title,event_type,starts_at,ends_at,status,version,created_by_bot,updated_by_bot,created_at,updated_at
 from mcp_internal.mcp_admin_events where client_id=p_client_id and (p_after is null or id>p_after)
 and (p_status is null or status=p_status) and (p_due_before is null or starts_at<=p_due_before)
 order by id limit p_limit+1) x;
 if jsonb_array_length(items)>p_limit then items:=items-p_limit; cursor_id:=(items->(p_limit-1)->>'id')::uuid; end if;
 return jsonb_build_object('client_id',p_client_id,'events',items,'next_cursor',cursor_id);
end $$;

create function mcp_internal.admin_get_event(p_bot_id text,p_client_id uuid,p_event_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare e mcp_internal.mcp_admin_events;
begin
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 perform mcp_internal.require_admin_permission(p_bot_id,p_client_id,'admin.get_event');
 select * into e from mcp_internal.mcp_admin_events where id=p_event_id and client_id=p_client_id;
 -- Missing and foreign resources deliberately have the same error.
 if not found then raise exception using message='event_not_found',errcode='P0001'; end if;
 return jsonb_build_object('client_id',p_client_id,'event',to_jsonb(e));
end $$;

create function mcp_internal.admin_create_event(p_bot_id text,p_client_id uuid,p_request_id text,p_execution_id text,p_event_type text,p_title text,p_notes text,p_starts_at timestamptz,p_ends_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare e mcp_internal.mcp_admin_events; receipt mcp_internal.mcp_admin_requests; payload jsonb; result jsonb;
begin
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 perform mcp_internal.require_admin_permission(p_bot_id,p_client_id,'admin.create_event');
 perform mcp_internal.require_mcp_ids(p_request_id,p_execution_id);
 if p_title is null or length(btrim(p_title)) not between 1 and 200 or length(p_notes)>2000
 or p_starts_at is null or not isfinite(p_starts_at)
 or (p_ends_at is not null and (not isfinite(p_ends_at) or p_ends_at<=p_starts_at)) then
 raise exception using message='invalid_request',errcode='P0001'; end if;
 payload:=jsonb_build_object('title',p_title,'notes',p_notes,'starts_at',p_starts_at,'ends_at',p_ends_at,'event_type',p_event_type);
 perform pg_advisory_xact_lock(hashtextextended(p_bot_id||':admin:'||p_execution_id,0));
 select * into receipt from mcp_internal.mcp_admin_requests where bot_id=p_bot_id and execution_id=p_execution_id;
 if found then
   if receipt.tool is distinct from 'admin.create_event' or receipt.client_id is distinct from p_client_id or receipt.payload is distinct from payload then
     raise exception using message='idempotency_conflict',errcode='P0001'; end if;
   return receipt.result || jsonb_build_object('replayed',true);
 end if;
 if p_event_type is null or p_event_type not in ('meeting','reminder','admin') or (p_event_type='meeting' and p_ends_at is null) then
 raise exception using message='invalid_request',errcode='P0001'; end if;
 insert into mcp_internal.mcp_admin_events(client_id,title,notes,event_type,starts_at,ends_at,created_by_bot,updated_by_bot)
 values(p_client_id,btrim(p_title),p_notes,p_event_type,p_starts_at,p_ends_at,p_bot_id,p_bot_id) returning * into e;
 result:=jsonb_build_object('client_id',p_client_id,'event',to_jsonb(e),'replayed',false);
 insert into mcp_internal.mcp_admin_requests(bot_id,execution_id,request_id,tool,client_id,event_id,payload,result)
 values(p_bot_id,p_execution_id,p_request_id,'admin.create_event',p_client_id,e.id,payload,result);
 return result;
end $$;

create function mcp_internal.admin_update_event(p_bot_id text,p_client_id uuid,p_request_id text,p_execution_id text,p_event_id uuid,p_expected_version integer,p_status text,p_title text,p_notes text,p_starts_at timestamptz,p_ends_at timestamptz)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare e mcp_internal.mcp_admin_events; receipt mcp_internal.mcp_admin_requests; payload jsonb; result jsonb;
begin
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 perform mcp_internal.require_admin_permission(p_bot_id,p_client_id,'admin.update_event');
 perform mcp_internal.require_mcp_ids(p_request_id,p_execution_id);
 if p_title is null or length(btrim(p_title)) not between 1 and 200 or length(p_notes)>2000
 or p_starts_at is null or not isfinite(p_starts_at)
 or (p_ends_at is not null and (not isfinite(p_ends_at) or p_ends_at<=p_starts_at)) then
 raise exception using message='invalid_request',errcode='P0001'; end if;
 payload:=jsonb_build_object('title',p_title,'notes',p_notes,'starts_at',p_starts_at,'ends_at',p_ends_at,'event_id',p_event_id,'expected_version',p_expected_version,'status',p_status);
 perform pg_advisory_xact_lock(hashtextextended(p_bot_id||':admin:'||p_execution_id,0));
 select * into receipt from mcp_internal.mcp_admin_requests where bot_id=p_bot_id and execution_id=p_execution_id;
 if found then
   if receipt.tool is distinct from 'admin.update_event' or receipt.client_id is distinct from p_client_id or receipt.payload is distinct from payload then
     raise exception using message='idempotency_conflict',errcode='P0001'; end if;
   return receipt.result || jsonb_build_object('replayed',true);
 end if;
 select * into e from mcp_internal.mcp_admin_events where id=p_event_id and client_id=p_client_id for update;
 if not found then raise exception using message='event_not_found',errcode='P0001'; end if;
 if p_status is null or p_status not in ('scheduled','completed','cancelled') or p_expected_version is null or p_expected_version not between 1 and 2147483646
 or (e.event_type='meeting' and p_ends_at is null) then
 raise exception using message='invalid_request',errcode='P0001'; end if;
 if e.version<>p_expected_version or e.status<>'scheduled' then
 raise exception using message='event_conflict',errcode='P0001'; end if;
 update mcp_internal.mcp_admin_events set title=btrim(p_title),notes=p_notes,starts_at=p_starts_at,ends_at=p_ends_at,
 status=p_status,version=version+1,updated_at=now(),updated_by_bot=p_bot_id where id=e.id returning * into e;
 result:=jsonb_build_object('client_id',p_client_id,'event',to_jsonb(e),'replayed',false);
 insert into mcp_internal.mcp_admin_requests(bot_id,execution_id,request_id,tool,client_id,event_id,payload,result)
 values(p_bot_id,p_execution_id,p_request_id,'admin.update_event',p_client_id,e.id,payload,result);
 return result;
end $$;

create function public.mcp_admin_list_events(p_bot_id text,p_client_id uuid,p_limit integer default 25,p_after uuid default null,p_status text default null,p_due_before timestamptz default null) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$ begin
 perform mcp_internal.require_service_role();
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 return mcp_internal.admin_list_events(p_bot_id,p_client_id,p_limit,p_after,p_status,p_due_before);
end $$;
revoke all on function public.mcp_admin_list_events(text,uuid,integer,uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function mcp_internal.admin_list_events(text,uuid,integer,uuid,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.mcp_admin_list_events(text,uuid,integer,uuid,text,timestamptz) to service_role;

create function public.mcp_admin_get_event(p_bot_id text,p_client_id uuid,p_event_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$ begin
 perform mcp_internal.require_service_role();
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 return mcp_internal.admin_get_event(p_bot_id,p_client_id,p_event_id);
end $$;
revoke all on function public.mcp_admin_get_event(text,uuid,uuid) from public,anon,authenticated;
revoke all on function mcp_internal.admin_get_event(text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.mcp_admin_get_event(text,uuid,uuid) to service_role;

create function public.mcp_admin_create_event(p_bot_id text,p_client_id uuid,p_request_id text,p_execution_id text,p_event_type text,p_title text,p_notes text,p_starts_at timestamptz,p_ends_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$ begin
 perform mcp_internal.require_service_role();
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 return mcp_internal.admin_create_event(p_bot_id,p_client_id,p_request_id,p_execution_id,p_event_type,p_title,p_notes,p_starts_at,p_ends_at);
end $$;
revoke all on function public.mcp_admin_create_event(text,uuid,text,text,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function mcp_internal.admin_create_event(text,uuid,text,text,text,text,text,timestamptz,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.mcp_admin_create_event(text,uuid,text,text,text,text,text,timestamptz,timestamptz) to service_role;

create function public.mcp_admin_update_event(p_bot_id text,p_client_id uuid,p_request_id text,p_execution_id text,p_event_id uuid,p_expected_version integer,p_status text,p_title text,p_notes text,p_starts_at timestamptz,p_ends_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$ begin
 perform mcp_internal.require_service_role();
 perform mcp_internal.require_active_bot(p_bot_id);
 perform mcp_internal.require_bot_client_grant(p_bot_id,p_client_id);
 return mcp_internal.admin_update_event(p_bot_id,p_client_id,p_request_id,p_execution_id,p_event_id,p_expected_version,p_status,p_title,p_notes,p_starts_at,p_ends_at);
end $$;
revoke all on function public.mcp_admin_update_event(text,uuid,text,text,uuid,integer,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function mcp_internal.admin_update_event(text,uuid,text,text,uuid,integer,text,text,text,timestamptz,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.mcp_admin_update_event(text,uuid,text,text,uuid,integer,text,text,text,timestamptz,timestamptz) to service_role;

delete from mcp_internal.mcp_bot_permissions where bot_id='bot_admin';
insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by) values
('bot_admin','delivery.list_clients','phase-12-locked'),
('bot_admin','delivery.get_client','phase-12-locked'),
('bot_admin','delivery.get_status','phase-12-locked'),
('bot_admin','workflow.create_task','phase-12-locked'),
('bot_admin','workflow.assign_task','phase-12-locked'),
('bot_admin','workflow.get_task','phase-12-locked'),
('bot_admin','workflow.list_tasks','phase-12-locked'),
('bot_admin','workflow.complete_task','phase-12-locked'),
('bot_admin','workflow.create_approval','phase-12-locked'),
('bot_admin','workflow.get_pending_approvals','phase-12-locked'),
('bot_admin','workflow.get_activity','phase-12-locked'),
('bot_admin','admin.list_events','phase-12-locked'),
('bot_admin','admin.get_event','phase-12-locked'),
('bot_admin','admin.create_event','phase-12-locked'),
('bot_admin','admin.update_event','phase-12-locked');

-- Preserve migration 72 behavior; narrow only Admin assignment authorization.
create or replace function mcp_internal.workflow_task(p_bot_id text,p_client_id uuid,p_action text,
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
   -- Admin assignments may only coordinate with actors scoped to this client.
   -- Validate before receipt replay; all other bot behavior stays unchanged.
   if p_bot_id='bot_admin' and p_action='assign_task' then
     if p_assignee ~ '^bot_[a-z0-9_]+$' then
       perform mcp_internal.require_active_bot(p_assignee);
       perform mcp_internal.require_bot_client_grant(p_assignee,p_client_id);
     elsif p_assignee ~ '^member:[0-9a-fA-F-]{36}$' then
       perform 1 from public.team_members m join public.client_assignments a on a.member_id=m.id
       where m.id::text=substring(p_assignee from 8) and m.active and a.client_id=p_client_id and a.ended_at is null for share of m,a;
       if not found then raise exception using message='invalid_assignee',errcode='P0001'; end if;
     else raise exception using message='invalid_assignee',errcode='P0001'; end if;
   end if;
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

commit;
