-- B004 / 286: bind only the confirmed, invited Auth user ID to the target.
-- This is the sole privilege-granting path. It runs after a validated invite
-- link has produced a verified Supabase session in the runtime.
do $$ begin
  if to_regclass('public.console_invitation_send_claims_v6') is null then
    raise exception 'Apply invitation migration 285 before 286.';
  end if;
  if to_regclass('public.approval_class_coverage_versions_v6') is null then
    raise exception 'Apply approval coverage migration 279 before 286.';
  end if;
end $$;

-- Revision 2 records only what these migrations prove. The Inbox UI action
-- and a live read-back/send/accept attestation are separate release work.
insert into public.approval_class_coverage_versions_v6 (
  class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker
) values (
  34,2,'team_invitation','Controlled team invitation',
  'verified','284 frozen one-recipient auth/console_invitation card and PGlite source test',
  'blocked','285 AAL2 owning decision RPC and PGlite test; global Inbox control pending',
  'blocked','285 durable send claim and 286 Auth-ID acceptance; exact live SMTP/template/send attestation pending',
  'Global Inbox action, fresh live SMTP From/template/redirect read-back and designated send/accept remain release gates; mutable Auth templates have a dashboard-to-send race.'
);

create function public.accept_console_invitation_v6(
  p_request_id uuid, p_auth_user_id uuid, p_auth_email text
) returns public.console_invitation_requests_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_request public.console_invitation_requests_v6%rowtype;
  v_email text := lower(btrim(coalesce(p_auth_email,'')));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Trusted runtime only.' using errcode = '42501';
  end if;
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id for update;
  if not found then raise exception 'Invitation not found.' using errcode = 'P0002'; end if;
  if v_request.status = 'accepted' then
    if v_request.provider_user_id = p_auth_user_id
      and v_request.recipient_email = v_email then return v_request; end if;
    raise exception 'Invitation belongs to another user.' using errcode = '42501';
  end if;
  if v_request.status <> 'sent' or v_request.expires_at <= now()
    or v_request.provider_user_id is distinct from p_auth_user_id
    or v_request.recipient_email <> v_email then
    raise exception 'Invitation is expired, cancelled, or belongs to another user.'
      using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users
    where id = p_auth_user_id and lower(email) = v_email
      and email_confirmed_at is not null) then
    raise exception 'Confirmed Auth identity does not match the invitation.'
      using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where id = p_auth_user_id) then
    raise exception 'Existing account privilege provenance requires review.'
      using errcode = '23505';
  end if;
  if v_request.target_role = 'employee' then
    if not exists (select 1 from public.team_members
      where id = v_request.target_member_id and active and user_id is null
        and category = v_request.team_category and name = v_request.full_name
        and invitation_generation_v6 = (v_request.payload ->> 'team_member_generation')::bigint) then
      raise exception 'Roster target changed or was retired.' using errcode = '23514';
    end if;
  elsif not exists (select 1 from public.clients
    where id = v_request.target_client_id) then
    raise exception 'Client target no longer exists.' using errcode = '23514';
  end if;

  insert into public.profiles(id,role,full_name,email,employee_category)
    values (p_auth_user_id,v_request.target_role::public.app_role,
      v_request.full_name,v_email,v_request.team_category);
  if v_request.target_role = 'employee' then
    update public.team_members set user_id = p_auth_user_id
      where id = v_request.target_member_id and user_id is null and active;
    if not found then
      raise exception 'Roster target was linked concurrently.' using errcode = '23514';
    end if;
  else
    insert into public.client_users(client_id,user_id)
      values (v_request.target_client_id,p_auth_user_id);
  end if;
  update public.console_invitation_requests_v6
    set status = 'accepted', accepted_at = now() where id = p_request_id;
  insert into public.console_invitation_events_v6(
    request_id,state,actor_id,provider_user_id
  ) values (p_request_id,'accepted',p_auth_user_id,p_auth_user_id);
  select * into v_request from public.console_invitation_requests_v6
    where id = p_request_id;
  return v_request;
end;
$$;

revoke execute on function public.accept_console_invitation_v6(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.accept_console_invitation_v6(uuid,uuid,text)
  to service_role;
select public.lock_down_definer_functions();
