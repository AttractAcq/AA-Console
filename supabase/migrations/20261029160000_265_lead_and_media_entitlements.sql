-- B005: Sales OS lead actions are commercial data, not assignment work.
-- An editor/avatar/SMM job or client assignment grants can_access_client(),
-- but migration 19 deliberately removed such employees from lead table reads.
-- Keep the existing named RPC interface for admins, client users and service
-- callers; do not let an assignment alone authorize a SECURITY DEFINER write.
create or replace function public.may_manage_client_leads(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.role() = 'service_role', false)
      or public.is_admin()
      or public.is_client_user(target);
$$;
revoke execute on function public.may_manage_client_leads(uuid)
  from public, anon, authenticated;
grant execute on function public.may_manage_client_leads(uuid) to service_role;

-- Recreate the six migration-129 RPCs with only their entitlement predicate
-- changed. All stage, money, archive, event and source rules remain intact.
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
    and (auth.role() = 'service_role' or may_manage_client_leads(p_client_id))
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
  if not may_manage_client_leads(v_lead.client_id) then raise exception 'Not permitted for this client'; end if;
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
  if not may_manage_client_leads(v_lead.client_id) then raise exception 'Not permitted for this client'; end if;
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
  if not may_manage_client_leads(v_client_id) then raise exception 'Not permitted for this client'; end if;
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
  if not may_manage_client_leads(v_lead.client_id) then raise exception 'Not permitted for this client'; end if;
  if coalesce(v_lead.cash_collected,0) > 0 then
    raise exception 'This lead has cash collected. Archiving it would remove that revenue from reports.';
  end if;
  if v_lead.stage in ('lead','sale') then
    raise exception 'Move this legacy lead to a current stage before archiving.';
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
  if not may_manage_client_leads(v_archive.client_id) then raise exception 'Not permitted for this client'; end if;
  if v_archive.stage_at_archive in ('lead','sale') then
    raise exception 'This legacy lead cannot be recovered into an old stage.';
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

-- An owner may sign/read their own client-media upload only while they are an
-- active employee and still have the client assignment. Admin and client-user
-- reads continue through their separate policies; assigned source/SMM video
-- policies retain their own active-member gates.
drop policy if exists media_obj_employee_read on storage.objects;
create policy media_obj_employee_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'client-media'
    and owner = auth.uid()
    and current_role_of() = 'employee'::app_role
    and current_member_id() is not null
    and can_access_client(try_uuid((storage.foldername(name))[1]))
  );
