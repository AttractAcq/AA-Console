-- Requires the enum additions in 128 to have committed first.
alter table client_leads alter column stage set default 'profile_visit';

-- Durable identity for references that must survive moving the full lead row
-- between active and archived storage.
create table lead_identities (
  id uuid primary key,
  client_id uuid not null references clients(id) on delete cascade,
  unique (id, client_id)
);
insert into lead_identities (id, client_id)
select id, client_id from client_leads;
alter table lead_identities enable row level security;
create policy lead_identities_admin_all on lead_identities
  for all to authenticated using (is_admin()) with check (is_admin());
create policy lead_identities_client_read on lead_identities
  for select to authenticated using (is_client_user(client_id));
grant select on lead_identities to authenticated;

create or replace function register_lead_identity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' and not can_access_client(new.client_id) then
    raise exception 'Not permitted for this client';
  end if;
  insert into lead_identities (id, client_id) values (new.id, new.client_id)
  on conflict (id) do nothing;
  if not exists (select 1 from lead_identities where id = new.id and client_id = new.client_id) then
    raise exception 'Lead identity belongs to another client.';
  end if;
  return new;
end;
$$;
revoke execute on function register_lead_identity() from public, anon;
create trigger client_leads_register_identity after insert on client_leads
  for each row execute function register_lead_identity();

-- These are the only two foreign keys to client_leads besides lead_events.
-- lead_events are copied and restored; the two historical references keep
-- their lead_id, now protected by the durable identity instead of the active row.
alter table sales_agent_conversations drop constraint sales_agent_conversations_lead_id_fkey;
alter table sales_agent_conversations add constraint sales_agent_conversations_lead_id_fkey
  foreign key (lead_id) references lead_identities(id) on delete set null;
alter table mcp_internal.mcp_pipeline_requests drop constraint mcp_pipeline_requests_lead_id_fkey;
alter table mcp_internal.mcp_pipeline_requests add constraint mcp_pipeline_requests_lead_id_fkey
  foreign key (lead_id) references lead_identities(id);

create table archived_leads (
  id uuid primary key references lead_identities(id),
  client_id uuid not null references clients(id) on delete cascade,
  name text,
  stage_at_archive lead_stage not null,
  lead jsonb not null,
  events jsonb not null default '[]'::jsonb,
  reason text,
  archived_at timestamptz not null default now(),
  archived_by uuid references profiles(id) on delete set null
);
create index archived_leads_client_date_idx on archived_leads (client_id, archived_at desc);
alter table archived_leads enable row level security;
create policy archived_leads_admin_all on archived_leads
  for all to authenticated using (is_admin()) with check (is_admin());
create policy archived_leads_client_read on archived_leads
  for select to authenticated using (is_client_user(client_id));
grant select on archived_leads to authenticated;

create or replace function lead_stage_rank(s lead_stage)
returns integer language sql immutable security definer set search_path = public as $$
  select case s
    when 'profile_visit' then 1 when 'follower' then 2 when 'qualified' then 3
    when 'conversation' then 4 when 'qualified_conversation' then 5
    when 'appointment' then 6 when 'qualified_appointment' then 7
    when 'shown' then 8 when 'cash' then 9
    -- Legacy stages remain readable until Alex confirms their mapping.
    when 'lead' then 3 when 'sale' then 8 when 'lost' then 1
  end;
$$;
revoke execute on function lead_stage_rank(lead_stage) from public, anon;
grant execute on function lead_stage_rank(lead_stage) to authenticated, service_role;

create or replace function stalled_leads(p_client_id uuid, p_days integer default 7)
returns table (
  id uuid, name text, stage lead_stage, days_in_stage integer,
  next_action text, next_action_due date, overdue boolean,
  owner_name text, opportunity_value numeric
)
language sql stable security definer set search_path = public as $$
  select l.id, l.name, l.stage,
         greatest(0, current_date - l.stage_at::date)::integer,
         l.next_action, l.next_action_due,
         (l.next_action_due is not null and l.next_action_due < current_date),
         tm.name, l.opportunity_value
  from client_leads l
  left join team_members tm on tm.id = l.owner_member_id
  where l.client_id = p_client_id
    and (auth.role() = 'service_role' or can_access_client(p_client_id))
    and lead_stage_rank(l.stage) >= 3 and l.stage not in ('cash','lost')
    and (l.next_action is null or (l.next_action_due is not null and l.next_action_due < current_date))
    and l.stage_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 365)))
  order by l.stage_at asc;
$$;
revoke execute on function stalled_leads(uuid, integer) from public, anon;
grant execute on function stalled_leads(uuid, integer) to authenticated, service_role;

