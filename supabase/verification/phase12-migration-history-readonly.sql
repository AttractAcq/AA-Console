-- Read-only metadata probe. No stored migration statements, function bodies,
-- application records, credentials, or connection settings are returned.
-- Run only against the intended project using an already authorized connection.
begin read only;
select version, count(*) as recorded_rows
from supabase_migrations.schema_migrations
where version >= '20260909000000'
group by version order by version;

with expected(name) as (values
 ('public.client_campaigns'), ('public.campaign_artifacts'),
 ('mcp_internal.mcp_delivery_tasks'), ('mcp_internal.mcp_task_mutations'))
select e.name, c.oid is not null as present,
 c.relrowsecurity as rls, c.relforcerowsecurity as force_rls
from expected e left join pg_class c on c.oid=to_regclass(e.name)
order by e.name;

select table_schema,table_name,column_name
from information_schema.columns
where table_schema='mcp_internal' and table_name='mcp_delivery_tasks'
 and column_name in ('assignee','completed_at') order by column_name;

select schemaname,tablename,policyname,roles,cmd
from pg_policies where schemaname='public'
 and tablename in ('client_campaigns','campaign_artifacts')
order by tablename,policyname;

select schemaname,tablename,indexname
from pg_indexes where schemaname='public'
 and tablename in ('client_campaigns','campaign_artifacts')
order by tablename,indexname;

with expected(signature) as (values
 ('public.campaign_readiness(uuid)'),
 ('public.provision_campaign(uuid)'),
 ('public.launch_campaign(uuid)'),
 ('public.mcp_workflow_task(text,uuid,text,uuid,text,text,text,integer,uuid,text,text)'),
 ('mcp_internal.workflow_task(text,uuid,text,uuid,text,text,text,integer,uuid,text,text)'),
 ('public.mcp_campaign_read(text,uuid,text,uuid,integer,uuid,date,date)'),
 ('mcp_internal.campaign_read(text,uuid,text,uuid,integer,uuid,date,date)'),
 ('mcp_internal.delivery_read(text,uuid,text)'))
select e.signature,p.oid is not null as present,p.prosecdef as security_definer,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_execute,
 exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
from expected e left join pg_proc p on p.oid=to_regprocedure(e.signature)
order by e.signature;

select exists(select 1 from public.agents where agent_key='campaign_plan') as campaign_planner_registered;
rollback;
