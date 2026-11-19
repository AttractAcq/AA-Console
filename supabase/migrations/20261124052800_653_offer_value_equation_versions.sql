-- Manual-first offers store the value equation on the immutable version that
-- the Inbox reviews. Legacy versions keep NULL and their original preview.
begin;

create function public.valid_offer_value_equation_v9(p_value jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog,public as $$
declare field text; item jsonb;
begin
  if p_value is null or jsonb_typeof(p_value)<>'object' then return false; end if;
  for field in select unnest(array[
    'dream_outcome','dream_outcome_boost','likelihood','likelihood_mechanism',
    'time_delay','effort_sacrifice'
  ]) loop
    if jsonb_typeof(p_value->field) is distinct from 'string'
      or nullif(btrim(coalesce(p_value->>field,'')),'') is null
      or length(p_value->>field)>2000 then return false; end if;
  end loop;
  for field in select unnest(array[
    'risk_reversal','scarcity','urgency','delivery_limits'
  ]) loop
    if p_value ? field and jsonb_typeof(p_value->field) not in ('string','null')
      then return false; end if;
    if length(coalesce(p_value->>field,''))>2000 then return false; end if;
  end loop;
  for field in select unnest(array['delay_reduction_steps','effort_reduction_steps']) loop
    if jsonb_typeof(p_value->field) is distinct from 'array'
      or jsonb_array_length(p_value->field) not between 1 and 10 then return false; end if;
    for item in select value from jsonb_array_elements(p_value->field) loop
      if jsonb_typeof(item)<>'string' or nullif(btrim(item#>>'{}'),'') is null
        or length(item#>>'{}')>1000 then return false; end if;
    end loop;
  end loop;
  if jsonb_typeof(p_value->'bonuses') is distinct from 'array'
    or jsonb_array_length(p_value->'bonuses')>5 then return false; end if;
  for item in select value from jsonb_array_elements(p_value->'bonuses') loop
    if jsonb_typeof(item)<>'object'
      or nullif(btrim(coalesce(item->>'name','')),'') is null
      or length(item->>'name')>200
      or nullif(btrim(coalesce(item->>'value','')),'') is null
      or length(item->>'value')>1000
      or (item ? 'delivery_limit' and jsonb_typeof(item->'delivery_limit') not in ('string','null'))
      or length(coalesce(item->>'delivery_limit',''))>1000 then return false; end if;
  end loop;
  for field in select jsonb_object_keys(p_value) loop
    if field not in ('dream_outcome','dream_outcome_boost','likelihood',
      'likelihood_mechanism','time_delay','delay_reduction_steps',
      'effort_sacrifice','effort_reduction_steps','risk_reversal',
      'bonuses','scarcity','urgency','delivery_limits') then return false; end if;
  end loop;
  return true;
end $$;

alter table public.service_offer_versions
  add column value_equation jsonb;
alter table public.service_offer_versions
  add constraint service_offer_value_equation_v9_check
  check (value_equation is null or public.valid_offer_value_equation_v9(value_equation));

-- The v6 writer remains available for existing workers. This writer requires a
-- source-bound offer and includes every new field in its exact content hash.
create function public.create_service_offer_version_v9(
  p_offer_id uuid, p_client_id uuid, p_service_name text,
  p_audience text, p_promise text, p_inclusions text[], p_exclusions text[],
  p_price_amount numeric, p_currency text, p_delivery_cost_estimate numeric,
  p_claims jsonb, p_value_equation jsonb, p_idempotency_key text
) returns public.service_offer_versions
language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare offer_row public.service_offers%rowtype;
  result public.service_offer_versions%rowtype;
  content_digest text; claim jsonb;
begin
  if auth.role() is distinct from 'service_role' and not (
    auth.role() = 'authenticated' and auth.uid() is not null and
    (coalesce(public.is_admin(),false) or
      coalesce(auth.uid()=public.active_video_approval_manager(p_client_id),false))) then
    raise exception 'Only the client manager or an admin can draft an offer.'
      using errcode='42501'; end if;
  if p_offer_id is null or p_client_id is null
    or p_service_name is null or length(btrim(p_service_name)) not between 1 and 200
    or p_audience is null or length(btrim(p_audience)) not between 1 and 2000
    or p_promise is null or length(btrim(p_promise)) not between 1 and 4000
    or p_inclusions is null or p_exclusions is null
    or p_claims is null or jsonb_typeof(p_claims)<>'array'
    or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160
    or (p_price_amount is null)<>(p_currency is null)
    or (p_currency is not null and p_currency !~ '^[A-Z]{3}$')
    or p_price_amount<0 or p_delivery_cost_estimate<0
    or not public.valid_offer_value_equation_v9(p_value_equation) then
    raise exception 'Complete the offer value equation, service, audience, promise and valid economics.'
      using errcode='22023'; end if;
  for claim in select value from jsonb_array_elements(p_claims) loop
    if jsonb_typeof(claim)<>'object'
      or coalesce(claim->>'kind','') not in ('general','quantified')
      or nullif(btrim(claim->>'text'),'') is null
      or length(claim->>'text')>1000
      or (claim->>'kind'='quantified' and nullif(claim->>'proof_asset_id','') is null) then
      raise exception 'Every claim needs a kind and text; quantified claims need proof.'
        using errcode='22023'; end if;
  end loop;
  content_digest:=encode(sha256(convert_to(jsonb_build_object(
    'service_name',btrim(p_service_name),'audience',btrim(p_audience),
    'promise',btrim(p_promise),'inclusions',p_inclusions,'exclusions',p_exclusions,
    'price_amount',p_price_amount,'currency',p_currency,
    'delivery_cost_estimate',p_delivery_cost_estimate,'claims',p_claims,
    'value_equation',p_value_equation)::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    p_client_id::text||':offer:'||btrim(p_idempotency_key),0));
  select * into result from public.service_offer_versions
    where client_id=p_client_id and idempotency_key=btrim(p_idempotency_key);
  if found then
    if result.content_hash<>content_digest or result.offer_id<>p_offer_id then
      raise exception 'Idempotency key already belongs to another offer version.'
        using errcode='23505'; end if;
    return result;
  end if;
  select * into offer_row from public.service_offers
    where id=p_offer_id and client_id=p_client_id for update;
  if not found or offer_row.service_name<>btrim(p_service_name) then
    raise exception 'Choose a source-bound offer with the same business service.'
      using errcode='23514'; end if;
  if (offer_row.kind='secondary' and not coalesce(public.secondary_offer_source_current_v7(offer_row.id),false))
    or (offer_row.kind='main' and (not exists(select 1 from public.main_offer_sources_v7 s
      where s.offer_id=offer_row.id) or not coalesce(public.main_offer_source_current_v7(offer_row.id),false))) then
    raise exception 'The offer source changed or has not been reviewed; choose a current source.'
      using errcode='23514'; end if;
  insert into public.service_offer_versions(
    offer_id,client_id,version,idempotency_key,audience,promise,
    inclusions,exclusions,price_amount,currency,delivery_cost_estimate,
    claims,value_equation,content_hash)
  values(offer_row.id,p_client_id,
    coalesce((select max(v.version)+1 from public.service_offer_versions v
      where v.offer_id=offer_row.id),1),
    btrim(p_idempotency_key),btrim(p_audience),btrim(p_promise),
    p_inclusions,p_exclusions,p_price_amount,p_currency,p_delivery_cost_estimate,
    p_claims,p_value_equation,content_digest)
  returning * into result;
  return result;
end $$;

-- Existing previews remain byte-equivalent because legacy value_equation is
-- NULL. New drafts carry the full structured value equation into exact review.
create or replace function public.service_offer_approval_preview_v6(
  p_version public.service_offer_versions
) returns jsonb language sql stable set search_path=pg_catalog,public as $$
  select jsonb_build_object(
    'offer_id',p_version.offer_id,'offer_version_id',p_version.id,
    'client_id',p_version.client_id,'version',p_version.version,
    'service_name',o.service_name,'audience',p_version.audience,
    'promise',p_version.promise,'inclusions',p_version.inclusions,
    'exclusions',p_version.exclusions,'price_amount',p_version.price_amount,
    'currency',p_version.currency,'delivery_cost_estimate',p_version.delivery_cost_estimate,
    'claims',p_version.claims)
    || case when p_version.value_equation is null then '{}'::jsonb
      else jsonb_build_object('value_equation',p_version.value_equation) end
    || case when o.kind='secondary' then jsonb_build_object(
      'kind',o.kind,'source_opportunity_id',secondary.opportunity_id,
      'source_opportunity_hash',secondary.opportunity_hash,
      'source_opportunity_snapshot',secondary.opportunity_snapshot)
      when main.offer_id is not null then jsonb_build_object(
      'kind','main','strategy_hash',main.strategy_hash,
      'strategy_snapshot',main.strategy_snapshot)
      else '{}'::jsonb end
  from public.service_offers o
  left join public.secondary_offer_sources_v7 secondary on secondary.offer_id=o.id
  left join public.main_offer_sources_v7 main on main.offer_id=o.id
  where o.id=p_version.offer_id and o.client_id=p_version.client_id;
$$;


-- Source and job checks remain inside these atomic compiler writers.
create function public.create_compiled_secondary_offer_v10(
  p_client_id uuid,p_opportunity_id uuid,p_opportunity_hash text,p_job_id uuid,
  p_service_name text,p_audience text,p_promise text,p_inclusions text[],
  p_exclusions text[],p_idempotency_key text,p_value_equation jsonb
) returns public.service_offer_versions language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare o public.market_opportunities%rowtype; j public.agent_jobs%rowtype;
  existing public.service_offer_versions%rowtype; offer_id uuid;
  result public.service_offer_versions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service can compile an offer.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_client_id::text||':offer:'||btrim(p_idempotency_key),0));
  select * into existing from public.service_offer_versions
    where client_id=p_client_id and idempotency_key=btrim(p_idempotency_key);
  if found then
    if not exists(select 1 from public.secondary_offer_sources_v7 s
      where s.offer_id=existing.offer_id and s.opportunity_id=p_opportunity_id
        and s.opportunity_hash=p_opportunity_hash and s.compile_job_id=p_job_id) then
      raise exception 'The idempotency key belongs to a different source.' using errcode='23514'; end if;
    return public.create_service_offer_version_v9(
      existing.offer_id,p_client_id,p_service_name,p_audience,p_promise,
      p_inclusions,p_exclusions,null,null,null,'[]'::jsonb,
      p_value_equation,p_idempotency_key);
  end if;
  select * into j from public.agent_jobs where id=p_job_id and client_id=p_client_id
    and agent_key='offer_compile' and input_table='market_opportunities'
    and input_id=p_opportunity_id and params->>'kind'='secondary'
    and params->>'source'='micro_niche'
    and params->>'opportunity_hash'=p_opportunity_hash;
  if not found then raise exception 'The compile job has no matching source.' using errcode='23514'; end if;
  if j.params ? 'service_name' and j.params->>'service_name' is distinct from btrim(p_service_name) then
    raise exception 'The compiled service differs from the operator selection.' using errcode='23514'; end if;
  select * into o from public.market_opportunities
    where id=p_opportunity_id and client_id=p_client_id for share;
  if not found or not public.opportunity_approval_current_v6(o.id)
    or public.opportunity_approval_hash_v6(o.id) is distinct from p_opportunity_hash then
    raise exception 'The opportunity evidence changed or is no longer approved. Recompile.'
      using errcode='23514'; end if;
  insert into public.service_offers(client_id,kind,service_name)
    values(p_client_id,'secondary',btrim(p_service_name)) returning id into offer_id;
  insert into public.secondary_offer_sources_v7
    (offer_id,client_id,opportunity_id,opportunity_hash,opportunity_snapshot,compile_job_id)
    values(offer_id,p_client_id,o.id,p_opportunity_hash,
      public.opportunity_approval_preview_v6(o.id),p_job_id);
  perform public.link_opportunity_v6(o.id,'offer',offer_id);
  result:=public.create_service_offer_version_v9(
    offer_id,p_client_id,p_service_name,p_audience,p_promise,
    p_inclusions,p_exclusions,null,null,null,'[]'::jsonb,
    p_value_equation,p_idempotency_key);
  return result;
end $$;
revoke all on function public.create_compiled_secondary_offer_v10(
  uuid,uuid,text,uuid,text,text,text,text[],text[],text,jsonb) from public,anon,authenticated;
grant execute on function public.create_compiled_secondary_offer_v10(
  uuid,uuid,text,uuid,text,text,text,text[],text[],text,jsonb) to service_role;

create function public.create_compiled_main_offer_v10(
  p_client_id uuid,p_strategy_snapshot jsonb,p_job_id uuid,
  p_service_name text,p_audience text,p_promise text,p_inclusions text[],
  p_exclusions text[],p_idempotency_key text,p_value_equation jsonb
) returns public.service_offer_versions language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare j public.agent_jobs%rowtype; existing public.service_offer_versions%rowtype;
  current_snapshot jsonb; offer_id uuid; result public.service_offer_versions%rowtype;
  v_strategy_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the internal service can compile an offer.' using errcode='42501'; end if;
  if p_strategy_snapshot is null or jsonb_typeof(p_strategy_snapshot)<>'array' then
    raise exception 'A reviewed Strategy snapshot is required.' using errcode='23514'; end if;
  v_strategy_hash:=encode(sha256(convert_to(p_strategy_snapshot::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    p_client_id::text||':offer:'||btrim(p_idempotency_key),0));
  select * into existing from public.service_offer_versions
    where client_id=p_client_id and idempotency_key=btrim(p_idempotency_key);
  if found then
    if not exists(select 1 from public.main_offer_sources_v7 s
      where s.offer_id=existing.offer_id and s.compile_job_id=p_job_id
        and s.strategy_hash=v_strategy_hash and s.strategy_snapshot=p_strategy_snapshot) then
      raise exception 'The idempotency key belongs to a different Strategy source.'
        using errcode='23514'; end if;
    return public.create_service_offer_version_v9(
      existing.offer_id,p_client_id,p_service_name,p_audience,p_promise,
      p_inclusions,p_exclusions,null,null,null,'[]'::jsonb,
      p_value_equation,p_idempotency_key);
  end if;
  select * into j from public.agent_jobs where id=p_job_id and client_id=p_client_id
    and agent_key='offer_compile' and params->>'kind'='main'
    and params->>'source'='strategy';
  if not found then raise exception 'The compile job has no matching Strategy source.'
    using errcode='23514'; end if;
  if j.params ? 'service_name' and j.params->>'service_name' is distinct from btrim(p_service_name) then
    raise exception 'The compiled service differs from the operator selection.' using errcode='23514'; end if;
  current_snapshot:=public.reviewed_offer_strategy_snapshot_v7(p_client_id);
  if current_snapshot is distinct from p_strategy_snapshot then
    raise exception 'Offer Strategy changed during compilation. Recompile.'
      using errcode='23514'; end if;
  insert into public.service_offers(client_id,kind,service_name)
    values(p_client_id,'main',btrim(p_service_name)) returning id into offer_id;
  insert into public.main_offer_sources_v7
    (offer_id,client_id,strategy_hash,strategy_snapshot,compile_job_id)
    values(offer_id,p_client_id,v_strategy_hash,p_strategy_snapshot,p_job_id);
  result:=public.create_service_offer_version_v9(
    offer_id,p_client_id,p_service_name,p_audience,p_promise,
    p_inclusions,p_exclusions,null,null,null,'[]'::jsonb,
    p_value_equation,p_idempotency_key);
  return result;
end $$;
revoke all on function public.create_compiled_main_offer_v10(
  uuid,jsonb,uuid,text,text,text,text[],text[],text,jsonb) from public,anon,authenticated;
grant execute on function public.create_compiled_main_offer_v10(
  uuid,jsonb,uuid,text,text,text,text[],text[],text,jsonb) to service_role;

revoke all on function public.valid_offer_value_equation_v9(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.valid_offer_value_equation_v9(jsonb)
  to authenticated,service_role;
revoke all on function public.create_service_offer_version_v9(
  uuid,uuid,text,text,text,text[],text[],numeric,text,numeric,jsonb,jsonb,text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_service_offer_version_v9(
  uuid,uuid,text,text,text,text[],text[],numeric,text,numeric,jsonb,jsonb,text)
  to authenticated,service_role;
select public.lock_down_definer_functions();
commit;
