-- B008: make the B005 sales-entitlement Inbox placeholder a real, exact-scope
-- human decision. This migration deliberately leaves inbox_enforced=false.

alter table public.client_sales_entitlement_requests
  add column client_name_snapshot text,
  add column member_name_snapshot text;

-- Freeze readable names once, alongside the immutable client/member/user
-- identifiers. A later rename cannot change what a reviewer saw.
update public.client_sales_entitlement_requests r
   set client_name_snapshot = c.name,
       member_name_snapshot = tm.name
  from public.clients c, public.team_members tm
 where r.client_id = c.id and r.member_id = tm.id
   and r.status = 'pending'
   and (r.client_name_snapshot is null or r.member_name_snapshot is null);

create function public.sales_entitlement_inbox_request_guard_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    select c.name into new.client_name_snapshot from public.clients c
      where c.id = new.client_id;
    select tm.name into new.member_name_snapshot from public.team_members tm
      where tm.id = new.member_id;
    if nullif(btrim(coalesce(new.client_name_snapshot, '')), '') is null
      or nullif(btrim(coalesce(new.member_name_snapshot, '')), '') is null then
      raise exception 'Sales entitlement requires a named client and team member.';
    end if;
    return new;
  end if;
  if old.id is distinct from new.id
    or old.client_id is distinct from new.client_id
    or old.member_id is distinct from new.member_id
    or old.bound_user_id is distinct from new.bound_user_id
    or old.action is distinct from new.action
    or old.scope_hash is distinct from new.scope_hash
    or old.requested_by is distinct from new.requested_by
    or old.requested_at is distinct from new.requested_at
    or old.client_name_snapshot is distinct from new.client_name_snapshot
    or old.member_name_snapshot is distinct from new.member_name_snapshot
    or old.status <> 'pending'
    or new.status not in ('approved','rejected')
    or new.decided_at is null or new.decided_by is distinct from auth.uid() then
    raise exception 'Sales entitlement request identity and decision are immutable.';
  end if;
  if auth.role() is distinct from 'authenticated'
    or auth.uid() is null or not coalesce(public.is_admin(),false)
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'An admin with AAL2 must decide sales access.';
  end if;
  if new.scope_hash <> public.sales_entitlement_scope_hash(
    new.client_id,new.member_id,new.bound_user_id,new.action) then
    raise exception 'Sales access scope changed. Request a new decision.';
  end if;
  if new.status = 'rejected'
    and nullif(btrim(coalesce(new.decision_note,'')), '') is null then
    raise exception 'Rejection needs a reason.';
  end if;
  return new;
end;
$$;
revoke all on function public.sales_entitlement_inbox_request_guard_v6()
  from public, anon, authenticated, service_role;
create trigger sales_entitlement_inbox_capture_v6
  before insert on public.client_sales_entitlement_requests
  for each row execute function public.sales_entitlement_inbox_request_guard_v6();
create trigger sales_entitlement_inbox_identity_v6
  before update on public.client_sales_entitlement_requests
  for each row execute function public.sales_entitlement_inbox_request_guard_v6();

