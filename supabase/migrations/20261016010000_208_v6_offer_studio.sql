-- Service-specific offers are immutable versions. A campaign package links
-- one approved version; a new offer edit creates a new version and package.
create table public.service_offers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  service_name text not null check (length(btrim(service_name)) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (id, client_id)
);

create table public.service_offer_versions (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null,
  client_id uuid not null,
  version integer not null check (version > 0),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 160),
  audience text not null check (length(btrim(audience)) between 1 and 2000),
  promise text not null check (length(btrim(promise)) between 1 and 4000),
  inclusions text[] not null default '{}',
  exclusions text[] not null default '{}',
  price_amount numeric check (price_amount is null or price_amount >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  delivery_cost_estimate numeric check (
    delivery_cost_estimate is null or delivery_cost_estimate >= 0),
  claims jsonb not null default '[]'::jsonb check (jsonb_typeof(claims) = 'array'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (offer_id, client_id)
    references public.service_offers(id, client_id) on delete cascade,
  check ((price_amount is null and currency is null)
    or (price_amount is not null and currency is not null)),
  unique (offer_id, version),
  unique (client_id, idempotency_key),
  unique (id, client_id)
);

create table public.service_offer_signoffs (
  offer_version_id uuid primary key,
  client_id uuid not null,
  approved_by uuid not null references public.profiles(id),
  approved_at timestamptz not null default now(),
  foreign key (offer_version_id, client_id)
    references public.service_offer_versions(id, client_id) on delete cascade
);

create table public.campaign_manifest_offers (
  manifest_id uuid primary key,
  campaign_id uuid not null,
  client_id uuid not null,
  offer_version_id uuid not null,
  linked_at timestamptz not null default now(),
  foreign key (manifest_id, campaign_id, client_id)
    references public.campaign_manifest_versions(id, campaign_id, client_id)
    on delete cascade,
  foreign key (offer_version_id, client_id)
    references public.service_offer_versions(id, client_id) on delete restrict
);

create function public.guard_service_offer_version_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'Offer versions and campaign associations are immutable. Create a new version.';
end;
$$;
create trigger service_offer_versions_immutable before update on public.service_offer_versions
  for each row execute function public.guard_service_offer_version_immutable();
create trigger service_offer_signoffs_immutable before update on public.service_offer_signoffs
  for each row execute function public.guard_service_offer_version_immutable();
create trigger campaign_manifest_offers_immutable before update on public.campaign_manifest_offers
  for each row execute function public.guard_service_offer_version_immutable();

alter table public.service_offers enable row level security;
alter table public.service_offer_versions enable row level security;
alter table public.service_offer_signoffs enable row level security;
alter table public.campaign_manifest_offers enable row level security;
create policy service_offers_read on public.service_offers for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy service_offer_versions_read on public.service_offer_versions for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy service_offer_signoffs_read on public.service_offer_signoffs for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy campaign_manifest_offers_read on public.campaign_manifest_offers for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select on public.service_offers, public.service_offer_versions,
  public.service_offer_signoffs, public.campaign_manifest_offers to authenticated;

create function public.create_service_offer_version_v6(
  p_client_id uuid, p_service_name text, p_audience text, p_promise text,
  p_inclusions text[], p_exclusions text[], p_price_amount numeric,
  p_currency text, p_delivery_cost_estimate numeric, p_claims jsonb,
  p_idempotency_key text, p_offer_id uuid default null
) returns public.service_offer_versions
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_offer public.service_offers%rowtype;
  v_version public.service_offer_versions%rowtype;
  v_hash text;
  v_claim jsonb;
begin
  if auth.role() <> 'service_role' and not (
    auth.role() = 'authenticated' and
    (coalesce(public.is_admin(), false) or
      coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false))
  ) then raise exception 'Only the client manager or an admin can draft an offer.'; end if;
  if p_service_name is null or length(btrim(p_service_name)) not between 1 and 200
     or p_audience is null or length(btrim(p_audience)) not between 1 and 2000
     or p_promise is null or length(btrim(p_promise)) not between 1 and 4000
     or p_inclusions is null or p_exclusions is null
     or p_claims is null or jsonb_typeof(p_claims) <> 'array'
     or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160
     or (p_price_amount is null) <> (p_currency is null)
     or (p_currency is not null and p_currency !~ '^[A-Z]{3}$')
     or p_price_amount < 0 or p_delivery_cost_estimate < 0 then
    raise exception 'A service, audience, promise, valid economics and request key are required.';
  end if;
  for v_claim in select * from jsonb_array_elements(p_claims) loop
    if jsonb_typeof(v_claim) <> 'object'
       or coalesce(v_claim->>'kind', '') not in ('general', 'quantified')
       or nullif(btrim(v_claim->>'text'), '') is null
       or length(v_claim->>'text') > 1000
       or (v_claim->>'kind' = 'quantified'
         and nullif(v_claim->>'proof_asset_id', '') is null) then
      raise exception 'Every claim needs a kind and text; quantified claims need proof.';
    end if;
  end loop;
  v_hash := encode(sha256(convert_to(jsonb_build_object(
    'service_name', btrim(p_service_name), 'audience', btrim(p_audience),
    'promise', btrim(p_promise), 'inclusions', p_inclusions,
    'exclusions', p_exclusions, 'price_amount', p_price_amount,
    'currency', p_currency, 'delivery_cost_estimate', p_delivery_cost_estimate,
    'claims', p_claims
  )::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    p_client_id::text || ':offer:' || btrim(p_idempotency_key), 0));
  select * into v_version from public.service_offer_versions
    where client_id = p_client_id and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_version.content_hash <> v_hash
       or (p_offer_id is not null and v_version.offer_id <> p_offer_id) then
      raise exception 'Idempotency key already belongs to a different offer version.';
    end if;
    return v_version;
  end if;
  if p_offer_id is null then
    insert into public.service_offers(client_id, service_name)
    values (p_client_id, btrim(p_service_name)) returning * into v_offer;
  else
    select * into v_offer from public.service_offers
      where id = p_offer_id and client_id = p_client_id for update;
    if not found or v_offer.service_name <> btrim(p_service_name) then
      raise exception 'Choose an offer belonging to this client with the same service name.';
    end if;
  end if;
  insert into public.service_offer_versions (
    offer_id, client_id, version, idempotency_key, audience, promise,
    inclusions, exclusions, price_amount, currency,
    delivery_cost_estimate, claims, content_hash
  ) values (
    v_offer.id, p_client_id,
    coalesce((select max(version) + 1 from public.service_offer_versions
      where offer_id = v_offer.id), 1),
    btrim(p_idempotency_key), btrim(p_audience), btrim(p_promise),
    p_inclusions, p_exclusions, p_price_amount, p_currency,
    p_delivery_cost_estimate, p_claims, v_hash
  ) returning * into v_version;
  return v_version;
end;
$$;

create function public.approve_service_offer_version_v6(p_version_id uuid)
returns public.service_offer_signoffs
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_version public.service_offer_versions%rowtype;
  v_claim jsonb;
  v_proof public.client_proof_assets%rowtype;
  v_signoff public.service_offer_signoffs%rowtype;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in human must approve this offer.';
  end if;
  select * into v_version from public.service_offer_versions where id = p_version_id;
  if not found then raise exception 'Offer version not found.'; end if;
  if not (coalesce(public.is_admin(), false) or
    coalesce(auth.uid() = public.active_video_approval_manager(v_version.client_id), false)) then
    raise exception 'Only an admin or the active client manager may approve.';
  end if;
  if exists (select 1 from public.service_offer_signoffs where offer_version_id = p_version_id) then
    raise exception 'This offer version is already approved.';
  end if;
  for v_claim in select * from jsonb_array_elements(v_version.claims) loop
    if v_claim->>'kind' = 'quantified' then
      select * into v_proof from public.client_proof_assets
        where id = (v_claim->>'proof_asset_id')::uuid;
      if not found or v_proof.client_id <> v_version.client_id
         or v_proof.usage_rights <> 'approved'
         or (v_proof.expires_on is not null and v_proof.expires_on < current_date) then
        raise exception 'A quantified claim needs current, cleared proof for this client.';
      end if;
    end if;
  end loop;
  insert into public.service_offer_signoffs(offer_version_id,client_id,approved_by)
  values (p_version_id,v_version.client_id,auth.uid()) returning * into v_signoff;
  return v_signoff;
end;
$$;

create function public.attach_campaign_offer_v6(
  p_manifest_id uuid, p_offer_version_id uuid
) returns void
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_manifest public.campaign_manifest_versions%rowtype;
  v_version public.service_offer_versions%rowtype;
  v_existing uuid;
  v_claim jsonb;
  v_proof public.client_proof_assets%rowtype;
begin
  if auth.role() <> 'service_role' and not (
    auth.role() = 'authenticated' and coalesce(public.is_admin(), false)
  ) then raise exception 'Only an admin or the internal service may link a campaign offer.'; end if;
  select * into v_manifest from public.campaign_manifest_versions where id = p_manifest_id;
  select * into v_version from public.service_offer_versions where id = p_offer_version_id;
  if v_manifest.id is null or v_version.id is null or v_manifest.client_id <> v_version.client_id
     or not exists (select 1 from public.service_offer_signoffs
       where offer_version_id = p_offer_version_id) then
    raise exception 'Choose an approved offer version belonging to this campaign client.';
  end if;
  -- Approval is permanent history; proof clearance can expire or be revoked.
  for v_claim in select * from jsonb_array_elements(v_version.claims) loop
    if v_claim->>'kind' = 'quantified' then
      select * into v_proof from public.client_proof_assets
        where id = (v_claim->>'proof_asset_id')::uuid;
      if not found or v_proof.client_id <> v_version.client_id
         or v_proof.usage_rights <> 'approved'
         or (v_proof.expires_on is not null and v_proof.expires_on < current_date) then
        raise exception 'A quantified claim needs current, cleared proof for this client.';
      end if;
    end if;
  end loop;
  if exists (select 1 from public.campaign_manifest_versions v
    where v.campaign_id = v_manifest.campaign_id and v.version > v_manifest.version) then
    raise exception 'Campaign package was superseded. Link the current package.';
  end if;
  select offer_version_id into v_existing from public.campaign_manifest_offers
    where manifest_id = p_manifest_id;
  if found then
    if v_existing <> p_offer_version_id then
      raise exception 'Campaign package already has another offer version.';
    end if;
    return;
  end if;
  insert into public.campaign_manifest_offers (
    manifest_id, campaign_id, client_id, offer_version_id
  ) values (
    v_manifest.id, v_manifest.campaign_id, v_manifest.client_id, v_version.id
  );
end;
$$;

revoke all on function public.create_service_offer_version_v6(
  uuid, text, text, text, text[], text[], numeric, text, numeric, jsonb, text, uuid
) from public, anon;
grant execute on function public.create_service_offer_version_v6(
  uuid, text, text, text, text[], text[], numeric, text, numeric, jsonb, text, uuid
) to authenticated, service_role;
revoke all on function public.approve_service_offer_version_v6(uuid)
  from public, anon, service_role;
grant execute on function public.approve_service_offer_version_v6(uuid)
  to authenticated;
revoke all on function public.attach_campaign_offer_v6(uuid, uuid)
  from public, anon;
grant execute on function public.attach_campaign_offer_v6(uuid, uuid)
  to authenticated, service_role;
