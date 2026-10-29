-- B005 sales entitlement boundary. A production grant cannot become effective
-- until B008 binds an exact-scope decision into the unified Approval Inbox.
-- The migration deliberately leaves the switch off and every inbox binding
-- null. Admin request/decision RPCs are reviewable and testable now, without
-- making a generic editor assignment a sales permission.

create table public.client_sales_entitlement_controls (
  singleton boolean primary key default true check (singleton),
  inbox_enforced boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.client_sales_entitlement_controls (singleton, inbox_enforced)
values (true, false);
alter table public.client_sales_entitlement_controls enable row level security;
revoke all on public.client_sales_entitlement_controls from public, anon, authenticated, service_role;
comment on table public.client_sales_entitlement_controls is
  'B008 may enable this only after a unified Inbox decision has a database-enforced exact-scope binding. Default false means staged approvals do not grant live access.';

create table public.client_sales_entitlement_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  member_id uuid not null references public.team_members(id) on delete restrict,
  bound_user_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action in ('grant', 'revoke')),
  scope_hash text not null check (scope_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete restrict,
  decided_at timestamptz,
  decision_note text,
  check ((status = 'pending' and decided_by is null and decided_at is null)
      or (status <> 'pending' and decided_by is not null and decided_at is not null))
);
create index client_sales_entitlement_requests_scope_idx
  on public.client_sales_entitlement_requests (client_id, member_id, requested_at desc);
create unique index client_sales_entitlement_one_pending_idx
  on public.client_sales_entitlement_requests (client_id, member_id)
  where status = 'pending';
alter table public.client_sales_entitlement_requests enable row level security;
create policy client_sales_entitlement_requests_admin_read
  on public.client_sales_entitlement_requests for select to authenticated
  using (public.is_admin());
revoke all on public.client_sales_entitlement_requests from public, anon, authenticated;
grant select on public.client_sales_entitlement_requests to authenticated;
comment on table public.client_sales_entitlement_requests is
  'Immutable client/member/user/action scope and its exact hash, with an audited admin decision. B008 must show these decisions in the unified Approval Inbox before enabling grants.';

create table public.client_sales_entitlements (
  client_id uuid not null references public.clients(id) on delete restrict,
  member_id uuid not null references public.team_members(id) on delete restrict,
  bound_user_id uuid not null references public.profiles(id) on delete restrict,
  grant_request_id uuid not null references public.client_sales_entitlement_requests(id) on delete restrict,
  approved_scope_hash text not null check (approved_scope_hash ~ '^[0-9a-f]{64}$'),
  inbox_decision_id uuid,
  granted_at timestamptz not null default now(),
  granted_by uuid not null references public.profiles(id) on delete restrict,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete restrict,
  revoke_request_id uuid references public.client_sales_entitlement_requests(id) on delete restrict,
  primary key (client_id, member_id),
  check ((revoked_at is null and revoked_by is null and revoke_request_id is null)
      or (revoked_at is not null and revoked_by is not null and revoke_request_id is not null))
);
create index client_sales_entitlements_user_idx
  on public.client_sales_entitlements (bound_user_id, client_id)
  where revoked_at is null;
alter table public.client_sales_entitlements enable row level security;
revoke all on public.client_sales_entitlements from public, anon, authenticated, service_role;
comment on column public.client_sales_entitlements.inbox_decision_id is
  'Null until B008 binds an actual unified-Inbox decision to this exact approved scope. A non-null value alone is insufficient while inbox_enforced is false.';

create or replace function public.sales_entitlement_scope_hash(
  p_client_id uuid, p_member_id uuid, p_user_id uuid, p_action text
)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'contract', 'client_sales_entitlement:v1',
    'client_id', p_client_id,
    'member_id', p_member_id,
    'user_id', p_user_id,
    'action', p_action
  )::text, 'UTF8')), 'hex');
$$;
revoke execute on function public.sales_entitlement_scope_hash(uuid, uuid, uuid, text)
  from public, anon, authenticated;