create function public.sales_entitlement_inbox_payload_v6(
  p_request public.client_sales_entitlement_requests
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
begin
  return jsonb_build_object(
    'client_id',p_request.client_id,
    'source_system','aa_console',
    'source_kind','client_sales_entitlement',
    'source_id',p_request.id,
    'source_version',p_request.scope_hash,
    'title',case p_request.action when 'grant' then 'Grant sales access'
      else 'Revoke sales access' end,
    'artifact_hash',p_request.scope_hash,
    'preview',jsonb_build_object(
      'action',p_request.action,
      'client_name',p_request.client_name_snapshot,
      'member_name',p_request.member_name_snapshot,
      'client_id',p_request.client_id,
      'member_id',p_request.member_id,
      'bound_user_id',p_request.bound_user_id,
      'permission','Read and manage this client''s leads and conversations'),
    'destination','client_sales_os:' || p_request.client_id::text,
    'account_ref',p_request.bound_user_id::text,
    'budget',null,
    'scope',jsonb_build_object(
      'client_id',p_request.client_id,
      'member_id',p_request.member_id,
      'bound_user_id',p_request.bound_user_id,
      'action',p_request.action,
      'scope_hash',p_request.scope_hash),
    'owner_role','admin',
    'requested_by',p_request.requested_by,
    'requester_kind','human',
    'expires_at',p_request.requested_at + interval '7 days',
    'preview_blocker',case
      when p_request.scope_hash = public.sales_entitlement_scope_hash(
        p_request.client_id,p_request.member_id,p_request.bound_user_id,p_request.action)
        and p_request.client_name_snapshot is not null
        and p_request.member_name_snapshot is not null then null
      else 'The exact sales access scope or reviewer names are incomplete.' end,
    'owning_path','/clients/' || p_request.client_id::text || '/delivery/sales-os?tab=leads');
end;
$$;
revoke all on function public.sales_entitlement_inbox_payload_v6(
  public.client_sales_entitlement_requests)
  from public, anon, authenticated, service_role;

create function public.sales_entitlement_inbox_insert_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  perform public.register_approval_request_v6(
    public.sales_entitlement_inbox_payload_v6(new));
  return new;
end;
$$;
revoke all on function public.sales_entitlement_inbox_insert_v6()
  from public, anon, authenticated, service_role;
create trigger sales_entitlement_inbox_insert_v6
  after insert on public.client_sales_entitlement_requests
  for each row execute function public.sales_entitlement_inbox_insert_v6();

alter table public.client_sales_entitlements
  add constraint client_sales_entitlements_inbox_decision_fk
  foreign key (inbox_decision_id) references public.approval_decision_events_v6(id)
  on delete restrict not valid;

-- Even a valid decision UUID from another request cannot be pasted into a
-- grant. The request, source, hash, actor assurance and grant scope must all
-- match, and an explicit revocation event voids the binding.
create function public.sales_entitlement_inbox_binding_valid_v6(
  p_entitlement public.client_sales_entitlements
) returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select exists (
    select 1
      from public.client_sales_entitlement_requests r
      join public.approval_requests_v6 ar
        on ar.source_system = 'aa_console'
       and ar.source_kind = 'client_sales_entitlement'
       and ar.source_id = r.id::text
       and ar.source_version = r.scope_hash
       and ar.client_id = r.client_id
       and ar.artifact_hash = r.scope_hash
       and ar.owner_role = 'admin'
      join public.approval_decision_events_v6 d
        on d.request_id = ar.id
       and d.id = (p_entitlement).inbox_decision_id
       and d.decision = 'approved'
       and d.actor_aal = 'aal2'
       and d.actor_id = r.decided_by
       and d.actor_id = (p_entitlement).granted_by
       and d.artifact_hash = r.scope_hash
       and d.source_decision_ref = 'client_sales_entitlement_requests:' || r.id::text
     where r.id = (p_entitlement).grant_request_id
       and r.status = 'approved' and r.action = 'grant'
       and r.client_id = (p_entitlement).client_id
       and r.member_id = (p_entitlement).member_id
       and r.bound_user_id = (p_entitlement).bound_user_id
       and r.scope_hash = (p_entitlement).approved_scope_hash
       and r.scope_hash = public.sales_entitlement_scope_hash(
         r.client_id,r.member_id,r.bound_user_id,'grant')
       and not exists (
         select 1 from public.approval_decision_events_v6 revoked
         where revoked.request_id = ar.id and revoked.decision = 'revoked'
       )
  );
$$;
revoke all on function public.sales_entitlement_inbox_binding_valid_v6(
  public.client_sales_entitlements)
  from public, anon, authenticated, service_role;

create function public.guard_sales_entitlement_inbox_binding_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.inbox_decision_id is not null
    and not public.sales_entitlement_inbox_binding_valid_v6(new) then
    raise exception 'Inbox decision does not match this exact sales grant.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_sales_entitlement_inbox_binding_v6()
  from public, anon, authenticated, service_role;
create trigger sales_entitlement_inbox_binding_v6
  before insert or update on public.client_sales_entitlements
  for each row execute function public.guard_sales_entitlement_inbox_binding_v6();

create function public.sales_entitlement_inbox_decision_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_request_id uuid;
  v_decision_id uuid;
begin
  if old.status <> 'pending' or new.status not in ('approved','rejected') then
    return new;
  end if;
  v_request_id := public.register_approval_request_v6(
    public.sales_entitlement_inbox_payload_v6(old));
  v_decision_id := public.record_approval_decision_v6(
    v_request_id,new.status,new.scope_hash,
    'client_sales_entitlement_requests:' || new.id::text,
    new.decision_note);
  if new.status = 'approved' and new.action = 'grant' then
    update public.client_sales_entitlements e
       set inbox_decision_id = v_decision_id
     where e.grant_request_id = new.id
       and e.client_id = new.client_id
       and e.member_id = new.member_id
       and e.bound_user_id = new.bound_user_id
       and e.approved_scope_hash = new.scope_hash
       and e.revoked_at is null;
    if not found then
      raise exception 'The exact sales grant was not created by its owning decision.';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.sales_entitlement_inbox_decision_v6()
  from public, anon, authenticated, service_role;
create trigger sales_entitlement_inbox_decision_v6
  after update of status on public.client_sales_entitlement_requests
  for each row execute function public.sales_entitlement_inbox_decision_v6();

-- The B005 predicate only required a non-null UUID placeholder. Replace it
-- with a live join to the exact canonical decision. The product switch stays
-- off, so deployment alone grants no new sales-seat access.
create or replace function public.is_eligible_lead_owner(
  p_member_id uuid, p_client_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select c.inbox_enforced from public.client_sales_entitlement_controls c
                    where c.singleton),false)
     and exists (
       select 1 from public.client_sales_entitlements e
       join public.client_sales_entitlement_requests r on r.id = e.grant_request_id
       join public.team_members tm on tm.id = e.member_id
       join public.profiles p on p.id = tm.user_id
       where e.client_id = p_client_id and e.member_id = p_member_id
         and e.bound_user_id = tm.user_id and tm.active and p.role = 'employee'
         and e.revoked_at is null and e.inbox_decision_id is not null
         and r.status = 'approved' and r.action = 'grant'
         and r.client_id = e.client_id and r.member_id = e.member_id
         and r.bound_user_id = e.bound_user_id
         and r.scope_hash = e.approved_scope_hash
         and r.scope_hash = public.sales_entitlement_scope_hash(
             e.client_id,e.member_id,e.bound_user_id,'grant')
         and public.sales_entitlement_inbox_binding_valid_v6(e)
     );
$$;
revoke execute on function public.is_eligible_lead_owner(uuid,uuid)
  from public, anon, authenticated;

do $$
declare v_request public.client_sales_entitlement_requests%rowtype;
begin
  for v_request in select * from public.client_sales_entitlement_requests
    where status = 'pending'
  loop
    perform public.register_approval_request_v6(
      public.sales_entitlement_inbox_payload_v6(v_request));
  end loop;
end;
$$;

select public.lock_down_definer_functions();
