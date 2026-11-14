-- A queued job is not authority to write a brief after its idea changes.
begin;
create function public.brief_job_selection_current_v6(p_job_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare j public.agent_jobs%rowtype; i public.client_ideas%rowtype;
begin
 select * into j from public.agent_jobs where id=p_job_id;
 if j.id is null or j.agent_key<>'brief' or j.input_table<>'client_ideas'
  or j.input_id is null or j.client_id is null then return false; end if;
 select * into i from public.client_ideas where id=j.input_id and client_id=j.client_id;
 if i.id is null or i.status not in ('approved','briefed') or i.archived_at is not null
  then return false; end if;
 return public.human_idea_approval_current_v6(i.id)
  or exists(select 1 from public.engine_decisions d
   where d.idea_id=i.id and d.client_id=i.client_id and d.kind='idea_selected')
  or exists(select 1 from mcp_internal.mcp_content_requests m
   where m.idea_id=i.id and m.client_id=i.client_id
    and m.bot_id='bot_production' and m.tool='content.select_idea')
  or (i.source='proof' and i.proof_id is not null
   and exists(select 1 from public.client_proof_assets p
    where p.id=i.proof_id and p.client_id=i.client_id and p.usage_rights='approved'
     and nullif(btrim(p.permission_basis),'') is not null
     and (p.expires_on is null or p.expires_on>=current_date)));
end $$;

create function public.guard_brief_output_selection_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.agent_jobs%rowtype;
begin
 if new.job_id is null or new.source_idea_id is null then return new; end if;
 select * into j from public.agent_jobs where id=new.job_id;
 if j.id is null or j.agent_key<>'brief' or j.input_table<>'client_ideas'
  or j.input_id is distinct from new.source_idea_id
  or j.client_id is distinct from new.client_id
  or not public.brief_job_selection_current_v6(j.id) then
  raise exception 'Brief output is held: the selected idea or client is stale.'
   using errcode='42501'; end if;
 return new;
end $$;
create trigger brief_output_selection_guard_v6 before insert or update of source_idea_id,job_id,client_id
 on public.client_briefs for each row execute function public.guard_brief_output_selection_v6();

revoke all on function public.brief_job_selection_current_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.brief_job_selection_current_v6(uuid) to service_role;
revoke all on function public.guard_brief_output_selection_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
