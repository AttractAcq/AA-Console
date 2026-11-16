-- The owning sales-agent RPC records the AAL2 decision and signature together.
begin;
create function public.sales_agent_public_use_current_v6(p_agent_id uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare a public.client_sales_agents%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if auth.role() is distinct from 'service_role' and
    auth.role() is distinct from 'authenticated' then return false; end if;
  select * into a from public.client_sales_agents where id = p_agent_id;
  if not found or a.approved_at is null or a.status <> 'live'
    or a.built_at is null or a.archived_at is not null then return false; end if;
  if a.page_id is null or not exists (select 1 from public.client_pages p
    where p.id = a.page_id and p.client_id = a.client_id) then return false; end if;
  if auth.role() = 'authenticated' and not public.can_access_client(a.client_id)
    then return false; end if;
  -- Pre-bridge signed agents are explicitly legacy; the transition guard
  -- prevents any newly signed row from entering this branch.
  if a.approved_request_id is null then return a.approved_by is not null; end if;
  h := public.sales_agent_public_hash_v6(a);
  select * into r from public.approval_requests_v6 where id = a.approved_request_id
    and client_id = a.client_id and source_kind = 'sales_agent_public_use'
    and source_id = a.id::text and artifact_hash = h
    and source_version = h || ':' || a.public_use_request_token::text;
  if not found or a.approved_content_hash is distinct from h
    or public.sales_agent_public_source_state_v6(r.id) <> 'source_decided'
    then return false; end if;
  select * into d from public.approval_decision_events_v6
    where request_id = r.id order by event_order desc limit 1;
  return d.decision = 'approved' and d.actor_aal = 'aal2'
    and d.actor_id = a.approved_by and d.artifact_hash = h
    and d.source_decision_ref = 'sales_agent_public_use:' || a.id::text ||
      ':approved:' || a.public_use_request_token::text
    and exists (select 1 from public.approval_inbox_v6 i where i.id = r.id
      and i.status = 'approved' and i.preview_blocker is null);
end $$;
create function public.guard_sales_agent_public_use_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare changed boolean;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if tg_op = 'INSERT' then
    if new.approved_at is not null or new.approved_by is not null
      or new.approved_request_id is not null or new.approved_content_hash is not null
      or new.public_use_request_token is not null then
      raise exception 'A new sales agent cannot carry a public-use signature.'
        using errcode = '23514';
    end if;
    return new;
  end if;
  changed := jsonb_build_array(new.name,new.purpose,new.role,new.page_id,
    new.status,new.greeting,new.system_prompt,new.qualification,new.objections,
    new.booking_rule,new.escalation_rule,new.guardrails,new.built_at,new.archived_at)
    is distinct from jsonb_build_array(old.name,old.purpose,old.role,old.page_id,
    old.status,old.greeting,old.system_prompt,old.qualification,old.objections,
    old.booking_rule,old.escalation_rule,old.guardrails,old.built_at,old.archived_at);
  if changed then
    new.approved_at := null;
    new.approved_by := null;
    new.approved_request_id := null;
    new.approved_content_hash := null;
    new.public_use_request_token := null;
    return new;
  end if;
  if old.approved_at is null and new.approved_at is not null then
    if auth.role() is distinct from 'authenticated' or auth.uid() is null
      or public.current_role_of() is null
      or coalesce(auth.jwt()->>'aal','') <> 'aal2'
      or not (coalesce(public.is_admin(),false)
        or coalesce(auth.uid() = public.active_video_approval_manager(new.client_id),false))
      or new.approved_by is distinct from auth.uid()
      or new.approved_request_id is null
      or new.public_use_request_token is null then
      raise exception 'An exact AAL2 Inbox decision must approve public use.'
        using errcode = '42501';
    end if;
    h := public.sales_agent_public_hash_v6(new);
    select * into r from public.approval_requests_v6
      where id = new.approved_request_id and client_id = new.client_id
        and source_system = 'aa_console' and source_kind = 'sales_agent_public_use'
        and source_id = new.id::text
        and source_version = h || ':' || new.public_use_request_token::text
        and artifact_hash = h;
    select * into d from public.approval_decision_events_v6
      where request_id = r.id order by event_order desc limit 1;
    if r.id is null or d.decision is distinct from 'approved'
      or d.actor_id is distinct from auth.uid() or d.actor_aal <> 'aal2'
      or d.artifact_hash is distinct from h
      or d.source_decision_ref is distinct from
        'sales_agent_public_use:' || new.id::text || ':approved:' ||
        new.public_use_request_token::text
      or new.approved_content_hash is distinct from h
      or public.sales_agent_public_source_state_v6(r.id) <> 'pending'
      or not exists (select 1 from public.approval_inbox_v6 i
        where i.id = r.id and i.status = 'approved' and i.preview_blocker is null) then
      raise exception 'The signature differs from the current exact Inbox decision.'
        using errcode = '23514';
    end if;
  elsif old.approved_at is not null and new.approved_at is null then
    if auth.role() is distinct from 'authenticated' or auth.uid() is null
      or public.current_role_of() is null
      or coalesce(auth.jwt()->>'aal','') <> 'aal2'
      or not (coalesce(public.is_admin(),false)
        or coalesce(auth.uid() = public.active_video_approval_manager(old.client_id),false)) then
      raise exception 'A provisioned AAL2 owner must revoke public use.'
        using errcode = '42501';
    end if;
    if old.approved_request_id is not null then
      select * into d from public.approval_decision_events_v6
        where request_id = old.approved_request_id order by event_order desc limit 1;
      if d.decision is distinct from 'revoked' or d.actor_id is distinct from auth.uid()
        or d.actor_aal <> 'aal2' or
        d.source_decision_ref is distinct from
          'sales_agent_public_use:' || old.id::text || ':revoked:' ||
          old.public_use_request_token::text then
        raise exception 'The exact public-use decision has not been revoked.'
          using errcode = '23514';
      end if;
    end if;
    new.approved_by := null;
    new.approved_request_id := null;
    new.approved_content_hash := null;
    new.public_use_request_token := null;
  elsif (new.approved_at,new.approved_by,new.approved_request_id,
    new.approved_content_hash) is distinct from
    (old.approved_at,old.approved_by,old.approved_request_id,
    old.approved_content_hash) then
    raise exception 'Public-use signature fields cannot be edited directly.'
      using errcode = '23514';
  elsif old.approved_at is not null and
    new.public_use_request_token is distinct from old.public_use_request_token then
    raise exception 'The approved request token is immutable.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger sales_agent_public_use_guard_v6
  before insert or update on public.client_sales_agents
  for each row execute function public.guard_sales_agent_public_use_v6();

create function public.approve_sales_agent_public_use_v6(p_agent_id uuid,p_request_id uuid)
returns public.client_sales_agents language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare a public.client_sales_agents%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 human must approve public use.'
      using errcode = '42501';
  end if;
  select * into a from public.client_sales_agents where id = p_agent_id for update;
  if not found or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(a.client_id),false)) then
    raise exception 'The agent or its decision owner is unavailable.' using errcode = '42501';
  end if;
  h := public.sales_agent_public_hash_v6(a);
  select * into r from public.approval_requests_v6
    where id = p_request_id and source_system = 'aa_console'
      and source_kind = 'sales_agent_public_use' and source_id = a.id::text
      and client_id = a.client_id and artifact_hash = h
      and source_version = h || ':' || a.public_use_request_token::text;
  if not found or a.approved_at is not null
    or public.sales_agent_public_source_state_v6(r.id) <> 'pending'
    or not exists (select 1 from public.approval_inbox_v6 i
      where i.id = r.id and i.status = 'pending' and i.preview_blocker is null) then
    raise exception 'Review the current exact agent in Approval Inbox.'
      using errcode = '23514';
  end if;
  perform public.record_approval_decision_v6(r.id,'approved',h,
    'sales_agent_public_use:' || a.id::text || ':approved:' ||
    a.public_use_request_token::text);
  update public.client_sales_agents set approved_at = now(), approved_by = auth.uid(),
    approved_request_id = r.id, approved_content_hash = h
    where id = a.id returning * into a;
  return a;
