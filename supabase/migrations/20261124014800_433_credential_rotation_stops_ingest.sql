-- Replacing an account secret is a new grant, not a continuation of the old one.
-- Stop scheduled ingest before the new secret can be used by the daily cron.
begin;
create or replace function public.admin_store_integration_credential(
  p_client_id uuid,
  p_provider text,
  p_label text,
  p_secret text,
  p_access_level text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'vault'
as $$
declare
  v_secret uuid;
  v_row uuid;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not coalesce(public.is_admin(), false) then
    raise exception 'A provisioned admin must store integration credentials.' using errcode = '42501';
  end if;
  if p_client_id is null or not exists(select 1 from public.clients where id = p_client_id)
    or nullif(btrim(coalesce(p_provider, '')), '') is null
    or nullif(btrim(coalesce(p_label, '')), '') is null
    or nullif(p_secret, '') is null then
    raise exception 'Client, provider, account label and credential are required.' using errcode = '22023';
  end if;

  v_secret := vault.create_secret(
    p_secret,
    -- Vault names are unique. A version suffix makes rotation possible and
    -- leaves the old secret reference distinct for audit/reconciliation.
    'integration:' || p_client_id::text || ':' || p_provider || ':' || p_label
      || ':' || gen_random_uuid()::text,
    'AA Console integration credential'
  );

  insert into public.client_integrations
    (client_id, provider, credential_label, credential_secret_id, access_level, ingest_enabled)
  values (p_client_id, p_provider, p_label, v_secret, p_access_level, false)
  on conflict (client_id, provider, credential_label) do update
    set credential_secret_id = excluded.credential_secret_id,
        access_level = excluded.access_level,
        status = 'connected',
        last_checked_at = null,
        ingest_enabled = false,
        updated_at = now()
  returning id into v_row;

  return v_row;
end;
$$;

comment on function public.admin_store_integration_credential(uuid, text, text, text, text) is
  'Admin-only Vault storage. A new or replaced credential stops scheduled ingest and clears prior health evidence. A new grant must be reviewed before recurring ingest resumes.';
select public.lock_down_definer_functions();
commit;
