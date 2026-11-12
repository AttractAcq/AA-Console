-- The compiler needs kind on the offer row and a version in one transaction.
-- A separate REST insert left an unversioned offer on every failed job attempt.
create function public.create_compiled_service_offer_v6(
  p_client_id uuid, p_kind text, p_service_name text, p_audience text,
  p_promise text, p_inclusions text[], p_exclusions text[],
  p_price_amount numeric, p_currency text, p_delivery_cost_estimate numeric,
  p_claims jsonb, p_idempotency_key text
) returns public.service_offer_versions
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_offer_id uuid;
  v_existing_kind text;
  v_version public.service_offer_versions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service can compile an offer.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('main', 'secondary') then
    raise exception 'An offer is a main offer or a secondary offer.';
  end if;

  -- The underlying version writer checks the content hash for an existing
  -- idempotency key. Lock before checking so concurrent retries cannot make
  -- two offer rows. A failed version write rolls back the offer insert too.
  perform pg_advisory_xact_lock(hashtextextended(
    p_client_id::text || ':offer:' || btrim(p_idempotency_key), 0));
  select o.kind into v_existing_kind
    from public.service_offer_versions v
    join public.service_offers o on o.id = v.offer_id and o.client_id = v.client_id
    where v.client_id = p_client_id and v.idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing_kind <> p_kind then
      raise exception 'Idempotency key already belongs to a different offer kind.';
    end if;
    return public.create_service_offer_version_v6(
      p_client_id, p_service_name, p_audience, p_promise,
      p_inclusions, p_exclusions, p_price_amount, p_currency,
      p_delivery_cost_estimate, p_claims, p_idempotency_key, null);
  end if;

  insert into public.service_offers(client_id, kind, service_name)
  values (p_client_id, p_kind, btrim(p_service_name))
  returning id into v_offer_id;

  v_version := public.create_service_offer_version_v6(
    p_client_id, p_service_name, p_audience, p_promise,
    p_inclusions, p_exclusions, p_price_amount, p_currency,
    p_delivery_cost_estimate, p_claims, p_idempotency_key, v_offer_id);
  return v_version;
end;
$$;

revoke all on function public.create_compiled_service_offer_v6(
  uuid, text, text, text, text, text[], text[], numeric, text, numeric, jsonb, text
) from public, anon, authenticated;
grant execute on function public.create_compiled_service_offer_v6(
  uuid, text, text, text, text, text[], text[], numeric, text, numeric, jsonb, text
) to service_role;

select public.lock_down_definer_functions();