end $$;

create function public.reject_sales_agent_public_use_v6(
  p_agent_id uuid,p_request_id uuid,p_reason text)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare a public.client_sales_agents%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A rejection reason is required.' using errcode = '22023'; end if;
  select * into a from public.client_sales_agents where id = p_agent_id for update;
  h := public.sales_agent_public_hash_v6(a);
  select * into r from public.approval_requests_v6
    where id = p_request_id and source_kind = 'sales_agent_public_use'
      and source_id = a.id::text and client_id = a.client_id
      and artifact_hash = h and source_version =
        h || ':' || a.public_use_request_token::text;
  if not found or public.sales_agent_public_source_state_v6(r.id)
    not in ('pending','source_held') then
    raise exception 'This agent is no longer reviewable.' using errcode = '23514'; end if;
  return public.record_approval_decision_v6(r.id,'rejected',h,
    'sales_agent_public_use:' || a.id::text || ':rejected:' ||
    a.public_use_request_token::text,p_reason);
end $$;

create function public.revoke_sales_agent_public_use_v6(
  p_agent_id uuid,p_reason text)
returns public.client_sales_agents language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare a public.client_sales_agents%rowtype;
  h text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2'
    or nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A provisioned AAL2 owner and reason are required.'
      using errcode = '42501';
  end if;
  select * into a from public.client_sales_agents where id = p_agent_id for update;
  if not found or a.approved_at is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(a.client_id),false)) then
    raise exception 'The approved agent or its decision owner is unavailable.'
      using errcode = '42501';
  end if;
  if a.approved_request_id is not null then
    h := public.sales_agent_public_hash_v6(a);
    if not public.sales_agent_public_use_current_v6(a.id) then
      raise exception 'The exact public-use decision is no longer current.'
        using errcode = '23514'; end if;
    perform public.record_approval_decision_v6(a.approved_request_id,'revoked',h,
      'sales_agent_public_use:' || a.id::text || ':revoked:' ||
      a.public_use_request_token::text,p_reason);
  end if;
  update public.client_sales_agents set approved_at = null, approved_by = null,
    approved_request_id = null, approved_content_hash = null,
    public_use_request_token = null where id = a.id returning * into a;
  return a;
end $$;

revoke all on function public.guard_sales_agent_public_use_v6()
  from public,anon,authenticated,service_role;
revoke all on function public.sales_agent_public_use_current_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.sales_agent_public_use_current_v6(uuid)
  to authenticated,service_role;
revoke all on function public.approve_sales_agent_public_use_v6(uuid,uuid)
  from public,anon,service_role;
grant execute on function public.approve_sales_agent_public_use_v6(uuid,uuid)
  to authenticated;
revoke all on function public.reject_sales_agent_public_use_v6(uuid,uuid,text)
  from public,anon,service_role;
grant execute on function public.reject_sales_agent_public_use_v6(uuid,uuid,text)
  to authenticated;
revoke all on function public.revoke_sales_agent_public_use_v6(uuid,text)
  from public,anon,service_role;
grant execute on function public.revoke_sales_agent_public_use_v6(uuid,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;
