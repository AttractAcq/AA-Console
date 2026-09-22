-- Connecting an integration did nothing.
--
-- enqueue_metrics_ingest_jobs requires status = 'active'.
-- admin_store_integration_credential never sets status, so a newly stored
-- credential takes the column default, which is 'connected'. Nothing
-- anywhere — not a migration, not the console, not the runtime, not the
-- gateway — ever writes 'active'. The only other writer is metrics_ingest
-- itself, setting 'error' on a dead credential.
--
-- So the daily pull has been filtering on a state that cannot be reached.
-- You could connect Meta, switch ingest on, and the 03:15 job would skip it
-- every morning forever, exactly as it has skipped an empty table 17 times.
-- This is why metrics_ingest has never run, and it would have stayed the
-- reason after somebody finally connected something.
--
-- Two fixes, both narrow.
--
-- 1. The enqueue function names the states that ARE reachable. An allow
--    list rather than "not error", so a future 'revoked' or 'expired' does
--    not silently become eligible by being new.
--
-- 2. Storing a credential clears 'error'. Without this, replacing a dead
--    token leaves the integration in the state its dead token put it in,
--    and the fix that should resume ingestion does not. Only the status
--    line is added; every other behaviour of that function is unchanged.

create or replace function enqueue_metrics_ingest_jobs(p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
  v_since date := current_date - greatest(coalesce(p_days, 7), 1);
  v_until date := current_date;
begin
  insert into agent_jobs (agent_key, client_id, params)
  select 'metrics_ingest',
         ci.client_id,
         jsonb_build_object('surface', s.surface, 'since', v_since, 'until', v_until)
    from client_integrations ci
    join (values ('meta', 'paid'), ('instagram', 'organic')) as s(provider, surface)
      on s.provider = ci.provider
   where ci.status in ('connected', 'active')
     and ci.ingest_enabled = true
     and ci.credential_secret_id is not null
     and not exists (
       select 1 from agent_jobs j
        where j.agent_key = 'metrics_ingest'
          and j.client_id = ci.client_id
          and j.params->>'surface' = s.surface
          and j.status in ('queued', 'claimed', 'running')
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function enqueue_metrics_ingest_jobs(integer) is
  'Enqueues a trailing-window metrics pull per client per surface, for integrations with ingest_enabled and a stored credential. meta -> paid, instagram -> organic. Eligible states are connected and active; error is excluded so a dead credential stops costing a job every morning. Pure INSERT; driven by pg_cron.';

create or replace function admin_store_integration_credential(
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
  v_row    uuid;
begin
  if not is_admin() then
    raise exception 'Admins only';
  end if;

  -- The raw credential goes to Vault and nowhere else; the table only
  -- ever holds the reference.
  v_secret := vault.create_secret(
    p_secret,
    'integration:' || p_client_id::text || ':' || p_provider || ':' || coalesce(p_label, 'default'),
    'AA Console integration credential'
  );

  insert into client_integrations (client_id, provider, credential_label, credential_secret_id, access_level)
  values (p_client_id, p_provider, p_label, v_secret, p_access_level)
  on conflict (client_id, provider, credential_label) do update
    set credential_secret_id = excluded.credential_secret_id,
        access_level = excluded.access_level,
        -- A fresh credential earns a fresh attempt. Leaving the old 'error'
        -- in place means the act of fixing a dead token does not resume the
        -- ingestion the dead token stopped.
        status = 'connected',
        updated_at = now()
  returning id into v_row;

  return v_row;
end;
$$;

comment on function admin_store_integration_credential(uuid, text, text, text, text) is
  'Admin-only. Stores an integration credential in Vault and records only its reference. Replacing a credential clears any error state, so fixing a dead token resumes ingestion.';
