-- The switch 218 added a column for and no way to turn.
--
-- `client_engine_settings.proof_publishing_enabled` has existed since 218 and
-- defaults to false for every client, which is the right state to ship in.
-- What it did not have was a setter, so the only way to turn it on was an
-- admin writing the column directly — which leaves out the assigned client
-- manager, and leaves out the record of who decided.
--
-- Modelled on set_publishing_enabled from 160, including the part that keeps
-- the stamp on the way off: who turned it on is worth more than when it was
-- last turned off, and losing that is how "nobody knows why this client is
-- live" happens.
--
-- Separate from set_publishing_enabled on purpose, as the columns are.
-- Posting on a client's own feed and putting their customer's words on a
-- third-party profile are different promises, and one function with a flag
-- would make them one decision.

alter table client_engine_settings
  add column if not exists proof_publishing_enabled_at timestamptz,
  add column if not exists proof_publishing_enabled_by uuid references public.profiles(id) on delete set null;

create or replace function public.set_proof_publishing_enabled(
  p_client_id uuid, p_enabled boolean)
returns client_engine_settings
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_row client_engine_settings;
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client' using errcode = 'P0001';
  end if;

  insert into client_engine_settings (client_id, proof_publishing_enabled,
                                      proof_publishing_enabled_at, proof_publishing_enabled_by)
  values (p_client_id, p_enabled,
          case when p_enabled then now() end,
          case when p_enabled then auth.uid() end)
  on conflict (client_id) do update
     set proof_publishing_enabled = excluded.proof_publishing_enabled,
         proof_publishing_enabled_at = case when excluded.proof_publishing_enabled
                                            then coalesce(client_engine_settings.proof_publishing_enabled_at, now())
                                            else client_engine_settings.proof_publishing_enabled_at end,
         proof_publishing_enabled_by = case when excluded.proof_publishing_enabled
                                            then coalesce(client_engine_settings.proof_publishing_enabled_by, auth.uid())
                                            else client_engine_settings.proof_publishing_enabled_by end
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.set_proof_publishing_enabled(uuid, boolean) is
  'Turn proof distribution on or off for one client. Distinct from set_publishing_enabled: posting on a client''s own feed and putting their customer''s words on somebody else''s profile are different promises.';

revoke all on function public.set_proof_publishing_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_proof_publishing_enabled(uuid, boolean) to authenticated;

select lock_down_definer_functions();
