-- B004 / 285: the owning AAL2 decision and a single durable send claim.
-- A claim precedes Auth's external email effect. An uncertain outcome cannot
-- be retried automatically, so provider timeouts cannot duplicate mail.
do $$ begin
  if to_regclass('public.console_invitation_requests_v6') is null then
    raise exception 'Apply invitation migration 284 before 285.';
  end if;
end $$;

-- A signed, recent read-back of Supabase Auth's actual SMTP From identity,
-- project URL and allowed redirect. Runtime strings alone cannot open the
-- send gate. The evidence hash identifies the retained dashboard export.
create table public.console_auth_sender_verifications_v6 (
  id uuid primary key default gen_random_uuid(),
  sender_email text not null,
  supabase_url_origin text not null,
  redirect_origin text not null,
  template_subject text not null check (length(btrim(template_subject)) between 1 and 500),
  template_body text not null check (length(btrim(template_body)) between 1 and 20000),
  template_sha256 text not null check (template_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_ref text not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  verified_by uuid not null references public.profiles(id) on delete restrict,
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index console_auth_sender_verification_latest_v6_idx
  on public.console_auth_sender_verifications_v6
  (sender_email,supabase_url_origin,redirect_origin,verified_at desc);
create trigger console_auth_sender_verification_append_only_v6
  before update or delete on public.console_auth_sender_verifications_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
alter table public.console_auth_sender_verifications_v6 enable row level security;
create policy console_auth_sender_verification_admin_read_v6
  on public.console_auth_sender_verifications_v6 for select to authenticated
  using (public.is_admin());
revoke all on public.console_auth_sender_verifications_v6
  from public,anon,authenticated,service_role;
grant select on public.console_auth_sender_verifications_v6
  to authenticated,service_role;

create function public.record_console_auth_sender_verification_v6(
  p_sender_email text, p_supabase_url_origin text,
  p_redirect_origin text, p_template_subject text, p_template_body text,
  p_evidence_ref text, p_evidence_sha256 text
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal','') <> 'aal2'
    or not public.is_admin() then
    raise exception 'A provisioned admin with AAL2 must attest Auth SMTP settings.'
      using errcode = '42501';
  end if;
  if p_sender_email is null or p_sender_email <> lower(btrim(p_sender_email))
    or p_sender_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_supabase_url_origin !~ '^https://[^/]+$'
    or p_redirect_origin !~ '^https://[^/]+$'
    or length(btrim(coalesce(p_template_subject,''))) not between 1 and 500
    or length(btrim(coalesce(p_template_body,''))) not between 1 and 20000
    or nullif(btrim(coalesce(p_evidence_ref,'')),'') is null
    or length(p_evidence_ref) > 500
    or p_evidence_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Exact sender, project, redirect and retained read-back evidence are required.'
      using errcode = '22023';
  end if;
  insert into public.console_auth_sender_verifications_v6 (
    sender_email,supabase_url_origin,redirect_origin,
    template_subject,template_body,template_sha256,evidence_ref,
    evidence_sha256,verified_by,expires_at
  ) values (
    p_sender_email,p_supabase_url_origin,p_redirect_origin,
    p_template_subject,p_template_body,
    encode(sha256(convert_to(jsonb_build_object(
      'subject',p_template_subject,'body',p_template_body)::text,'UTF8')),'hex'),
    btrim(p_evidence_ref),p_evidence_sha256,auth.uid(),now()+interval '30 days'
  ) returning id into v_id;
  return v_id;
end;
$$;

create table public.console_invitation_send_claims_v6 (
  request_id uuid primary key references public.console_invitation_requests_v6(id) on delete restrict,
  claimed_at timestamptz not null default now(),
  claimed_by uuid not null references public.profiles(id) on delete restrict
);
create function public.guard_console_invitation_claim_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  raise exception 'Invitation send claims are append-only.' using errcode = '42501';
end;
$$;
create trigger guard_console_invitation_claim_v6
  before update or delete on public.console_invitation_send_claims_v6
  for each row execute function public.guard_console_invitation_claim_v6();
alter table public.console_invitation_send_claims_v6 enable row level security;
revoke all on public.console_invitation_send_claims_v6
  from public, anon, authenticated, service_role;

create function public.decide_console_invitation_v6(
  p_request_id uuid, p_expected_source_version text,
  p_expected_artifact_hash text, p_approved boolean, p_reason text default null
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.console_invitation_requests_v6%rowtype;
  v_card public.approval_requests_v6%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal','') <> 'aal2'
    or not public.is_admin() then
    raise exception 'A provisioned admin with AAL2 must decide this invitation.'
      using errcode = '42501';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
  if v_request.status <> 'requested'
    or v_request.payload_hash is distinct from p_expected_source_version
    or v_request.payload_hash is distinct from p_expected_artifact_hash then
    raise exception 'Invitation state or exact version changed.' using errcode = '23514';
  end if;
  select * into v_card from public.approval_requests_v6
    where source_system = 'auth' and source_kind = 'console_invitation'
      and source_id = v_request.id::text
      and source_version = v_request.payload_hash for update;
  if not found or v_card.artifact_hash is distinct from v_request.payload_hash
    or v_card.preview is distinct from v_request.payload
    or v_card.destination is distinct from v_request.recipient_email
    or v_card.account_ref is distinct from v_request.sender_account then
    raise exception 'The frozen Inbox card does not match this invitation.'
      using errcode = '23514';
  end if;
  if p_approved then
    if v_request.expires_at <= now() then
      raise exception 'Invitation expired.' using errcode = '23514';
    end if;
    if exists (select 1 from auth.users
      where lower(email) = v_request.recipient_email) then
      raise exception 'Auth email now exists; review provenance.' using errcode = '23505';
    end if;
    if v_request.target_role = 'employee' and not exists (
      select 1 from public.team_members where id = v_request.target_member_id
        and active and user_id is null and category = v_request.team_category
        and name = v_request.full_name
        and invitation_generation_v6 = (v_request.payload ->> 'team_member_generation')::bigint
    ) then
      raise exception 'Roster target changed; request a new invitation.' using errcode = '23514';
    end if;
    update public.console_invitation_requests_v6 set status = 'approved'
      where id = v_request.id;
  else
    if nullif(btrim(coalesce(p_reason,'')),'') is null then
      raise exception 'A rejection reason is required.' using errcode = '22023';
    end if;
    update public.console_invitation_requests_v6 set status = 'rejected'
      where id = v_request.id;
  end if;
  perform public.record_approval_decision_v6(v_card.id,
    case when p_approved then 'approved' else 'rejected' end,
    v_request.payload_hash, 'console_invitation:' || v_request.id::text || ':decision',
    p_reason);
  insert into public.console_invitation_events_v6(request_id,state,actor_id,reason)
    values (v_request.id, case when p_approved then 'approved' else 'rejected' end,
      auth.uid(), case when p_approved then null else btrim(p_reason) end);
  select * into v_request from public.console_invitation_requests_v6 where id = p_request_id;
  return v_request;
end;
$$;

create function public.claim_console_invitation_send_v6(
  p_request_id uuid, p_actor_id uuid, p_expected_hash text
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.console_invitation_requests_v6%rowtype;
  v_card_id uuid;
begin
  if auth.role() is distinct from 'service_role'
    or not exists (select 1 from public.profiles
      where id = p_actor_id and role = 'admin') then
    raise exception 'Trusted runtime and admin are required.' using errcode = '42501';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
  if v_request.status <> 'approved' or v_request.expires_at <= now()
    or v_request.payload_hash is distinct from p_expected_hash then
    raise exception 'Invitation is not approved at this exact version.' using errcode = '23514';
  end if;
  if exists (select 1 from auth.users
    where lower(email) = v_request.recipient_email) then
    raise exception 'Auth email now exists; do not send.' using errcode = '23505';
  end if;
  if v_request.target_role = 'employee' and not exists (
    select 1 from public.team_members where id = v_request.target_member_id
      and active and user_id is null and category = v_request.team_category
      and name = v_request.full_name
      and invitation_generation_v6 = (v_request.payload ->> 'team_member_generation')::bigint
  ) then
    raise exception 'Roster target changed; do not send.' using errcode = '23514';
  end if;
  select id into v_card_id from public.approval_requests_v6
    where source_system = 'auth' and source_kind = 'console_invitation'
      and source_id = v_request.id::text and source_version = v_request.payload_hash
      and artifact_hash = v_request.payload_hash and preview = v_request.payload
      and destination = v_request.recipient_email
      and account_ref = v_request.sender_account;
  if v_card_id is null or not exists (
    select 1 from public.approval_decision_events_v6 d
      where d.request_id = v_card_id and d.decision = 'approved'
        and d.artifact_hash = v_request.payload_hash
        and not exists (
          select 1 from public.approval_decision_events_v6 later
          where later.request_id = v_card_id
            and (later.decided_at, later.id) > (d.decided_at, d.id))
  ) then
    raise exception 'Current exact-version human approval is required.' using errcode = '42501';
  end if;
  insert into public.console_invitation_send_claims_v6(request_id,claimed_by)
    values (v_request.id,p_actor_id);
  update public.console_invitation_requests_v6 set status = 'sending'
    where id = v_request.id;
  insert into public.console_invitation_events_v6(request_id,state,actor_id)
    values (v_request.id,'sending',p_actor_id);
  select * into v_request from public.console_invitation_requests_v6 where id = p_request_id;
  return v_request;
end;
$$;

create function public.finish_console_invitation_send_v6(
  p_request_id uuid, p_outcome text, p_provider_user_id uuid,
  p_reason_code text default null
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare v_request public.console_invitation_requests_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted runtime only.' using errcode = '42501';
  end if;
  if p_outcome not in ('sent','reconcile','conflict')
    or (p_reason_code is not null and p_reason_code not in
      ('provider_timeout','provider_error','auth_conflict','provider_mismatch','db_mismatch')) then
    raise exception 'Invalid redacted send outcome.' using errcode = '22023';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found or v_request.status <> 'sending'
    or not exists (select 1 from public.console_invitation_send_claims_v6
      where request_id = p_request_id) then
    raise exception 'No active claimed send to finish.' using errcode = '23514';
  end if;
  if p_outcome = 'sent' and (p_provider_user_id is null or not exists (
    select 1 from auth.users where id = p_provider_user_id
      and lower(email) = v_request.recipient_email
  )) then
    raise exception 'Provider user identity does not match Auth.' using errcode = '23514';
  end if;
  update public.console_invitation_requests_v6
    set status = p_outcome,
        provider_user_id = case when p_outcome = 'sent' then p_provider_user_id else null end,
        sent_at = case when p_outcome = 'sent' then now() else null end
    where id = p_request_id;
  insert into public.console_invitation_events_v6(
    request_id,state,provider_user_id,reason
  ) values (p_request_id,p_outcome,
    case when p_outcome = 'sent' then p_provider_user_id else null end,
    p_reason_code);
  select * into v_request from public.console_invitation_requests_v6 where id = p_request_id;
  return v_request;
end;
$$;

create function public.mark_console_invitation_conflict_v6(
  p_request_id uuid, p_expected_hash text
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare v_request public.console_invitation_requests_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted runtime only.' using errcode = '42501';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found or v_request.status <> 'approved'
    or v_request.payload_hash is distinct from p_expected_hash
    or not exists (select 1 from auth.users
      where lower(email) = v_request.recipient_email) then
    raise exception 'Existing Auth account conflict was not verified.' using errcode = '23514';
  end if;
  update public.console_invitation_requests_v6 set status = 'conflict'
    where id = p_request_id;
  insert into public.console_invitation_events_v6(request_id,state,reason)
    values (p_request_id,'conflict','auth_conflict');
  select * into v_request from public.console_invitation_requests_v6 where id = p_request_id;
  return v_request;
end;
$$;

create function public.cancel_console_invitation_v6(
  p_request_id uuid, p_reason text
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.console_invitation_requests_v6%rowtype;
  v_card public.approval_requests_v6%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal','') <> 'aal2'
    or not public.is_admin() then
    raise exception 'A provisioned admin with AAL2 must cancel.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then
    raise exception 'A cancellation reason is required.' using errcode = '22023';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found or v_request.status not in ('requested','approved','sent','conflict') then
    raise exception 'Invitation cannot be cancelled from this state.' using errcode = '23514';
  end if;
  select * into v_card from public.approval_requests_v6
    where source_system = 'auth' and source_kind = 'console_invitation'
      and source_id = v_request.id::text and source_version = v_request.payload_hash;
  update public.console_invitation_requests_v6 set status = 'cancelled'
    where id = p_request_id;
  perform public.record_approval_decision_v6(v_card.id,
    case when v_request.status = 'requested' then 'rejected' else 'revoked' end,
    v_request.payload_hash, 'console_invitation:' || v_request.id::text || ':cancel',
    p_reason);
  insert into public.console_invitation_events_v6(request_id,state,actor_id,reason)
    values (v_request.id,'cancelled',auth.uid(),btrim(p_reason));
  select * into v_request from public.console_invitation_requests_v6 where id = p_request_id;
  return v_request;
end;
$$;

-- An in-flight or ambiguous provider outcome remains reserved. Only a human
-- admin who has inspected retained provider evidence may attest that no
-- invitation was issued. The Auth table absence is checked in this transaction.
-- This never retries the external send.
create function public.resolve_console_invitation_uncertain_v6(
  p_request_id uuid, p_expected_hash text, p_evidence_ref text,
  p_evidence_sha256 text, p_reason text
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.console_invitation_requests_v6%rowtype;
  v_card public.approval_requests_v6%rowtype;
  v_claimed_at timestamptz;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt() ->> 'aal','') <> 'aal2' or not public.is_admin() then
    raise exception 'A provisioned admin with AAL2 must resolve an uncertain send.'
      using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_evidence_ref,'')),'') is null
    or length(p_evidence_ref) > 500
    or p_evidence_sha256 !~ '^[0-9a-f]{64}$'
    or nullif(btrim(coalesce(p_reason,'')),'') is null
    or length(p_reason) > 500 then
    raise exception 'Retained provider no-send evidence and reason are required.'
      using errcode = '22023';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found or v_request.status not in ('sending','reconcile')
    or v_request.payload_hash is distinct from p_expected_hash then
    raise exception 'Uncertain invitation state or exact version changed.'
      using errcode = '23514';
  end if;
  select claimed_at into v_claimed_at from public.console_invitation_send_claims_v6
    where request_id = p_request_id;
  if v_claimed_at is null or v_claimed_at > now() - interval '15 minutes' then
    raise exception 'Wait for the provider outcome before resolving this send.'
      using errcode = '23514';
  end if;
  if exists (select 1 from auth.users where lower(email) = v_request.recipient_email) then
    raise exception 'Auth user exists; resolve or disable that identity first.'
      using errcode = '23505';
  end if;
  select * into v_card from public.approval_requests_v6
    where source_system = 'auth' and source_kind = 'console_invitation'
      and source_id = v_request.id::text and source_version = v_request.payload_hash
      and artifact_hash = v_request.payload_hash;
  if not found then
    raise exception 'Exact invitation card is missing.' using errcode = '23514';
  end if;
  update public.console_invitation_requests_v6 set status = 'cancelled'
    where id = p_request_id;
  perform public.record_approval_decision_v6(v_card.id,'revoked',
    v_request.payload_hash,
    'console_invitation:' || v_request.id::text || ':uncertain-resolved',
    'Provider no-send evidence ' || btrim(p_evidence_ref)
      || ' sha256=' || p_evidence_sha256 || '; ' || btrim(p_reason));
  insert into public.console_invitation_events_v6(request_id,state,actor_id,reason)
    values (p_request_id,'cancelled',auth.uid(),
      'no_send:' || btrim(p_evidence_ref) || ':' || p_evidence_sha256);
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id;
  return v_request;
end;
$$;

revoke execute on function public.guard_console_invitation_claim_v6() from public,anon,authenticated,service_role;
revoke execute on function public.record_console_auth_sender_verification_v6(text,text,text,text,text,text,text)
  from public,anon,service_role;
grant execute on function public.record_console_auth_sender_verification_v6(text,text,text,text,text,text,text)
  to authenticated;
revoke execute on function public.decide_console_invitation_v6(uuid,text,text,boolean,text)
  from public,anon,service_role;
grant execute on function public.decide_console_invitation_v6(uuid,text,text,boolean,text)
  to authenticated;
revoke execute on function public.claim_console_invitation_send_v6(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.claim_console_invitation_send_v6(uuid,uuid,text)
  to service_role;
revoke execute on function public.finish_console_invitation_send_v6(uuid,text,uuid,text)
  from public,anon,authenticated;
grant execute on function public.finish_console_invitation_send_v6(uuid,text,uuid,text)
  to service_role;
revoke execute on function public.mark_console_invitation_conflict_v6(uuid,text)
  from public,anon,authenticated;
grant execute on function public.mark_console_invitation_conflict_v6(uuid,text)
  to service_role;
revoke execute on function public.cancel_console_invitation_v6(uuid,text)
  from public,anon,service_role;
grant execute on function public.cancel_console_invitation_v6(uuid,text)
  to authenticated;
revoke execute on function public.resolve_console_invitation_uncertain_v6(uuid,text,text,text,text)
  from public,anon,service_role;
grant execute on function public.resolve_console_invitation_uncertain_v6(uuid,text,text,text,text)
  to authenticated;
select public.lock_down_definer_functions();
