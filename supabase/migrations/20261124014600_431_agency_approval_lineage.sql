-- Delivery lineage is client-specific. Agency-wide approval cards have no
-- client and must not be forced into a client delivery entity.
begin;
create or replace function public.refresh_delivery_entity_trigger_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_key text;
begin
  if tg_argv[0] = 'approval' and v_row->>'client_id' is null then
    return new;
  end if;
  if tg_argv[0] = 'destination' then
    v_key := (v_row->>'client_id') || ':' || (v_row->>'destination_key');
  else
    v_key := v_row->>'id';
  end if;
  perform public.refresh_delivery_entity_v6(
    tg_argv[0], v_key, (v_row->>'client_id')::uuid);
  if tg_argv[0] = 'offer_version' then
    perform public.refresh_delivery_entity_v6(
      'offer', v_row->>'offer_id', (v_row->>'client_id')::uuid);
  end if;
  return new;
end $$;
revoke all on function public.refresh_delivery_entity_trigger_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
