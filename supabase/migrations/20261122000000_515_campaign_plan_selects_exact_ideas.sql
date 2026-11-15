-- A human plan approval selects the exact saved idea batch for internal
-- production. A changed idea invalidates the plan fingerprint and brief gate.
begin;

alter table public.client_campaigns
  add column planned_idea_epoch bigint not null default 0 check (planned_idea_epoch>=0);

create function public.advance_campaign_planned_idea_epoch_v7()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare old_campaign uuid; new_campaign uuid;
begin
  if tg_op<>'INSERT' then old_campaign:=old.campaign_id; end if;
  if tg_op<>'DELETE' then new_campaign:=new.campaign_id; end if;
  if tg_op='UPDATE' and new_campaign is not distinct from old_campaign and
    (to_jsonb(new)-array['status','job_id','created_at','updated_at',
      'approved_request_id','approved_content_hash']) is not distinct from
    (to_jsonb(old)-array['status','job_id','created_at','updated_at',
      'approved_request_id','approved_content_hash']) then return new; end if;
  update public.client_campaigns set planned_idea_epoch=planned_idea_epoch+1
    where id=old_campaign;
  if new_campaign is distinct from old_campaign then
    update public.client_campaigns set planned_idea_epoch=planned_idea_epoch+1
      where id=new_campaign;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger campaign_planned_idea_epoch_v7
  after insert or update or delete on public.client_ideas
  for each row execute function public.advance_campaign_planned_idea_epoch_v7();

create function public.campaign_planned_idea_hash_v7(p_campaign_id uuid)
returns text language sql stable security invoker set search_path=pg_catalog,public as $$
  select md5(coalesce((select jsonb_agg(
    to_jsonb(i)-array['status','job_id','created_at','updated_at',
      'approved_request_id','approved_content_hash'] order by i.campaign_position)::text
    from public.client_ideas i where i.campaign_id=p_campaign_id),'[]'))
$$;

create function public.campaign_planned_ideas_match_spec_v7(p_campaign_id uuid)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype; s public.campaign_content_spec_versions_v7%rowtype;
begin
  select * into c from public.client_campaigns where id=p_campaign_id;
  if c.id is null or c.content_spec_id is null or c.content_spec_hash is null
    or c.content_ideas_generated_at is null then return false; end if;
  select * into s from public.campaign_content_spec_versions_v7 where id=c.content_spec_id;
  if s.id is null or s.campaign_id<>c.id or s.client_id<>c.client_id
    or s.content_hash<>c.content_spec_hash
    or jsonb_array_length(s.pieces)<>c.content_count
    or (select count(*) from public.client_ideas i where i.campaign_id=c.id)<>c.content_count
    then return false; end if;
  return not exists(
    select 1 from jsonb_array_elements(s.pieces) with ordinality p(piece,pos)
    left join public.client_ideas i on i.campaign_id=c.id and i.client_id=c.client_id
      and i.campaign_position=p.pos
    where i.id is null or i.archived_at is not null
      or i.media_type::text is distinct from (p.piece->>'media_type')
      or i.content_format::text is distinct from (p.piece->>'content_format')
      or i.acquisition_route is distinct from (p.piece->>'route')
      or (p.piece->>'platform'<>'google_ads' and
        i.target_platform::text is distinct from (p.piece->>'platform'))
      or (p.piece->>'platform'='google_ads' and i.target_platform is not null));
end $$;

create function public.campaign_planned_idea_selection_current_v7(p_idea_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare i public.client_ideas%rowtype; c public.client_campaigns%rowtype;
begin
  select * into i from public.client_ideas where id=p_idea_id;
  if i.id is null or i.campaign_id is null or i.archived_at is not null then return false; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not public.can_access_client(i.client_id))
    then return false; end if;
  select * into c from public.client_campaigns where id=i.campaign_id and client_id=i.client_id;
  return c.id is not null and c.content_spec_id is not null
    and c.plan_approved_at is not null and c.plan_approved_by is not null
    and c.plan_approved_fingerprint=public.campaign_plan_fingerprint(c)
    and public.campaign_planned_ideas_match_spec_v7(c.id);
end $$;

