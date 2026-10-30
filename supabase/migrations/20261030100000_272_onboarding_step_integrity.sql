-- 272 · A client's onboarding checklist belongs to one client for life.
-- Migration 07 let a client update its own row with WITH CHECK (true), which
-- allowed a direct API UPDATE to move that row to a different client. The
-- table-level UPDATE grant also exposed step identity and display fields.
-- Keep the intended client action: completing or reopening its own form.

drop policy if exists cos_client_update on public.client_onboarding_steps;
create policy cos_client_update on public.client_onboarding_steps
  for update to authenticated
  using (
    step_key = 'onboarding_form'
    and exists (
      select 1 from public.client_users cu
       where cu.user_id = auth.uid()
         and cu.client_id = client_onboarding_steps.client_id
    )
  )
  with check (
    step_key = 'onboarding_form'
    and exists (
      select 1 from public.client_users cu
       where cu.user_id = auth.uid()
         and cu.client_id = client_onboarding_steps.client_id
    )
  );

-- RLS controls which existing and resulting rows a client may write. A
-- trigger checks OLD against NEW so even a user who belongs to two clients
-- cannot move a checklist step between them or rewrite its identity. The
-- guard applies to service/admin writers too; a moved step is a new step,
-- not a permissible update of the old one.
create function public.guard_client_onboarding_step_update()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.id is distinct from old.id
     or new.client_id is distinct from old.client_id
     or new.step_key is distinct from old.step_key
     or new.created_at is distinct from old.created_at then
    raise exception 'An onboarding step cannot change identity or client.'
      using errcode = '23514';
  end if;

  -- An admin may maintain checklist labels and order. A client may only
  -- change the state of its own form, with server-authored completion fields.
  if auth.role() = 'authenticated' and not coalesce(public.is_admin(), false) then
    if old.step_key <> 'onboarding_form'
       or new.title is distinct from old.title
       or new.display_order is distinct from old.display_order then
      raise exception 'A client may only update its own onboarding form status.'
        using errcode = '42501';
    end if;
    if new.status is not distinct from old.status then
      if new.completed_by is distinct from old.completed_by
         or new.completed_at is distinct from old.completed_at then
        raise exception 'Completion fields cannot be edited without a status change.'
          using errcode = '42501';
      end if;
      return new;
    end if;
    if new.completed_by is distinct from old.completed_by
       and new.completed_by is distinct from auth.uid() then
      raise exception 'A client cannot attribute completion to another person.'
        using errcode = '42501';
    end if;
    if new.status = 'complete'::public.step_status then
      new.completed_by := auth.uid();
      new.completed_at := now();
    else
      new.completed_by := null;
      new.completed_at := null;
    end if;
  end if;
  return new;
end;
$$;

create trigger cos_protect_identity_and_completion
  before update on public.client_onboarding_steps
  for each row execute function public.guard_client_onboarding_step_update();

revoke execute on function public.guard_client_onboarding_step_update()
  from public, anon, authenticated;
select public.lock_down_definer_functions();
