-- Explicit opportunity currency for new pipeline money. Historical rows stay unknown.
alter table public.client_leads
  add column opportunity_currency text,
  add constraint client_leads_opportunity_currency_code
    check (opportunity_currency is null or opportunity_currency ~ '^[A-Z]{3}$');
comment on column public.client_leads.opportunity_currency is
  'Currency reported for opportunity_value; null means unverified, including historical amounts.';

create or replace function update_lead(p_lead_id uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lead client_leads%rowtype;
  v_key text;
  v_cash numeric;
  v_sale_currency text;
  v_cash_currency text;
  v_sale numeric;
  v_opportunity numeric;
  v_opportunity_currency text;
begin
  select * into v_lead from client_leads where id = p_lead_id for update;
  if not found then raise exception 'That lead no longer exists.'; end if;
  if not may_manage_client_leads(v_lead.client_id) then raise exception 'Not permitted for this client'; end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'::jsonb then
    raise exception 'Choose at least one detail to update.';
  end if;
  for v_key in select jsonb_object_keys(p_fields) loop
    if v_key not in ('name','email','phone','source_channel','owner_member_id','next_action',
                     'next_action_due','opportunity_value','opportunity_currency','sale_value','sale_currency','cash_collected','cash_currency',
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
  v_opportunity := case when p_fields ? 'opportunity_value' then (p_fields->>'opportunity_value')::numeric
                        else v_lead.opportunity_value end;
  v_opportunity_currency := case when p_fields ? 'opportunity_currency'
    then nullif(upper(trim(p_fields->>'opportunity_currency')),'')
    else v_lead.opportunity_currency end;
  if p_fields ? 'opportunity_currency' and v_opportunity_currency is not null
     and v_opportunity_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a three-letter ISO code.';
  end if;
  if (p_fields ? 'opportunity_value' or p_fields ? 'opportunity_currency')
     and coalesce(v_opportunity,0)>0 and v_opportunity_currency is null then
    raise exception 'Opportunity currency is required for a positive opportunity value.';
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
    opportunity_currency = case when p_fields ? 'opportunity_currency' then v_opportunity_currency else opportunity_currency end,
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

-- Recheck direct service and table writes at the same row boundary.
create or replace function public.guard_lead_money_currency_v8()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  opportunity_changed boolean;
  sale_changed boolean;
  cash_changed boolean;
  archived_match boolean := false;
begin
  if tg_op = 'INSERT' then
    opportunity_changed := true;
    sale_changed := true;
    cash_changed := true;
    -- recover_lead restores archived bytes, including historically unknown
    -- currencies. Authorize that narrow case only while its archive snapshot
    -- is present and its financial values match the snapshot exactly.
    select exists (
      select 1 from public.archived_leads a
      where a.id=new.id and a.client_id=new.client_id
        and (a.lead->>'opportunity_value')::numeric is not distinct from new.opportunity_value
        and a.lead->>'opportunity_currency' is not distinct from new.opportunity_currency
        and (a.lead->>'sale_value')::numeric is not distinct from new.sale_value
        and (a.lead->>'cash_collected')::numeric is not distinct from new.cash_collected
        and a.lead->>'sale_currency' is not distinct from new.sale_currency
        and a.lead->>'cash_currency' is not distinct from new.cash_currency
    ) into archived_match;
  else
    opportunity_changed := new.opportunity_value is distinct from old.opportunity_value
      or new.opportunity_currency is distinct from old.opportunity_currency;
    sale_changed := new.sale_value is distinct from old.sale_value
      or new.sale_currency is distinct from old.sale_currency;
    cash_changed := new.cash_collected is distinct from old.cash_collected
      or new.cash_currency is distinct from old.cash_currency;
  end if;
  if not archived_match and opportunity_changed
     and coalesce(new.opportunity_value,0)>0 and new.opportunity_currency is null then
    raise exception 'Opportunity currency is required for a positive opportunity value.'
      using errcode='23514';
  end if;
  if not archived_match and sale_changed
     and coalesce(new.sale_value,0)>0 and new.sale_currency is null then
    raise exception 'Sale currency is required for a positive sale value.'
      using errcode='23514';
  end if;
  if not archived_match and cash_changed
     and coalesce(new.cash_collected,0)>0 and new.cash_currency is null then
    raise exception 'Cash currency is required for positive collected cash.'
      using errcode='23514';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_lead_money_currency_v8() from public, anon, authenticated;

drop trigger client_leads_money_currency_guard_v8 on public.client_leads;
create trigger client_leads_money_currency_guard_v8
before insert or update of opportunity_value,opportunity_currency,
  sale_value,sale_currency,cash_collected,cash_currency
on public.client_leads for each row
execute function public.guard_lead_money_currency_v8();

-- New browser entry point. The old RPC remains readable and accepts zero/unknown
-- values; its positive legacy call now fails at the direct row guard.
create or replace function public.create_manual_lead_with_currency(
  p_client_id uuid, p_name text, p_email text default null, p_phone text default null,
  p_owner_member_id uuid default null, p_next_action text default null,
  p_next_action_due date default null, p_opportunity_value numeric default null,
  p_opportunity_currency text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_name text := nullif(trim(p_name), '');
  v_email text := nullif(trim(p_email), '');
  v_phone text := nullif(trim(p_phone), '');
  v_currency text := nullif(upper(trim(p_opportunity_currency)), '');
begin
  if auth.role() not in ('authenticated','service_role')
     or not public.may_manage_client_leads(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if v_name is null then
    raise exception 'Name is required.';
  end if;
  if p_opportunity_value < 0 then
    raise exception 'Opportunity value must be zero or more.';
  end if;
  if v_currency is not null and v_currency !~ '^[A-Z]{3}$' then
    raise exception 'Currency must be a three-letter ISO code.';
  end if;
  if coalesce(p_opportunity_value,0)>0 and v_currency is null then
    raise exception 'Opportunity currency is required for a positive opportunity value.';
  end if;
  insert into public.client_leads (
    client_id,name,email,phone,contact,source,stage,owner_member_id,
    next_action,next_action_due,opportunity_value,opportunity_currency,created_by
  ) values (
    p_client_id,v_name,v_email,v_phone,coalesce(v_email,v_phone),'manual_entry',
    'profile_visit',p_owner_member_id,nullif(trim(p_next_action),''),
    p_next_action_due,p_opportunity_value,v_currency,auth.uid()
  ) returning id into v_id;
  insert into public.lead_events (lead_id,client_id,kind,body,created_by)
  values (v_id,p_client_id,'note','Created manually.',auth.uid());
  return v_id;
end;
$$;
revoke execute on function public.create_manual_lead_with_currency(
  uuid,text,text,text,uuid,text,date,numeric,text) from public,anon;
grant execute on function public.create_manual_lead_with_currency(
  uuid,text,text,text,uuid,text,date,numeric,text) to authenticated,service_role;