create or replace function public.campaign_plan_fingerprint(p_campaign public.client_campaigns)
returns text language sql stable set search_path=pg_catalog,public as $$
  select md5((jsonb_build_object(
    'objective', p_campaign.objective,
    'audience', p_campaign.audience,
    'offer_summary', p_campaign.offer_summary,
    'core_message', p_campaign.core_message,
    'channels', to_jsonb(coalesce(p_campaign.channels, array[]::text[])),
    'budget', p_campaign.budget,
    'starts_on', p_campaign.starts_on,
    'ends_on', p_campaign.ends_on,
    'kpi_metric', p_campaign.kpi_metric,
    'kpi_target', p_campaign.kpi_target,
    'content_count', p_campaign.content_count,
    'organic_content_count', p_campaign.organic_content_count,
    'paid_content_count', p_campaign.paid_content_count,
    'needs_landing_page', p_campaign.needs_landing_page,
    'needs_sales_agent', p_campaign.needs_sales_agent,
    'offer_version_id', p_campaign.offer_version_id)
    || case when p_campaign.content_spec_hash is null then '{}'::jsonb
      else jsonb_build_object('content_spec_hash',p_campaign.content_spec_hash) end
    || case when p_campaign.content_spec_id is not null
      and p_campaign.content_ideas_generated_at is not null
      then jsonb_build_object('planned_ideas_hash',public.campaign_planned_idea_hash_v7(p_campaign.id),
        'planned_idea_epoch',p_campaign.planned_idea_epoch)
      else '{}'::jsonb end)::text)
$$;

create or replace function public.approve_campaign_plan_v6(p_campaign_id uuid,p_note text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype; v_fingerprint text;
begin
  select * into c from public.client_campaigns where id=p_campaign_id for update;
  if c.id is null then raise exception 'That campaign no longer exists.' using errcode='P0001'; end if;
  if auth.role()<>'authenticated' or not public.can_access_client(c.client_id) then
    raise exception 'Only a person with access to this client can approve its plan.' using errcode='P0001'; end if;
  if c.built_at is null then
    raise exception 'This campaign has no plan yet. There is nothing to approve.' using errcode='P0001'; end if;
  if c.acquisition_mode<>'legacy' and c.content_count>0 and (c.content_spec_id is null
    or c.content_spec_hash is null or not exists(
      select 1 from public.campaign_content_spec_versions_v7 s
      where s.id=c.content_spec_id and s.campaign_id=c.id and s.client_id=c.client_id
        and s.content_hash=c.content_spec_hash)) then
    raise exception 'Review a complete route and format specification before approving this plan.'
      using errcode='23514'; end if;
  if c.content_spec_id is not null and c.content_ideas_generated_at is not null
    and not public.campaign_planned_ideas_match_spec_v7(c.id) then
    raise exception 'Saved campaign ideas no longer match the reviewed plan.' using errcode='23514'; end if;
  v_fingerprint:=public.campaign_plan_fingerprint(c);
  if c.plan_approved_at is not null and c.plan_approved_fingerprint=v_fingerprint then
    raise exception 'This exact plan is already approved.' using errcode='P0001'; end if;
  update public.client_campaigns set plan_approved_at=now(),plan_approved_by=auth.uid(),
    plan_approved_fingerprint=v_fingerprint,plan_review_note=nullif(btrim(p_note),''),
    updated_at=now() where id=c.id;
  if c.content_spec_id is not null and c.content_ideas_generated_at is not null then
    update public.client_ideas set status='approved'
      where campaign_id=c.id and client_id=c.client_id and status='draft';
  end if;
end $$;

create or replace function public.guard_human_idea_status_v6()
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
  if public.campaign_planned_idea_selection_current_v7(new.id) then return new; end if;
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
    or not (public.campaign_planned_idea_selection_current_v7(new.id)
     or public.human_idea_approval_current_v6(new.id)
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
 if not (public.campaign_planned_idea_selection_current_v7(i.id)
  or public.human_idea_approval_current_v6(i.id)
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

create or replace function public.guard_brief_job_selection_v6()
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
 if not (public.campaign_planned_idea_selection_current_v7(i.id)
  or public.human_idea_approval_current_v6(i.id)
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

create or replace function public.brief_job_selection_current_v6(p_job_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare j public.agent_jobs%rowtype; i public.client_ideas%rowtype;
begin
 select * into j from public.agent_jobs where id=p_job_id;
 if j.id is null or j.agent_key<>'brief' or j.input_table<>'client_ideas'
  or j.input_id is null or j.client_id is null then return false; end if;
 select * into i from public.client_ideas where id=j.input_id and client_id=j.client_id;
 if i.id is null or i.status not in ('approved','briefed') or i.archived_at is not null
  then return false; end if;
 return public.campaign_planned_idea_selection_current_v7(i.id)
  or public.human_idea_approval_current_v6(i.id)
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

revoke all on function public.campaign_planned_idea_hash_v7(uuid),
  public.campaign_planned_ideas_match_spec_v7(uuid),
  public.campaign_planned_idea_selection_current_v7(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.campaign_planned_idea_hash_v7(uuid),
  public.campaign_planned_ideas_match_spec_v7(uuid),
  public.campaign_planned_idea_selection_current_v7(uuid)
  to authenticated,service_role;
revoke all on function public.advance_campaign_planned_idea_epoch_v7()
  from public,anon,authenticated,service_role;
-- Keep the existing human decision and service-only gate grants unchanged.
commit;
