-- Only a source-owned, AAL2 Inbox decision may move a validated opportunity
-- to approved. Campaign links recheck that exact decision at use time.
begin;
create function public.opportunity_proof_ready_v6(p_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select not exists (
    select 1 from public.opportunity_proof_requirements q
    left join public.client_proof_assets p on p.id = q.proof_id
      and p.client_id = q.client_id
    where q.opportunity_id = p_id
      and (q.proof_id is null or p.id is null or p.usage_rights <> 'approved'
        or (p.expires_on is not null and p.expires_on < current_date))
  );
$$;
create or replace function public.opportunity_approval_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  o public.market_opportunities%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id = p_request_id;
  if r.id is null then return 'unverified'; end if;
  if r.source_system is distinct from 'aa_console' then return 'unverified'; end if;
  if r.source_kind is distinct from 'opportunity_approve' then return 'unverified'; end if;
  if r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into o from public.market_opportunities
    where id = r.source_id::uuid and client_id = r.client_id;
  if o.id is null then return 'cancelled'; end if;
  h := public.opportunity_approval_hash_v6(o.id);
  if o.approval_request_token is null or r.source_version is distinct from
    h || ':' || o.approval_request_token::text or r.artifact_hash is distinct from h
    or r.preview is distinct from public.opportunity_approval_preview_v6(o.id)
    or r.scope is distinct from public.opportunity_approval_scope_v6(o.id)
    or r.destination is distinct from 'campaign_factory:opportunity:' || o.id::text
    then return 'superseded'; end if;
  if o.status in ('approved','active','learning','scaling')
    and o.approved_request_id = r.id and o.approved_content_hash = h
    and public.opportunity_proof_ready_v6(o.id)
    then return 'source_decided'; end if;
  if o.status <> 'validated' or exists (select 1 from public.opportunity_readiness ready
      where ready.opportunity_id = o.id and ready.blocker is not null)
    or not public.opportunity_proof_ready_v6(o.id)
    then return 'source_held'; end if;
  return 'pending';
end $$;

create function public.opportunity_approval_current_v6(p_id uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare o public.market_opportunities%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if auth.role() not in ('authenticated','service_role') then return false; end if;
  select * into o from public.market_opportunities where id = p_id;
  if not found or o.status not in ('approved','active','learning','scaling')
    or o.approved_request_id is null then return false; end if;
  if auth.role() = 'authenticated' and not public.can_access_client(o.client_id)
    then return false; end if;
  h := public.opportunity_approval_hash_v6(o.id);
  select * into r from public.approval_requests_v6 where id = o.approved_request_id
    and client_id = o.client_id and source_system = 'aa_console'
    and source_kind = 'opportunity_approve' and source_id = o.id::text
    and source_version = h || ':' || o.approval_request_token::text
    and artifact_hash = h;
  if not found or o.approved_content_hash is distinct from h
    or public.opportunity_approval_source_state_v6(r.id) <> 'source_decided'
    then return false; end if;
  select * into d from public.approval_decision_events_v6
    where request_id = r.id order by event_order desc limit 1;
  return d.decision = 'approved' and d.actor_aal = 'aal2'
    and d.artifact_hash = h
    and d.source_decision_ref = 'opportunity_approve:' || o.id::text ||
      ':' || o.approval_request_token::text
    and exists (select 1 from public.approval_inbox_v6 i where i.id = r.id
      and i.status = 'approved' and i.preview_blocker is null);
end $$;

create function public.guard_opportunity_approval_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'discovered' or new.approved_request_id is not null
      or new.approved_content_hash is not null or new.approval_request_token is not null then
      raise exception 'A new opportunity cannot carry an approval.' using errcode = '23514'; end if;
    return new;
  end if;
  -- A protective pause or rejection ends eligibility immediately. Preserve
  -- the old Inbox event as history, then require a fresh request after review.
  if old.approved_request_id is not null
    and old.status in ('approved','active','learning','scaling')
    and new.status in ('paused','rejected') then
    new.approved_request_id := null;
    new.approved_content_hash := null;
    new.approval_request_token := null;
    return new;
  end if;
  if old.status <> 'approved' and new.status = 'approved' then
    if old.status <> 'validated' or auth.role() <> 'authenticated'
      or coalesce(auth.jwt()->>'aal','') <> 'aal2'
      or new.approved_request_id is null or new.approval_request_token is null then
      raise exception 'Review this exact opportunity in Approval Inbox first.' using errcode = '42501'; end if;
    h := public.opportunity_approval_hash_v6(old.id);
    select * into r from public.approval_requests_v6 where id = new.approved_request_id
      and client_id = old.client_id and source_kind = 'opportunity_approve'
      and source_id = old.id::text
      and source_version = h || ':' || old.approval_request_token::text
      and artifact_hash = h;
    select * into d from public.approval_decision_events_v6
      where request_id = r.id order by event_order desc limit 1;
    if r.id is null or new.approved_content_hash is distinct from h
      or new.approval_request_token is distinct from old.approval_request_token
      or d.decision is distinct from 'approved' or d.actor_id is distinct from auth.uid()
      or d.actor_aal <> 'aal2' or d.artifact_hash is distinct from h
      or d.source_decision_ref is distinct from 'opportunity_approve:' || old.id::text ||
        ':' || old.approval_request_token::text
      or public.opportunity_approval_source_state_v6(r.id) <> 'pending'
      or not exists (select 1 from public.approval_inbox_v6 i where i.id = r.id
        and i.status = 'approved' and i.preview_blocker is null) then
      raise exception 'The exact opportunity decision is unavailable.' using errcode = '23514'; end if;
  elsif (new.approved_request_id,new.approved_content_hash) is distinct from
      (old.approved_request_id,old.approved_content_hash) then
    raise exception 'Opportunity approval signatures are source-owned.' using errcode = '23514';
  elsif old.approved_request_id is not null and
    new.approval_request_token is distinct from old.approval_request_token then
    raise exception 'An approved request token is immutable.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger opportunity_approval_guard_v6 before insert or update
  on public.market_opportunities for each row
  execute function public.guard_opportunity_approval_v6();

create function public.approve_opportunity_v6(p_opportunity_id uuid,p_request_id uuid)
returns public.market_opportunities language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare o public.market_opportunities%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 human must approve this opportunity.' using errcode = '42501'; end if;
  select * into o from public.market_opportunities where id = p_opportunity_id for update;
  if not found or not public.can_shape_opportunity(o.client_id) then
    raise exception 'The opportunity or its decision owner is unavailable.' using errcode = '42501'; end if;
  h := public.opportunity_approval_hash_v6(o.id);
  select * into r from public.approval_requests_v6 where id = p_request_id
    and client_id = o.client_id and source_system = 'aa_console'
    and source_kind = 'opportunity_approve' and source_id = o.id::text
    and source_version = h || ':' || o.approval_request_token::text
    and artifact_hash = h;
  if not found or public.opportunity_approval_source_state_v6(r.id) <> 'pending'
    or not exists (select 1 from public.approval_inbox_v6 i where i.id = r.id
      and i.status = 'pending' and i.preview_blocker is null) then
    raise exception 'Review the current opportunity in Approval Inbox.' using errcode = '23514'; end if;
  perform public.record_approval_decision_v6(r.id,'approved',h,
    'opportunity_approve:' || o.id::text || ':' || o.approval_request_token::text);
  update public.market_opportunities set status = 'approved',
    approved_request_id = r.id, approved_content_hash = h
    where id = o.id returning * into o;
  insert into public.opportunity_events(opportunity_id,client_id,event,actor,detail)
    values (o.id,o.client_id,'status_changed','human','approved via exact Inbox request ' || r.id::text);
  return o;
end $$;

create function public.reject_opportunity_approval_v6(
  p_opportunity_id uuid,p_request_id uuid,p_reason text)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare o public.market_opportunities%rowtype;
  r public.approval_requests_v6%rowtype;
  h text;
begin
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A rejection reason is required.' using errcode = '22023'; end if;
  select * into o from public.market_opportunities where id = p_opportunity_id for update;
  if not found then raise exception 'Opportunity not found.' using errcode = '23514'; end if;
  h := public.opportunity_approval_hash_v6(o.id);
  select * into r from public.approval_requests_v6 where id = p_request_id
    and client_id = o.client_id and source_kind = 'opportunity_approve'
    and source_id = o.id::text and source_version = h || ':' || o.approval_request_token::text;
  if not found or public.opportunity_approval_source_state_v6(r.id)
    not in ('pending','source_held') then
    raise exception 'This opportunity is no longer reviewable.' using errcode = '23514'; end if;
  return public.record_approval_decision_v6(r.id,'rejected',h,
    'opportunity_rejection:' || o.id::text || ':' || o.approval_request_token::text,p_reason);
end $$;

create function public.guard_campaign_opportunity_approval_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.role = 'campaign' and (tg_op = 'INSERT' or new.opportunity_id is distinct from old.opportunity_id
    or new.campaign_id is distinct from old.campaign_id)
    and not public.opportunity_approval_current_v6(new.opportunity_id) then
    raise exception 'A campaign needs the current exact opportunity approval.' using errcode = '23514'; end if;
  return new;
end $$;
create trigger campaign_opportunity_approval_guard_v6
  before insert or update on public.opportunity_links for each row
  execute function public.guard_campaign_opportunity_approval_v6();

revoke all on function public.opportunity_approval_current_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.opportunity_approval_current_v6(uuid) to authenticated,service_role;
revoke all on function public.opportunity_proof_ready_v6(uuid) from public,anon,authenticated,service_role;
revoke all on function public.guard_opportunity_approval_v6() from public,anon,authenticated,service_role;
revoke all on function public.guard_campaign_opportunity_approval_v6() from public,anon,authenticated,service_role;
revoke all on function public.approve_opportunity_v6(uuid,uuid) from public,anon,service_role;
grant execute on function public.approve_opportunity_v6(uuid,uuid) to authenticated;
revoke all on function public.reject_opportunity_approval_v6(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.reject_opportunity_approval_v6(uuid,uuid,text) to authenticated;
select public.lock_down_definer_functions();
commit;
