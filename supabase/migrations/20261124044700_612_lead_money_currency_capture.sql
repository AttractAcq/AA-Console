-- Capture currencies explicitly for new human Sales OS money edits.
-- Historical values remain null; no exchange rate or locale is inferred.
alter table public.client_leads
  add column sale_currency text,
  add column cash_currency text,
  add constraint client_leads_sale_currency_code check (sale_currency is null or sale_currency ~ '^[A-Z]{3}$'),
  add constraint client_leads_cash_currency_code check (cash_currency is null or cash_currency ~ '^[A-Z]{3}$');

comment on column public.client_leads.sale_currency is
  'Currency reported for sale_value; null means unverified, including historical amounts.';
comment on column public.client_leads.cash_currency is
  'Currency actually collected for cash_collected; null means unverified, including historical amounts.';

-- Keep the existing lead entitlement, stage, archive and event contract.
-- A legacy amount can remain unknown during an unrelated edit; changing a
-- positive amount or its currency requires a current explicit currency.
create or replace function update_lead(p_lead_id uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lead client_leads%rowtype;
  v_key text;
  v_cash numeric;
  v_sale_currency text;
  v_cash_currency text;
  v_sale numeric;
begin
  select * into v_lead from client_leads where id = p_lead_id for update;
  if not found then raise exception 'That lead no longer exists.'; end if;
  if not may_manage_client_leads(v_lead.client_id) then raise exception 'Not permitted for this client'; end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'::jsonb then
    raise exception 'Choose at least one detail to update.';
  end if;
  for v_key in select jsonb_object_keys(p_fields) loop
    if v_key not in ('name','email','phone','source_channel','owner_member_id','next_action',
                     'next_action_due','opportunity_value','sale_value','sale_currency','cash_collected','cash_currency',
                     'appointment_at','appointment_outcome') then
      raise exception 'Field % cannot be edited here.', v_key;
    end if;
  end loop;
  for v_key in select unnest(array['opportunity_value','sale_value','cash_collected']) loop
    if p_fields ? v_key and p_fields->v_key <> 'null'::jsonb then
      if jsonb_typeof(p_fields->v_key) <> 'number' or (p_fields->>v_key)::numeric < 0 then
        raise exception '% must be a number of zero or more.', v_key;
      end if;
    end if;
  end loop;
  if p_fields ? 'appointment_outcome' and p_fields->>'appointment_outcome' is not null
     and p_fields->>'appointment_outcome' not in ('scheduled','showed','no_show','rescheduled','cancelled') then
    raise exception 'Choose a valid appointment outcome.';
  end if;
  if p_fields ? 'owner_member_id' and p_fields->>'owner_member_id' is not null
     and not exists (select 1 from team_members where id = (p_fields->>'owner_member_id')::uuid and active) then
    raise exception 'Choose an active team member.';
  end if;
  v_sale := case when p_fields ? 'sale_value' then (p_fields->>'sale_value')::numeric
                 else v_lead.sale_value end;
  v_sale_currency := case when p_fields ? 'sale_currency' then nullif(upper(trim(p_fields->>'sale_currency')),'')
                          else v_lead.sale_currency end;
  v_cash_currency := case when p_fields ? 'cash_currency' then nullif(upper(trim(p_fields->>'cash_currency')),'')
                          else v_lead.cash_currency end;
  if (p_fields ? 'sale_currency' and v_sale_currency is not null and v_sale_currency !~ '^[A-Z]{3}$')
     or (p_fields ? 'cash_currency' and v_cash_currency is not null and v_cash_currency !~ '^[A-Z]{3}$') then
    raise exception 'Currency must be a three-letter ISO code.';
  end if;
  if (p_fields ? 'sale_value' or p_fields ? 'sale_currency')
     and coalesce(v_sale,0)>0 and v_sale_currency is null then
    raise exception 'Sale currency is required for a positive sale value.';
  end if;
  v_cash := case when p_fields ? 'cash_collected' then (p_fields->>'cash_collected')::numeric
                 else v_lead.cash_collected end;
  if coalesce(v_cash,0) > 0 and v_lead.stage not in ('shown','cash') then
    raise exception 'Move the lead to Show Ups or Cash Collected before recording cash.';
  end if;
  if (p_fields ? 'cash_collected' or p_fields ? 'cash_currency')
     and coalesce(v_cash,0)>0 and v_cash_currency is null then
    raise exception 'Cash currency is required for positive collected cash.';
  end if;
  update client_leads set
    name = case when p_fields ? 'name' then nullif(trim(p_fields->>'name'),'') else name end,
    email = case when p_fields ? 'email' then nullif(trim(p_fields->>'email'),'') else email end,
    phone = case when p_fields ? 'phone' then nullif(trim(p_fields->>'phone'),'') else phone end,
    contact = case when p_fields ? 'email' or p_fields ? 'phone'
      then coalesce(
        case when p_fields ? 'email' then nullif(trim(p_fields->>'email'),'') else email end,
        case when p_fields ? 'phone' then nullif(trim(p_fields->>'phone'),'') else phone end
      ) else contact end,
    source_channel = case when p_fields ? 'source_channel' then nullif(trim(p_fields->>'source_channel'),'') else source_channel end,
    owner_member_id = case when p_fields ? 'owner_member_id' then (p_fields->>'owner_member_id')::uuid else owner_member_id end,
    next_action = case when p_fields ? 'next_action' then nullif(trim(p_fields->>'next_action'),'') else next_action end,
    next_action_due = case when p_fields ? 'next_action_due' then (p_fields->>'next_action_due')::date else next_action_due end,
    opportunity_value = case when p_fields ? 'opportunity_value' then (p_fields->>'opportunity_value')::numeric else opportunity_value end,
    sale_value = case when p_fields ? 'sale_value' then (p_fields->>'sale_value')::numeric else sale_value end,
    sale_currency = case when p_fields ? 'sale_currency' then v_sale_currency else sale_currency end,
    cash_currency = case when p_fields ? 'cash_currency' then v_cash_currency else cash_currency end,
    cash_collected = case when p_fields ? 'cash_collected' then (p_fields->>'cash_collected')::numeric else cash_collected end,
    appointment_at = case when p_fields ? 'appointment_at' then (p_fields->>'appointment_at')::timestamptz else appointment_at end,
    appointment_outcome = case when p_fields ? 'appointment_outcome' then nullif(trim(p_fields->>'appointment_outcome'),'') else appointment_outcome end,
    updated_at = now()
    where id = p_lead_id;
  insert into lead_events (lead_id,client_id,kind,body,created_by)
  values (p_lead_id,v_lead.client_id,'note',
    'Updated: ' || (select string_agg(key, ', ' order by key) from jsonb_object_keys(p_fields) as key),auth.uid());
end;
$$;
revoke execute on function update_lead(uuid, jsonb) from public, anon;
grant execute on function update_lead(uuid, jsonb) to authenticated, service_role;