create or replace function public.request_client_sales_entitlement(
  p_client_id uuid, p_member_id uuid, p_action text
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_id uuid;
begin
  if auth.role() <> 'authenticated' or not public.is_admin() then
    raise exception 'Only an administrator may request sales access.';
  end if;
  if p_action is null or p_action not in ('grant', 'revoke') then
    raise exception 'Choose grant or revoke.';
  end if;
  if not exists (select 1 from public.clients where id = p_client_id) then
    raise exception 'Client does not exist.';
  end if;
  if p_action = 'grant' then
    select tm.user_id into v_user_id
      from public.team_members tm
      join public.profiles p on p.id = tm.user_id
     where tm.id = p_member_id and tm.active and p.role = 'employee';
    if v_user_id is null then
      raise exception 'Choose an active team member with an employee account.';
    end if;
  else
    -- A departed or relinked member still needs an auditable revocation.
    select e.bound_user_id into v_user_id
      from public.client_sales_entitlements e
     where e.client_id = p_client_id and e.member_id = p_member_id
       and e.revoked_at is null;
    if v_user_id is null then
      raise exception 'This member has no current sales grant for this client.';
    end if;
  end if;
  insert into public.client_sales_entitlement_requests (
    client_id, member_id, bound_user_id, action, scope_hash, requested_by
  ) values (
    p_client_id, p_member_id, v_user_id, p_action,
    public.sales_entitlement_scope_hash(p_client_id,p_member_id,v_user_id,p_action), auth.uid()
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.request_client_sales_entitlement(uuid, uuid, text)
  from public, anon;
grant execute on function public.request_client_sales_entitlement(uuid, uuid, text)
  to authenticated;

create or replace function public.decide_client_sales_entitlement(
  p_request_id uuid, p_scope_hash text, p_approve boolean, p_note text
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_req public.client_sales_entitlement_requests%rowtype;
  v_user_id uuid;
begin
  if auth.role() <> 'authenticated' or not public.is_admin() then
    raise exception 'Only an administrator may decide sales access.';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'MFA assurance level aal2 is required to decide sales access.';
  end if;
  if p_approve is null then
    raise exception 'Choose approve or reject.';
  end if;
  select * into v_req from public.client_sales_entitlement_requests
   where id = p_request_id for update;
  if not found or v_req.status <> 'pending' then
    raise exception 'This sales access request is no longer pending.';
  end if;
  if p_scope_hash is distinct from v_req.scope_hash or v_req.scope_hash <>
     public.sales_entitlement_scope_hash(v_req.client_id,v_req.member_id,v_req.bound_user_id,v_req.action) then
    raise exception 'The exact sales access scope changed. Request a new decision.';
  end if;
  if v_req.action = 'grant' then
    select tm.user_id into v_user_id
      from public.team_members tm
      join public.profiles p on p.id = tm.user_id
     where tm.id = v_req.member_id and tm.active and p.role = 'employee';
    if v_user_id is distinct from v_req.bound_user_id then
      raise exception 'The team member identity changed. Request a new decision.';
    end if;
  end if;
  if p_approve and v_req.action = 'grant' then
    insert into public.client_sales_entitlements (
      client_id,member_id,bound_user_id,grant_request_id,approved_scope_hash,granted_by
    ) values (
      v_req.client_id,v_req.member_id,v_req.bound_user_id,v_req.id,v_req.scope_hash,auth.uid()
    ) on conflict (client_id,member_id) do update
      set bound_user_id = excluded.bound_user_id,
          grant_request_id = excluded.grant_request_id,
          approved_scope_hash = excluded.approved_scope_hash,
          inbox_decision_id = null,
          granted_at = now(), granted_by = auth.uid(),
          revoked_at = null, revoked_by = null, revoke_request_id = null;
  elsif p_approve and v_req.action = 'revoke' then
    update public.client_sales_entitlements
       set revoked_at = now(), revoked_by = auth.uid(), revoke_request_id = v_req.id,
           inbox_decision_id = null
     where client_id = v_req.client_id and member_id = v_req.member_id
       and bound_user_id = v_req.bound_user_id and revoked_at is null;
    if not found then
      raise exception 'The sales grant changed. Request a new decision.';
    end if;
  end if;
  update public.client_sales_entitlement_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(p_note),'')
   where id = v_req.id;
end;
$$;
revoke execute on function public.decide_client_sales_entitlement(uuid, text, boolean, text)
  from public, anon;
grant execute on function public.decide_client_sales_entitlement(uuid, text, boolean, text)
  to authenticated;

-- Callers cannot activate a grant by adding an editor job, changing a client
-- assignment, or approving a request before B008. Every live check requires
-- the switch, the Inbox binding, the approved exact hash, and current identity.
create or replace function public.is_eligible_lead_owner(p_member_id uuid, p_client_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
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
     );
$$;
revoke execute on function public.is_eligible_lead_owner(uuid, uuid)
  from public, anon, authenticated;

create or replace function public.has_client_sales_entitlement(p_client_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_members tm
     where tm.user_id = auth.uid() and tm.active
       and public.is_eligible_lead_owner(tm.id,p_client_id)
  );
$$;
revoke execute on function public.has_client_sales_entitlement(uuid) from public, anon;
grant execute on function public.has_client_sales_entitlement(uuid) to authenticated;

create or replace function public.may_manage_client_leads(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.role() = 'service_role',false)
      or public.is_admin()
      or public.is_client_user(target)
      or public.has_client_sales_entitlement(target);
$$;
revoke execute on function public.may_manage_client_leads(uuid)
  from public, anon, authenticated;
grant execute on function public.may_manage_client_leads(uuid) to service_role;

create policy cl_sales_read on public.client_leads
  for select to authenticated using (public.has_client_sales_entitlement(client_id));
create policy le_sales_read on public.lead_events
  for select to authenticated using (public.has_client_sales_entitlement(client_id));
create policy lead_identities_sales_read on public.lead_identities
  for select to authenticated using (public.has_client_sales_entitlement(client_id));
create policy archived_leads_sales_read on public.archived_leads
  for select to authenticated using (public.has_client_sales_entitlement(client_id));

-- The client Add Lead form uses a narrow creation RPC. Direct INSERT would
-- let a client send stage=cash, collected revenue, outcome, source IDs, probe
-- status or forged consent even though update_lead governs later edits.
-- Existing service producers and the admin table policy retain their paths.
create or replace function public.create_manual_lead(
  p_client_id uuid, p_name text, p_email text default null, p_phone text default null,
  p_owner_member_id uuid default null, p_next_action text default null,
  p_next_action_due date default null, p_opportunity_value numeric default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_name text := nullif(trim(p_name), '');
  v_email text := nullif(trim(p_email), '');
  v_phone text := nullif(trim(p_phone), '');
begin
  if auth.role() not in ('authenticated','service_role')
     or not public.may_manage_client_leads(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if v_name is null then
    raise exception 'Name is required.';
  end if;
  if p_opportunity_value < 0 then
    raise exception 'Opportunity value must be zero or more.';
  end if;
  insert into public.client_leads (
    client_id,name,email,phone,contact,source,stage,owner_member_id,
    next_action,next_action_due,opportunity_value,created_by
  ) values (
    p_client_id,v_name,v_email,v_phone,coalesce(v_email,v_phone),'manual_entry',
    'profile_visit',p_owner_member_id,nullif(trim(p_next_action),''),
    p_next_action_due,p_opportunity_value,auth.uid()
  ) returning id into v_id;
  insert into public.lead_events (lead_id,client_id,kind,body,created_by)
  values (v_id,p_client_id,'note','Created manually.',auth.uid());
  return v_id;
end;
$$;
revoke execute on function public.create_manual_lead(
  uuid,text,text,text,uuid,text,date,numeric) from public,anon;
grant execute on function public.create_manual_lead(
  uuid,text,text,text,uuid,text,date,numeric) to authenticated,service_role;

-- This older definer trigger used can_access_client, which cannot include a
-- sales seat without also handing it every creative/strategy surface.
create or replace function public.register_lead_identity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not public.may_manage_client_leads(new.client_id) then
    raise exception 'Not permitted for this client';
  end if;
  insert into public.lead_identities (id,client_id) values (new.id,new.client_id)
  on conflict (id) do nothing;
  if not exists (select 1 from public.lead_identities
                  where id = new.id and client_id = new.client_id) then
    raise exception 'Lead identity belongs to another client.';
  end if;
  return new;
end;
$$;
revoke execute on function public.register_lead_identity() from public, anon;

create or replace function public.guard_client_lead_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.owner_member_id is not null and (
       tg_op = 'INSERT' or new.owner_member_id is distinct from old.owner_member_id
       or new.client_id is distinct from old.client_id
     ) and not public.is_eligible_lead_owner(new.owner_member_id,new.client_id) then
    raise exception 'Choose an approved sales owner assigned to this client.';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_client_lead_owner() from public, anon, authenticated;
create trigger client_leads_owner_scope
  before insert or update of owner_member_id, client_id on public.client_leads
  for each row execute function public.guard_client_lead_owner();

create or replace function public.list_client_lead_owners(p_client_id uuid)
returns table (id uuid, name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.may_manage_client_leads(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  return query
    select tm.id, tm.name from public.team_members tm
     where public.is_eligible_lead_owner(tm.id,p_client_id)
     order by tm.name, tm.id;
end;
$$;
revoke execute on function public.list_client_lead_owners(uuid) from public, anon;
grant execute on function public.list_client_lead_owners(uuid) to authenticated, service_role;

-- This legacy view was created without security_invoker, so RLS on the lead
-- table was not guaranteed to govern direct view reads by authenticated users.
create or replace view public.lead_pipeline_counts
with (security_invoker = true) as
select client_id, pipeline_stage, count(*) as lead_count
  from public.client_leads group by client_id,pipeline_stage;
