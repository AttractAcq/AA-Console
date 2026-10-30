-- B008: a recruitment brief is reviewed from its complete database snapshot.
-- Approval remains the owning brief transition; no ad build or external
-- distribution switch is enabled by this migration.

begin;

-- The operational columns change when generation starts. Every other brief
-- column, including all copy, role, destination, format and provenance, is
-- part of the version the human sees and approves.
create function public.recruitment_brief_snapshot_v6(
  p_brief public.client_briefs
) returns jsonb language sql stable
set search_path = pg_catalog, public as $$
  select to_jsonb(p_brief) - 'status' - 'updated_at' - 'job_id'
    - 'production_method' - 'archived_at';
$$;

create function public.recruitment_brief_snapshot_hash_v6(
  p_brief public.client_briefs
) returns text language sql stable
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    public.recruitment_brief_snapshot_v6(p_brief)::text, 'UTF8')), 'hex');
$$;

-- Called by the INSERT trigger and the explicit re-request RPC. A changed
-- draft gets a new immutable card; an unchanged active card is idempotent.
-- After expiry, the next request gets a new round without mutating history.
create function public.register_recruitment_brief_inbox_v6(
  p_brief public.client_briefs
) returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_hash text;
  v_existing uuid;
  v_round integer;
  v_blocker text;
begin
  if p_brief.id is null or p_brief.purpose is distinct from 'recruitment'
    or p_brief.status is distinct from 'draft'
    or p_brief.archived_at is not null
    or not exists (select 1 from public.clients c where c.id = p_brief.client_id
      and c.is_internal and lower(c.name) = 'attract acquisition') then
    raise exception 'Only an active draft on the Attract Acquisition house client can request recruitment approval.'
      using errcode = '23514';
  end if;
  v_hash := public.recruitment_brief_snapshot_hash_v6(p_brief);
  if p_brief.media_type <> 'image' or p_brief.recruitment_role is null
    or nullif(btrim(p_brief.title), '') is null
    or nullif(btrim(coalesce(p_brief.hook, '')), '') is null
    or nullif(btrim(coalesce(p_brief.script, '')), '') is null
    or nullif(btrim(coalesce(p_brief.call_to_action, '')), '') is null
    or p_brief.apply_url is null or p_brief.apply_url !~* '^https://' then
    v_blocker := 'Complete Meta-static recruitment copy, role and HTTPS application URL are required.';
  end if;
  select r.id into v_existing from public.approval_requests_v6 r
    where r.source_system = 'aa_console' and r.source_kind = 'recruitment_brief'
      and r.source_id = p_brief.id::text and r.artifact_hash = v_hash
      and r.expires_at > now()
      and not exists (select 1 from public.approval_decision_events_v6 d
        where d.request_id = r.id)
    order by r.requested_at desc, r.id desc limit 1;
  if v_existing is not null then return v_existing; end if;

  select count(*)::integer + 1 into v_round from public.approval_requests_v6 r
    where r.source_system = 'aa_console' and r.source_kind = 'recruitment_brief'
      and r.source_id = p_brief.id::text;
  return public.register_approval_request_v6(jsonb_build_object(
    'client_id', p_brief.client_id,
    'source_system', 'aa_console',
    'source_kind', 'recruitment_brief',
    'source_id', p_brief.id::text,
    'source_version', v_hash || ':v' || v_round::text,
    'title', 'Recruitment brief: ' || p_brief.title,
    'artifact_hash', v_hash,
    'preview', public.recruitment_brief_snapshot_v6(p_brief),
    'destination', 'internal:recruitment_ad_generation',
    'account_ref', null,
    'budget', null,
    'scope', jsonb_build_object(
      'purpose', 'recruitment', 'recruitment_role', p_brief.recruitment_role,
      'media_type', p_brief.media_type, 'apply_url', p_brief.apply_url),
    'owner_role', 'admin',
    'expires_at', now() + interval '7 days',
    'preview_blocker', v_blocker,
    'owning_path', '/team?tab=recruitment'
  ));
end;
$$;

create function public.register_new_recruitment_brief_inbox_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.purpose = 'recruitment' and new.status = 'draft' then
    perform public.register_recruitment_brief_inbox_v6(new);
  end if;
  return new;
end;
$$;
create trigger recruitment_brief_inbox_request_v6
  after insert on public.client_briefs
  for each row execute function public.register_new_recruitment_brief_inbox_v6();

