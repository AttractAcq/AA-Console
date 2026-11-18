-- Existing assignments are preserved. New or retargeted assignments must
-- reference a brief owned by their client, including general human jobs.
create function public.guard_assignment_brief_client_v7() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_client_id uuid;
begin
  if new.brief_id is null then return new; end if;
  select b.client_id into v_client_id
  from public.client_briefs b where b.id=new.brief_id for share;
  if not found or v_client_id is distinct from new.client_id then
    raise exception 'Assignment brief must belong to the assignment client.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger assignment_brief_client_v7
  before insert or update of brief_id,client_id on public.job_assignments
  for each row execute function public.guard_assignment_brief_client_v7();
revoke all on function public.guard_assignment_brief_client_v7()
  from public,anon,authenticated,service_role;

-- The shared row lock above serializes a later brief-client edit with an
-- assignment write. Refuse retargeting a brief while any assignment uses it.
create function public.guard_assigned_brief_retarget_v7() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.client_id is distinct from old.client_id and exists (
    select 1 from public.job_assignments a where a.brief_id=old.id
  ) then
    raise exception 'An assigned brief cannot move to another client.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger assigned_brief_no_retarget_v7
  before update of client_id on public.client_briefs
  for each row execute function public.guard_assigned_brief_retarget_v7();
revoke all on function public.guard_assigned_brief_retarget_v7()
  from public,anon,authenticated,service_role;
