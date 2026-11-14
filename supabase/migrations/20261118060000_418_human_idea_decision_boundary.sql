-- The human decision and the idea status change share one transaction.
begin;
create function public.guard_human_idea_status_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.human_idea_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 -- Trusted policy and MCP workers retain their existing attributed paths.
 if auth.role()='service_role' then return new; end if;
 if tg_op='INSERT' then
  if new.status<>'draft' and not (new.source='proof' and new.status='approved'
   and new.proof_id is not null and exists(select 1 from public.client_proof_assets p
    where p.id=new.proof_id and p.client_id=new.client_id and p.usage_rights='approved'
     and nullif(btrim(p.permission_basis),'') is not null
     and (p.expires_on is null or p.expires_on>=current_date))) then
   raise exception 'New ideas start as drafts unless cleared proof production owns them.' using errcode='42501';
  end if;
  return new;
 end if;
 if new.client_id is distinct from old.client_id then
  raise exception 'An idea cannot change client.' using errcode='42501'; end if;
 if new.approved_request_id is distinct from old.approved_request_id
  and not (old.status='draft' and new.status='approved') then
  raise exception 'Idea approval history is immutable.' using errcode='42501'; end if;
 if new.approved_content_hash is distinct from old.approved_content_hash
  and not (old.status='draft' and new.status='approved') then
  raise exception 'Idea approval hash is immutable.' using errcode='42501'; end if;
 if new.status is not distinct from old.status then return new; end if;
 if old.status='draft' and new.status='approved' then
  select * into q from public.human_idea_review_requests_v6
   where canonical_request_id=new.approved_request_id and idea_id=new.id and client_id=new.client_id;
  select * into e from public.approval_decision_events_v6
   where request_id=q.canonical_request_id order by event_order desc limit 1;
  if q.id is null or e.decision<>'approved' or e.actor_aal<>'aal2'
   or e.actor_id is distinct from auth.uid() or e.artifact_hash is distinct from q.source_hash
   or new.approved_content_hash is distinct from q.source_hash
   or public.human_idea_review_source_state_v6(q.canonical_request_id)<>'pending'
   then raise exception 'Select this exact idea in Approval Inbox.' using errcode='42501'; end if;
  return new;
 end if;
 if old.status='draft' and new.status='rejected' then
  select * into q from public.human_idea_review_requests_v6
   where idea_id=new.id order by request_epoch desc limit 1;
  select * into e from public.approval_decision_events_v6
   where request_id=q.canonical_request_id order by event_order desc limit 1;
  if q.id is null or e.decision<>'rejected' or e.actor_aal<>'aal2'
   or e.actor_id is distinct from auth.uid()
   or public.human_idea_review_source_state_v6(q.canonical_request_id)<>'pending'
   then raise exception 'Reject this exact idea in Approval Inbox.' using errcode='42501'; end if;
  return new;
 end if;
 if old.status='approved' and new.status='briefed' then
  if not (new.source='proof' and new.proof_id is not null)
   and (current_setting('aa.idea_brief_rpc',true) is distinct from new.id::text
    or not (public.human_idea_approval_current_v6(new.id)
     or exists(select 1 from public.engine_decisions d
      where d.idea_id=new.id and d.client_id=new.client_id and d.kind='idea_selected')
     or exists(select 1 from mcp_internal.mcp_content_requests m
      where m.idea_id=new.id and m.client_id=new.client_id
       and m.bot_id='bot_production' and m.tool='content.select_idea')))
   then raise exception 'A current human or policy selection is required before briefing.' using errcode='42501'; end if;
  if new.source<>'proof' and new.job_id is null then
   raise exception 'A queued brief job must be linked to this idea.' using errcode='42501'; end if;
  return new;
 end if;
 raise exception 'That idea status transition has no approved route.' using errcode='42501';
end $$;
create trigger human_idea_status_guard_v6 before insert or update on public.client_ideas
 for each row execute function public.guard_human_idea_status_v6();

create or replace function public.approve_idea_and_generate_brief(p_idea_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare i public.client_ideas%rowtype; j uuid;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null then
  raise exception 'A provisioned human must queue this brief.' using errcode='42501'; end if;
 select * into i from public.client_ideas where id=p_idea_id for update;
 if i.id is null or not public.can_access_client(i.client_id) then
  raise exception 'Idea is unavailable to this client.' using errcode='42501'; end if;
 if i.status='briefed' and i.job_id is not null then return i.job_id; end if;
 if i.status<>'approved' or i.archived_at is not null
  or exists(select 1 from public.client_briefs b where b.source_idea_id=i.id)
  then raise exception 'A current selected idea without an existing brief is required.' using errcode='23514'; end if;
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
     and (p.expires_on is null or p.expires_on>=current_date))))
  then raise exception 'The exact human or policy idea selection is missing or stale.' using errcode='42501'; end if;
 j:=public.enqueue_agent_job('brief',i.client_id,'client_ideas',i.id);
 perform set_config('aa.idea_brief_rpc',i.id::text,true);
 update public.client_ideas set status='briefed',job_id=j where id=i.id;
 perform set_config('aa.idea_brief_rpc','',true);
 return j;
end $$;

-- Editing and reverting an idea, campaign context or cited proof cannot
-- resurrect an earlier exact human decision.
create function public.invalidate_human_idea_review_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (to_jsonb(new)-array['status','job_id','created_at','updated_at',
   'approved_request_id','approved_content_hash']) is distinct from
  (to_jsonb(old)-array['status','job_id','created_at','updated_at',
   'approved_request_id','approved_content_hash']) then
  update public.human_idea_review_requests_v6 set request_token=gen_random_uuid()
   where idea_id=new.id;
 end if;
 return new;
end $$;
create trigger human_idea_review_invalidation_v6 after update on public.client_ideas
 for each row execute function public.invalidate_human_idea_review_v6();

create function public.invalidate_human_idea_campaign_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.name,new.acquisition_mode,new.offer_version_id,new.plan_approved_fingerprint)
  is distinct from (old.name,old.acquisition_mode,old.offer_version_id,old.plan_approved_fingerprint) then
  update public.human_idea_review_requests_v6 q set request_token=gen_random_uuid()
   where exists(select 1 from public.client_ideas i
    where i.id=q.idea_id and i.campaign_id=new.id);
 end if;
 return new;
end $$;
create trigger human_idea_campaign_invalidation_v6 after update on public.client_campaigns
 for each row execute function public.invalidate_human_idea_campaign_v6();

create function public.invalidate_human_idea_proof_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
 if tg_op='DELETE' then v_id:=old.id; else v_id:=new.id; end if;
 update public.human_idea_review_requests_v6 q set request_token=gen_random_uuid()
  where exists(select 1 from public.client_ideas i where i.id=q.idea_id and i.proof_id=v_id);
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger human_idea_proof_invalidation_v6 before update of usage_rights,permission_basis,expires_on or delete
 on public.client_proof_assets for each row execute function public.invalidate_human_idea_proof_v6();

revoke all on function public.guard_human_idea_status_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_human_idea_review_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_human_idea_campaign_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_human_idea_proof_v6() from public,anon,authenticated,service_role;
revoke all on function public.approve_idea_and_generate_brief(uuid) from public,anon,service_role;
grant execute on function public.approve_idea_and_generate_brief(uuid) to authenticated;
select public.lock_down_definer_functions();
commit;