create function public.request_recruitment_brief_approval_v6(p_brief_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_brief public.client_briefs%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not coalesce(public.is_admin(), false) then
    raise exception 'Only a provisioned admin may request recruitment brief approval.'
      using errcode = '42501';
  end if;
  select * into v_brief from public.client_briefs where id = p_brief_id for update;
  if not found then raise exception 'Recruitment brief not found.' using errcode = 'P0002'; end if;
  return public.register_recruitment_brief_inbox_v6(v_brief);
end;
$$;

-- A draft may be revised, but then its prior exact-version card cannot sign
-- the new words. Once approved, the approved copy is immutable; status and
-- operational generation fields may still advance normally.
create function public.guard_recruitment_brief_version_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if old.purpose = 'recruitment' or new.purpose = 'recruitment' then
    if new.purpose is distinct from old.purpose then
      raise exception 'Create a new brief to change recruitment purpose.' using errcode = '23514';
    end if;
    if old.status = 'draft' and new.status not in ('draft', 'approved') then
      raise exception 'Approve the exact recruitment brief before production.' using errcode = '23514';
    end if;
    if old.status in ('approved', 'in_production', 'complete')
      and new.status in ('draft', 'rejected') then
      raise exception 'Approved recruitment briefs cannot return to draft or rejected state.'
        using errcode = '23514';
    end if;
    if (old.status <> 'draft' or new.status <> 'draft')
      and public.recruitment_brief_snapshot_v6(new)
        is distinct from public.recruitment_brief_snapshot_v6(old) then
      raise exception 'Approved recruitment brief content is immutable; create a new version.'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger recruitment_brief_version_guard_v6
  before update on public.client_briefs
  for each row execute function public.guard_recruitment_brief_version_v6();

-- Even a privileged direct status UPDATE must record the same AAL2 human
-- decision, or the entire source transaction rolls back.
create function public.record_recruitment_brief_inbox_decision_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_hash text;
  v_request_id uuid;
begin
  if old.purpose = 'recruitment' and old.status = 'draft'
    and new.status = 'approved' then
    if old.archived_at is not null or new.archived_at is not null then
      raise exception 'An archived recruitment draft cannot be approved.'
        using errcode = '23514';
    end if;
    if new.media_type <> 'image' or new.recruitment_role is null
      or nullif(btrim(new.title), '') is null
      or nullif(btrim(coalesce(new.hook, '')), '') is null
      or nullif(btrim(coalesce(new.script, '')), '') is null
      or nullif(btrim(coalesce(new.call_to_action, '')), '') is null
      or new.apply_url is null or new.apply_url !~* '^https://' then
      raise exception 'The complete Meta-static recruitment brief must be reviewed.'
        using errcode = '23514';
    end if;
    v_hash := public.recruitment_brief_snapshot_hash_v6(old);
    select r.id into v_request_id from public.approval_requests_v6 r
      where r.source_system = 'aa_console' and r.source_kind = 'recruitment_brief'
        and r.source_id = old.id::text and r.artifact_hash = v_hash
        and r.expires_at > now()
      order by r.requested_at desc, r.id desc limit 1;
    if v_request_id is null then
      raise exception 'Recruitment brief changed or its approval expired; request a new exact-version review.'
        using errcode = '23514';
    end if;
    perform public.record_approval_decision_v6(
      v_request_id, 'approved', v_hash,
      'client_briefs:' || old.id::text || ':approved', null);
  end if;
  return new;
end;
$$;
create trigger recruitment_brief_inbox_decision_v6
  after update of status on public.client_briefs
  for each row execute function public.record_recruitment_brief_inbox_decision_v6();

create or replace function public.approve_recruitment_brief(p_brief_id uuid)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare
  v_brief public.client_briefs%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not coalesce(public.is_admin(), false)
    or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'A provisioned human admin with AAL2 must approve the recruitment brief.'
      using errcode = '42501';
  end if;
  select * into v_brief from public.client_briefs where id = p_brief_id for update;
  if not found then raise exception 'That brief does not exist.' using errcode = 'P0002'; end if;
  if v_brief.purpose <> 'recruitment' then
    raise exception 'That is not a recruitment brief.' using errcode = '23514';
  end if;
  if v_brief.status <> 'draft' then
    raise exception 'Only a draft recruitment brief can be approved.' using errcode = '23514';
  end if;
  if v_brief.archived_at is not null then
    raise exception 'An archived recruitment draft cannot be approved.' using errcode = '23514';
  end if;
  update public.client_briefs set status = 'approved' where id = p_brief_id;
end;
$$;

-- Existing draft requests become visible without inventing historical human
-- sign-offs for briefs already approved before this migration.
do $$
declare v_brief public.client_briefs%rowtype;
begin
  for v_brief in select b.* from public.client_briefs b
    where b.purpose = 'recruitment' and b.status = 'draft'
      and b.archived_at is null
    order by b.created_at, b.id
  loop
    perform public.register_recruitment_brief_inbox_v6(v_brief);
  end loop;
end;
$$;

revoke all on function public.recruitment_brief_snapshot_v6(public.client_briefs)
  from public, anon, authenticated, service_role;
revoke all on function public.recruitment_brief_snapshot_hash_v6(public.client_briefs)
  from public, anon, authenticated, service_role;
revoke all on function public.register_recruitment_brief_inbox_v6(public.client_briefs)
  from public, anon, authenticated, service_role;
revoke all on function public.register_new_recruitment_brief_inbox_v6()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_recruitment_brief_version_v6()
  from public, anon, authenticated, service_role;
revoke all on function public.record_recruitment_brief_inbox_decision_v6()
  from public, anon, authenticated, service_role;
revoke all on function public.request_recruitment_brief_approval_v6(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.request_recruitment_brief_approval_v6(uuid)
  to authenticated;
revoke all on function public.approve_recruitment_brief(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_recruitment_brief(uuid)
  to authenticated;

select public.lock_down_definer_functions();

commit;
