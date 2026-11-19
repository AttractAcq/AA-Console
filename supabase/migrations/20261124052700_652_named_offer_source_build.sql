-- Manual-first Build names the service in the same transaction that captures
-- its reviewed Strategy or approved opportunity source. The old v7 writers
-- remain for historical callers; they must not be used by the new UI.
begin;

create or replace function public.create_named_main_offer_v9(
  p_client_id uuid, p_service_name text
) returns public.service_offers
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare result public.service_offers%rowtype;
begin
  if p_service_name is null or length(btrim(p_service_name)) not between 1 and 200 then
    raise exception 'Choose a business service between 1 and 200 characters.'
      using errcode = '22023';
  end if;
  result := public.create_main_offer_v7(p_client_id);
  update public.service_offers set service_name = btrim(p_service_name)
    where id = result.id and client_id = p_client_id returning * into result;
  if result.id is null then
    raise exception 'The source-bound main offer could not be named.' using errcode = '23514';
  end if;
  return result;
end $$;

create or replace function public.create_named_secondary_offer_v9(
  p_opportunity_id uuid, p_service_name text
) returns public.service_offers
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare result public.service_offers%rowtype;
begin
  if p_service_name is null or length(btrim(p_service_name)) not between 1 and 200 then
    raise exception 'Choose a business service between 1 and 200 characters.'
      using errcode = '22023';
  end if;
  result := public.create_secondary_offer_v7(p_opportunity_id);
  update public.service_offers set service_name = btrim(p_service_name)
    where id = result.id and client_id = result.client_id returning * into result;
  if result.id is null then
    raise exception 'The source-bound opportunity offer could not be named.' using errcode = '23514';
  end if;
  return result;
end $$;

-- The agent path carries the operator's chosen service into the same queued
-- job as the current source snapshot. The v6 queue remains for existing callers.
create or replace function public.request_named_offer_compile_v9(
  p_client_id uuid, p_kind text, p_opportunity_id uuid,
  p_service_name text
) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare job_id uuid;
begin
  if p_service_name is null or length(btrim(p_service_name)) not between 1 and 200 then
    raise exception 'Choose a business service between 1 and 200 characters.'
      using errcode = '22023';
  end if;
  job_id := public.request_offer_compile_v6(
    p_client_id,p_kind,
    case p_kind when 'main' then 'strategy' when 'secondary' then 'micro_niche' else null end,
    p_opportunity_id);
  update public.agent_jobs set params=params || jsonb_build_object(
    'service_name',btrim(p_service_name))
  where id=job_id and client_id=p_client_id and created_by=auth.uid();
  if not found then
    raise exception 'The named offer job could not be bound to its service.'
      using errcode='23514';
  end if;
  return job_id;
end $$;

revoke all on function public.create_named_main_offer_v9(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_named_main_offer_v9(uuid,text)
  to authenticated;
revoke all on function public.create_named_secondary_offer_v9(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.create_named_secondary_offer_v9(uuid,text)
  to authenticated;
revoke all on function public.request_named_offer_compile_v9(uuid,text,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.request_named_offer_compile_v9(uuid,text,uuid,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;