create or replace function advance_lead(p_lead_id uuid, p_stage lead_stage, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_lead client_leads%rowtype;
begin
  select * into v_lead from client_leads where id = p_lead_id for update;
  if not found then raise exception 'That lead no longer exists.'; end if;
  if not can_access_client(v_lead.client_id) then raise exception 'Not permitted for this client'; end if;
  if p_stage not in ('profile_visit','follower','qualified','conversation','qualified_conversation',
                     'appointment','qualified_appointment','shown','cash','lost') then
    raise exception 'That stage is no longer available.';
  end if;
  if p_stage = 'lost' and coalesce(trim(p_note),'') = '' then
    raise exception 'Say why it was lost. A lost lead with no reason teaches nothing.';
  end if;
  if coalesce(v_lead.cash_collected,0) > 0 and p_stage not in ('shown','cash') then
    raise exception 'A lead with cash collected must remain at Show Ups or Cash Collected.';
  end if;
  update client_leads set stage = p_stage, stage_at = now(),
    lost_reason = case when p_stage = 'lost' then p_note else lost_reason end,
    next_action = case when p_stage = v_lead.stage then next_action else null end,
    next_action_due = case when p_stage = v_lead.stage then next_action_due else null end,
    updated_at = now()
    where id = p_lead_id;
  insert into lead_events (lead_id,client_id,kind,body,from_stage,to_stage,created_by)
  values (p_lead_id,v_lead.client_id,'stage_change',nullif(trim(coalesce(p_note,'')),''),v_lead.stage,p_stage,auth.uid());
end;
$$;
revoke execute on function advance_lead(uuid, lead_stage, text) from public, anon;
grant execute on function advance_lead(uuid, lead_stage, text) to authenticated, service_role;

create or replace function update_lead(p_lead_id uuid, p_fields jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lead client_leads%rowtype;
  v_key text;
  v_cash numeric;
begin
  select * into v_lead from client_leads where id = p_lead_id for update;
  if not found then raise exception 'That lead no longer exists.'; end if;
  if not can_access_client(v_lead.client_id) then raise exception 'Not permitted for this client'; end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'::jsonb then
    raise exception 'Choose at least one detail to update.';
  end if;
  for v_key in select jsonb_object_keys(p_fields) loop
    if v_key not in ('name','email','phone','source_channel','owner_member_id','next_action',
                     'next_action_due','opportunity_value','sale_value','cash_collected',
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
  v_cash := case when p_fields ? 'cash_collected' then (p_fields->>'cash_collected')::numeric
                 else v_lead.cash_collected end;
  if coalesce(v_cash,0) > 0 and v_lead.stage not in ('shown','cash') then
    raise exception 'Move the lead to Show Ups or Cash Collected before recording cash.';
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
grant execute on function update_lead(uuid, jsonb) to authenticated;

create or replace function add_lead_note(p_lead_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_client_id uuid;
begin
  select client_id into v_client_id from client_leads where id = p_lead_id;
  if v_client_id is null then raise exception 'That lead no longer exists.'; end if;
  if not can_access_client(v_client_id) then raise exception 'Not permitted for this client'; end if;
  if nullif(trim(coalesce(p_note,'')),'') is null then raise exception 'Write a note first.'; end if;
  insert into lead_events (lead_id,client_id,kind,body,created_by)
  values (p_lead_id,v_client_id,'note',trim(p_note),auth.uid());
end;
$$;
revoke execute on function add_lead_note(uuid, text) from public, anon;
grant execute on function add_lead_note(uuid, text) to authenticated;

create or replace function archive_lead(p_lead_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_lead client_leads%rowtype;
begin
  select * into v_lead from client_leads where id = p_lead_id for update;
  if not found then raise exception 'That lead no longer exists.'; end if;
  if not can_access_client(v_lead.client_id) then raise exception 'Not permitted for this client'; end if;
  if coalesce(v_lead.cash_collected,0) > 0 then
    raise exception 'This lead has cash collected. Archiving it would remove that revenue from reports.';
  end if;
  if v_lead.stage in ('lead','sale') then
    raise exception 'This legacy stage needs Alex''s mapping approval before it can be archived.';
  end if;
  insert into archived_leads (id,client_id,name,stage_at_archive,lead,events,reason,archived_by)
  select v_lead.id,v_lead.client_id,v_lead.name,v_lead.stage,to_jsonb(v_lead),
    coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id)
      from lead_events e where e.lead_id = p_lead_id),'[]'::jsonb),
    nullif(trim(coalesce(p_reason,'')),''),auth.uid();
  delete from client_leads where id = p_lead_id;
end;
$$;
revoke execute on function archive_lead(uuid, text) from public, anon;
grant execute on function archive_lead(uuid, text) to authenticated;

create or replace function recover_lead(p_lead_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_archive archived_leads%rowtype;
begin
  select * into v_archive from archived_leads where id = p_lead_id for update;
  if not found then raise exception 'That archived lead no longer exists.'; end if;
  if not can_access_client(v_archive.client_id) then raise exception 'Not permitted for this client'; end if;
  if v_archive.stage_at_archive in ('lead','sale') then
    raise exception 'This legacy stage needs Alex''s mapping approval before recovery.';
  end if;
  insert into client_leads select * from jsonb_populate_record(null::client_leads,v_archive.lead);
  insert into lead_events select * from jsonb_populate_recordset(null::lead_events,v_archive.events);
  insert into lead_events (lead_id,client_id,kind,body,created_by)
  values (p_lead_id,v_archive.client_id,'note',
    'Recovered from archive on ' || to_char(now() at time zone 'UTC','YYYY-MM-DD HH24:MI') || ' UTC',auth.uid());
  delete from archived_leads where id = p_lead_id;
end;
$$;
revoke execute on function recover_lead(uuid) from public, anon;
grant execute on function recover_lead(uuid) to authenticated;
