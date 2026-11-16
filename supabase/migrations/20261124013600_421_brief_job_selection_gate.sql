-- All brief-job entry points, including the MCP gateway and Engine tick,
-- must carry an actual current human, policy or cleared-proof selection.
begin;
create function public.guard_brief_job_selection_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare i public.client_ideas%rowtype;
begin
 if new.agent_key<>'brief' or new.input_table is distinct from 'client_ideas' then
  return new; end if;
 select * into i from public.client_ideas where id=new.input_id for share;
 if i.id is null or i.client_id is distinct from new.client_id
  or i.status<>'approved' or i.archived_at is not null then
  raise exception 'A current approved idea for the same client is required before a brief job.'
   using errcode='42501'; end if;
 if not (public.human_idea_approval_current_v6(i.id)
  or exists(select 1 from public.engine_decisions d
   where d.idea_id=i.id and d.client_id=i.client_id and d.kind='idea_selected')
  or exists(select 1 from mcp_internal.mcp_content_requests m
   where m.idea_id=i.id and m.client_id=i.client_id
    and m.bot_id='bot_production' and m.tool='content.select_idea')
  or (i.source='proof' and i.proof_id is not null
   and exists(select 1 from public.client_proof_assets p
    where p.id=i.proof_id and p.client_id=i.client_id and p.usage_rights='approved'
     and nullif(btrim(p.permission_basis),'') is not null
     and (p.expires_on is null or p.expires_on>=current_date)))) then
  raise exception 'The idea selection is missing or stale; brief job held.'
   using errcode='42501'; end if;
 return new;
end $$;
create trigger brief_job_selection_guard_v6 before insert on public.agent_jobs
 for each row execute function public.guard_brief_job_selection_v6();
revoke all on function public.guard_brief_job_selection_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
