-- B005: named human actions own their decisions; low-level writers do not.
-- 161 and 166 granted authenticated direct EXECUTE on these SECURITY DEFINER
-- state machines. Client scope alone cannot distinguish a maker from the
-- reviewer or a QA result from a person choosing a transition.
revoke execute on function public.advance_slot(
  uuid, public.slot_stage, text, text, text, uuid, numeric,
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
revoke execute on function public.advance_assignment(
  uuid, public.assignment_stage, text, text, uuid
) from public, anon, authenticated;

-- The predicates are internal to the state machines and their named wrappers.
-- Neither console calls them as an RPC. Keep service-role execution explicit.
revoke execute on function public.may_advance_slot(uuid)
  from public, anon, authenticated;
revoke execute on function public.may_touch_assignment(uuid)
  from public, anon, authenticated;
grant execute on function public.advance_slot(
  uuid, public.slot_stage, text, text, text, uuid, numeric,
  uuid, uuid, uuid, uuid, text
) to service_role;
grant execute on function public.advance_assignment(
  uuid, public.assignment_stage, text, text, uuid
) to service_role;
grant execute on function public.may_advance_slot(uuid) to service_role;
grant execute on function public.may_touch_assignment(uuid) to service_role;

-- An assignment and its delivered asset must refer to the same client. The
-- 166 writer accepted any existing asset ID, and its review trigger matched
-- by asset ID without a client join. Refuse to install this guard until any
-- existing mismatches have been reviewed and repaired explicitly.
do $check$
begin
  if exists (
    select 1 from public.job_assignments j
    join public.client_media_assets a on a.id = j.asset_id
    where j.asset_id is not null
      and a.client_id is distinct from j.client_id
  ) then
    raise exception 'Existing assignment asset/client mismatch requires reviewed repair before migration 264';
  end if;
end
$check$;

create or replace function public.guard_assignment_asset_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.asset_id is not null and not exists (
    select 1 from public.client_media_assets a
    where a.id = new.asset_id and a.client_id = new.client_id
  ) then
    raise exception 'Assignment asset must belong to the assignment client'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists ja_asset_client_guard on public.job_assignments;
create trigger ja_asset_client_guard
before insert or update of asset_id, client_id on public.job_assignments
for each row execute function public.guard_assignment_asset_client();

revoke execute on function public.guard_assignment_asset_client()
  from public, anon, authenticated;

-- Preserve the relationship if an attached asset is later edited. The first
-- guard covers assignment writes; this one covers asset client reassignment.
create or replace function public.guard_asset_assignment_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.client_id is distinct from old.client_id and exists (
    select 1 from public.job_assignments j
    where j.asset_id = new.id and j.client_id is distinct from new.client_id
  ) then
    raise exception 'An assigned asset cannot move to another client'
      using errcode = '23514';
  end if;
  return new;
end
$function$;

drop trigger if exists cma_assignment_client_guard on public.client_media_assets;
create trigger cma_assignment_client_guard
before update of client_id on public.client_media_assets
for each row execute function public.guard_asset_assignment_client();

revoke execute on function public.guard_asset_assignment_client()
  from public, anon, authenticated;
