-- A connected integration can have its token read.
--
-- integration_secret filters on `status = 'active'`. Nothing writes 'active'
-- except a successful ingest. An ingest cannot succeed without the token. So
-- a freshly connected integration can never be used, and the agent reports
-- "This client has no active meta integration" at a client who connected one
-- and can see it on the Integrations panel.
--
-- This is the same fault that was fixed in the agent on 24 September (#105),
-- in the TypeScript only. The comment left on that fix reads:
--
--   "Requiring 'active' alone meant a newly connected integration was queued
--    every morning and then refused here as 'no active integration', because
--    only a successful ingest ever writes 'active'."
--
-- That is this bug, described exactly, two weeks before it was found again --
-- and the lookup it describes is one of two. metrics_ingest finds the
-- integration, then asks this function for the secret, and this function
-- applies the filter the other one had already learned not to.
--
-- Observed on production: three connected integrations for Attract
-- Acquisition, each with a 196-character secret in the Vault, and
-- integration_secret returning null for all three. The 03:15 cron ran on 5
-- and 6 October and failed four jobs on it.
--
-- 'connected' and 'active' are the two states the scheduler enqueues from
-- (migration 124), so they are the two this accepts. An integration in
-- 'error' or 'expiring' is deliberately still refused: those mean the token
-- is known not to work, which is a different thing from not having been used
-- yet.

create or replace function public.integration_secret(p_client_id uuid, p_provider text)
returns text
language plpgsql
security definer
set search_path to 'public', 'vault'
as $function$
declare
  v_secret_id uuid;
  v_value     text;
begin
  select credential_secret_id into v_secret_id
    from client_integrations
   where client_id = p_client_id
     and provider = p_provider
     -- See the note above. 'connected' is an integration that has been set up
     -- and not yet used; 'active' is one that has worked. Both can be read.
     and status in ('connected', 'active');

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_value
    from vault.decrypted_secrets
   where id = v_secret_id;

  return v_value;
end;
$function$;

comment on function public.integration_secret(uuid, text) is
  'The stored token for a client''s integration, for a connected or active one. Refuses error and expiring states, where the token is known not to work.';
