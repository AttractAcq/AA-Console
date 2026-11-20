-- Read the same archived-aware, currency-safe content attribution as the
-- Console. Missing provider metrics remain unknown rather than fabricated zero.
begin;
create or replace function mcp_internal.attribution_content_performance(
  p_bot_id text,
  p_client_id uuid,
  p_limit integer default 10
)
returns jsonb language plpgsql volatile security definer
set search_path=pg_catalog,mcp_internal,public set timezone='UTC' as $$
declare
  v_limit integer;
  v_items jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if not mcp_internal.bot_has_permission(p_bot_id, 'attribution.get_content_performance') then
    raise exception using message='bot_forbidden', errcode='P0001';
  end if;
  perform 1 from mcp_internal.mcp_bots where bot_id=p_bot_id and status='active' for share;
  if not found then raise exception using message='bot_not_active', errcode='P0001'; end if;
  v_limit := coalesce(p_limit, 10);
  if v_limit < 1 or v_limit > 100 then
    raise exception using message='invalid_request', errcode='P0001';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.cash_collected desc nulls last,
      x.sale_value desc nulls last, x.leads desc, x.asset_created_at desc),
      '[]'::jsonb) into v_items
  from (
    select ca.asset_id,ca.asset_ref,ca.asset_title,ca.hook,ca.idea_title,
           ca.content_territory,ca.leads,ca.sales,ca.sale_value,
           ca.cash_collected,ca.spend,ca.impressions,ca.asset_created_at
    from public.content_attribution ca
    where ca.client_id=p_client_id
    order by ca.cash_collected desc nulls last,
             ca.sale_value desc nulls last,ca.leads desc,
             ca.asset_created_at desc
    limit v_limit
  ) x;

  return jsonb_build_object(
    'client_id', p_client_id,
    'projection', 'content_attribution_v1',
    'items', v_items
  );
end $$;
revoke all on function mcp_internal.attribution_content_performance(text,uuid,integer) from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
