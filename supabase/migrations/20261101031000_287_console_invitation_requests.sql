-- B004 / 284: frozen, one-recipient Auth invitations. Depends on the B008
-- canonical ledger. This migration does not send an email or grant access.
do $$ begin
  if to_regclass('public.approval_requests_v6') is null then
    raise exception 'Apply canonical approval migration 273 before invitations 284.';
  end if;
end $$;

-- A retire/restore or material roster edit must never revive an old link.
-- The trigger also ignores an attempted direct generation overwrite.
alter table public.team_members
  add column invitation_generation_v6 bigint not null default 0;
create function public.advance_team_invitation_generation_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  new.invitation_generation_v6 := old.invitation_generation_v6
    + case when row(new.active,new.name,new.category,new.user_id)
      is distinct from row(old.active,old.name,old.category,old.user_id)
      then 1 else 0 end;
  return new;
end;
$$;
create trigger advance_team_invitation_generation_v6
  before update on public.team_members
  for each row execute function public.advance_team_invitation_generation_v6();

create table public.console_invitation_requests_v6 (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  recipient_email text not null check (recipient_email = lower(btrim(recipient_email))
    and recipient_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  target_role text not null check (target_role in ('employee','client')),
  target_member_id uuid references public.team_members(id) on delete restrict,
  target_client_id uuid references public.clients(id) on delete restrict,
  team_category public.team_category,
  full_name text not null check (length(btrim(full_name)) between 1 and 200),
  sender_account text not null check (length(btrim(sender_account)) between 3 and 320),
  redirect_origin text not null check (redirect_origin ~ '^https://[^/]+$'),
  requested_by uuid not null references public.profiles(id) on delete restrict,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'requested' check (status in
    ('requested','approved','rejected','sending','sent','reconcile','conflict','accepted','cancelled')),
  provider_user_id uuid,
  sent_at timestamptz,
  accepted_at timestamptz,
  check ((target_role = 'employee' and target_member_id is not null
       and target_client_id is null and team_category is not null)
    or (target_role = 'client' and target_member_id is null
       and target_client_id is not null and team_category is null)),
  check ((status in ('sent','accepted') and provider_user_id is not null)
    or status not in ('sent','accepted'))
);
create unique index console_invitation_active_email_v6_idx
  on public.console_invitation_requests_v6(recipient_email)
  where status in ('requested','approved','sending','sent','reconcile');
create unique index console_invitation_active_member_v6_idx
  on public.console_invitation_requests_v6(target_member_id)
  where target_role = 'employee' and status in
    ('requested','approved','sending','sent','reconcile');
create index console_invitation_target_member_v6_idx
  on public.console_invitation_requests_v6(target_member_id, requested_at desc);

-- Every state change has a durable, redacted event. No provider link, token,
-- access token or password may enter this table.
create table public.console_invitation_events_v6 (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.console_invitation_requests_v6(id) on delete restrict,
  state text not null,
  actor_id uuid,
  provider_user_id uuid,
  reason text,
  occurred_at timestamptz not null default now()
);
create index console_invitation_events_v6_request_idx
  on public.console_invitation_events_v6(request_id, occurred_at desc);

create function public.guard_console_invitation_request_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Invitation requests cannot be deleted.' using errcode = '42501';
  end if;
  if row(old.id, old.idempotency_key, old.recipient_email, old.target_role,
       old.target_member_id, old.target_client_id, old.team_category,
       old.full_name, old.sender_account, old.redirect_origin,
       old.requested_by, old.requested_at, old.expires_at,
       old.payload, old.payload_hash) is distinct from
     row(new.id, new.idempotency_key, new.recipient_email, new.target_role,
       new.target_member_id, new.target_client_id, new.team_category,
       new.full_name, new.sender_account, new.redirect_origin,
       new.requested_by, new.requested_at, new.expires_at,
       new.payload, new.payload_hash) then
    raise exception 'Invitation request evidence is immutable.' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger guard_console_invitation_request_v6
  before update or delete on public.console_invitation_requests_v6
  for each row execute function public.guard_console_invitation_request_v6();

create function public.guard_console_invitation_event_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  raise exception 'Invitation events are append-only.' using errcode = '42501';
end;
$$;
create trigger guard_console_invitation_event_v6
  before update or delete on public.console_invitation_events_v6
  for each row execute function public.guard_console_invitation_event_v6();

alter table public.console_invitation_requests_v6 enable row level security;
alter table public.console_invitation_events_v6 enable row level security;
create policy console_invitation_admin_read_v6 on public.console_invitation_requests_v6
  for select to authenticated using (public.is_admin());
create policy console_invitation_event_admin_read_v6 on public.console_invitation_events_v6
  for select to authenticated using (public.is_admin());
revoke all on public.console_invitation_requests_v6,
  public.console_invitation_events_v6 from public, anon, authenticated, service_role;
grant select on public.console_invitation_requests_v6,
  public.console_invitation_events_v6 to authenticated, service_role;

create function public.request_console_invitation_v6(
  p_recipient_email text, p_target_role text, p_target_member_id uuid,
  p_target_client_id uuid, p_sender_account text, p_redirect_origin text,
  p_auth_project_origin text, p_verification_id uuid,
  p_idempotency_key uuid, p_actor_id uuid
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_existing public.console_invitation_requests_v6%rowtype;
  v_member public.team_members%rowtype;
  v_verification record;
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_sender text := lower(btrim(coalesce(p_sender_account, '')));
  v_name text;
  v_category public.team_category;
  v_expires timestamptz := now() + interval '7 days';
  v_payload jsonb;
  v_hash text;
  v_id uuid := gen_random_uuid();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted runtime only.' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_actor_id is null
    or not exists (select 1 from public.profiles
      where id = p_actor_id and role = 'admin') then
    raise exception 'A provisioned requesting admin and key are required.' using errcode = '42501';
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(v_email) > 320 or v_sender !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(v_sender) > 320 or p_redirect_origin !~ '^https://[^/]+$'
    or p_auth_project_origin !~ '^https://[^/]+$' or p_verification_id is null
    or p_target_role not in ('employee','client') then
    raise exception 'Invalid recipient, sender, redirect origin or role.' using errcode = '22023';
  end if;
  -- A replay must remain idempotent even after the target became linked and
  -- the provider created its Auth user. Compare only the frozen request input.
  select * into v_existing from public.console_invitation_requests_v6
    where idempotency_key = p_idempotency_key for update;
  if found then
    if v_existing.recipient_email = v_email
      and v_existing.target_role = p_target_role
      and v_existing.target_member_id is not distinct from p_target_member_id
      and v_existing.target_client_id is not distinct from p_target_client_id
      and v_existing.sender_account = v_sender
      and v_existing.redirect_origin = p_redirect_origin
      and v_existing.payload ->> 'auth_project_origin' = p_auth_project_origin
      and v_existing.payload ->> 'sender_verification_id' = p_verification_id::text
      and v_existing.requested_by = p_actor_id then
      return v_existing.id;
    end if;
    raise exception 'Invitation idempotency key belongs to different evidence.' using errcode = '23505';
  end if;
  select id,template_subject,template_body,template_sha256,evidence_sha256
    into v_verification from public.console_auth_sender_verifications_v6
    where id = p_verification_id and sender_email = v_sender
      and supabase_url_origin = p_auth_project_origin
      and redirect_origin = p_redirect_origin and expires_at > now();
  if not found then
    raise exception 'Exact Auth sender, template and redirect verification is missing.'
      using errcode = '23514';
  end if;
  if p_target_role = 'employee' then
    if p_target_client_id is not null or p_target_member_id is null then
      raise exception 'Employee invitation requires one roster member.' using errcode = '22023';
    end if;
    select * into v_member from public.team_members
      where id = p_target_member_id for update;
    if not found or not v_member.active or v_member.user_id is not null then
      raise exception 'Roster member is unavailable for invitation.' using errcode = '23514';
    end if;
    v_name := btrim(v_member.name);
    v_category := v_member.category;
  else
    if p_target_member_id is not null or p_target_client_id is null
      or not exists (select 1 from public.clients where id = p_target_client_id) then
      raise exception 'Client invitation requires one valid client.' using errcode = '22023';
    end if;
    v_name := v_email;
  end if;

  -- The runtime has already checked Auth Admin API. Recheck the underlying
  -- Auth table in the same transaction: an unverified account is a conflict.
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'An Auth account already uses this email; review provenance.'
      using errcode = '23505';
  end if;
  v_payload := jsonb_build_object(
    'recipient_email', v_email, 'sender_account', v_sender,
    'target_role', p_target_role, 'target_member_id', p_target_member_id,
    'target_client_id', p_target_client_id, 'team_category', v_category,
    'team_member_generation', case when p_target_role = 'employee'
      then v_member.invitation_generation_v6 else null end,
    'full_name', v_name, 'redirect_origin', p_redirect_origin,
    'auth_project_origin', p_auth_project_origin,
    'sender_verification_id', p_verification_id,
    'smtp_evidence_sha256', v_verification.evidence_sha256,
    'template_subject', v_verification.template_subject,
    'template_body', v_verification.template_body,
    'template_sha256', v_verification.template_sha256,
    'redirect_url', p_redirect_origin || '/invite/accept?request=' || v_id::text,
    'expires_at', v_expires
  );
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  insert into public.console_invitation_requests_v6 (
    id, idempotency_key, recipient_email, target_role, target_member_id,
    target_client_id, team_category, full_name, sender_account,
    redirect_origin, requested_by, expires_at, payload, payload_hash
  ) values (
    v_id, p_idempotency_key, v_email, p_target_role, p_target_member_id,
    p_target_client_id, v_category, v_name, v_sender,
    p_redirect_origin, p_actor_id, v_expires, v_payload, v_hash
  ) returning id into v_id;

  perform public.register_approval_request_v6(jsonb_build_object(
    -- A client invite belongs to that client's admin scope. The released
    -- approval_source_state_v6 adapter compares target_client_id to card
    -- client_id; an agency-null card would stay superseded forever.
    'client_id', p_target_client_id, 'source_system', 'auth',
    'source_kind', 'console_invitation', 'source_id', v_id::text,
    'source_version', v_hash, 'title', 'Send one Auth invitation to ' || v_email,
    'artifact_hash', v_hash, 'preview', v_payload,
    'destination', v_email, 'account_ref', v_sender,
    'scope', jsonb_build_object('target_role', p_target_role,
      'target_member_id', p_target_member_id,
      'target_client_id', p_target_client_id),
    'owner_role', 'admin', 'expires_at', v_expires,
    'owning_path', '/approvals',
    'requested_by', p_actor_id, 'requester_kind', 'human'
  ));
  insert into public.console_invitation_events_v6(request_id,state,actor_id)
    values (v_id,'requested',p_actor_id);
  return v_id;
end;
$$;

revoke execute on function public.guard_console_invitation_request_v6() from public,anon,authenticated,service_role;
revoke execute on function public.advance_team_invitation_generation_v6() from public,anon,authenticated,service_role;
revoke execute on function public.guard_console_invitation_event_v6() from public,anon,authenticated,service_role;
revoke execute on function public.request_console_invitation_v6(text,text,uuid,uuid,text,text,text,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.request_console_invitation_v6(text,text,uuid,uuid,text,text,text,uuid,uuid,uuid)
  to service_role;
select public.lock_down_definer_functions();
