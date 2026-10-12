-- Durable email dispatch for a daily package with no compatible reserve.
alter table daily_package_recovery_alerts
  add column delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sending', 'sent', 'failed')),
  add column delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
  add column delivery_worker text,
  add column delivery_lease_until timestamptz,
  add column delivered_at timestamptz,
  add column provider_message_id text,
  add column delivery_error text;

create function claim_daily_recovery_alert(p_worker text, p_lease_seconds integer default 120)
returns table (
  alert_id uuid, item_id uuid, client_id uuid, client_name text, package_day date,
  item_role text, manager_email text, reason text
)
language plpgsql security definer set search_path to 'public' as $$
declare v_alert daily_package_recovery_alerts; v_item daily_package_items;
  v_package daily_packages; v_manager uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if nullif(btrim(coalesce(p_worker, '')), '') is null
     or p_lease_seconds not between 30 and 600 then
    raise exception 'A worker and 30..600 second lease are required.';
  end if;
  select * into v_alert from daily_package_recovery_alerts a
    where a.resolved_at is null and a.delivery_attempts < 3
      and (a.delivery_status = 'pending'
        or (a.delivery_status in ('sending', 'failed')
          and a.delivery_lease_until <= now()))
    order by a.created_at, a.id for update skip locked limit 1;
  if not found then return; end if;
  update daily_package_recovery_alerts set delivery_status = 'sending',
    delivery_attempts = delivery_attempts + 1, delivery_worker = btrim(p_worker),
    delivery_lease_until = now() + make_interval(secs => p_lease_seconds),
    delivery_error = null where id = v_alert.id;
  select * into v_item from daily_package_items where id = v_alert.item_id;
  select * into v_package from daily_packages where id = v_item.package_id;
  v_manager := active_video_approval_manager(v_package.client_id);
  alert_id := v_alert.id; item_id := v_item.id; client_id := v_package.client_id;
  client_name := (select name from clients where id = v_package.client_id);
  package_day := v_package.package_day; item_role := v_item.role;
  manager_email := (select email from profiles where id = v_manager);
  reason := v_alert.reason;
  return next;
end;
$$;

create function complete_daily_recovery_alert(
  p_alert_id uuid, p_worker text, p_sent boolean,
  p_provider_message_id text default null, p_error text default null
) returns daily_package_recovery_alerts
language plpgsql security definer set search_path to 'public' as $$
declare v_alert daily_package_recovery_alerts;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_alert from daily_package_recovery_alerts where id = p_alert_id for update;
  if not found then raise exception 'No such alert.'; end if;
  if v_alert.delivery_status = 'sent' and p_sent
     and v_alert.provider_message_id is not distinct from p_provider_message_id then
    return v_alert;
  end if;
  if v_alert.delivery_status <> 'sending' or v_alert.delivery_worker <> p_worker then
    raise exception 'Alert is not leased by this worker.';
  end if;
  if p_sent and nullif(btrim(coalesce(p_provider_message_id, '')), '') is null then
    raise exception 'A sent alert needs a provider message id.';
  end if;
  update daily_package_recovery_alerts set
    delivery_status = case when p_sent then 'sent' else 'failed' end,
    delivered_at = case when p_sent then now() else null end,
    provider_message_id = case when p_sent then p_provider_message_id else null end,
    delivery_error = case when p_sent then null else left(coalesce(p_error, 'Delivery failed.'), 1000) end,
    delivery_worker = null,
    delivery_lease_until = case when p_sent then null else now() + interval '10 minutes' end
    where id = p_alert_id returning * into v_alert;
  return v_alert;
end;
$$;

revoke all on function claim_daily_recovery_alert(text, integer) from public, anon, authenticated;
revoke all on function complete_daily_recovery_alert(uuid, text, boolean, text, text)
  from public, anon, authenticated;
grant execute on function claim_daily_recovery_alert(text, integer) to service_role;
grant execute on function complete_daily_recovery_alert(uuid, text, boolean, text, text) to service_role;
select lock_down_definer_functions();
