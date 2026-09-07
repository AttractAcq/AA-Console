-- The two things Sales Ops actually does: move a lead, and find the stalled ones.

-- Move a lead and record why, in one statement.
--
-- Separate update-then-insert would let a stage change land with no event
-- behind it, and the timeline is the only thing that makes time-in-stage
-- answerable. Doing both here means they cannot come apart.
create or replace function advance_lead(
  p_lead_id uuid,
  p_stage   lead_stage,
  p_note    text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client_id uuid;
  v_from      lead_stage;
begin
  select client_id, stage into v_client_id, v_from from client_leads where id = p_lead_id;
  if v_client_id is null then
    raise exception 'That lead no longer exists.';
  end if;
  if not can_access_client(v_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if p_stage = 'lost' and coalesce(trim(p_note), '') = '' then
    raise exception 'Say why it was lost. A lost lead with no reason teaches nothing.';
  end if;

  update client_leads
     set stage = p_stage,
         stage_at = now(),
         lost_reason = case when p_stage = 'lost' then p_note else lost_reason end,
         -- The action that got it here is done. Leaving it would show a
         -- completed task as outstanding on every board that reads this.
         next_action = case when p_stage = v_from then next_action else null end,
         next_action_due = case when p_stage = v_from then next_action_due else null end,
         updated_at = now()
   where id = p_lead_id;

  insert into lead_events (lead_id, client_id, kind, body, from_stage, to_stage, created_by)
  values (p_lead_id, v_client_id, 'stage_change', nullif(trim(coalesce(p_note, '')), ''), v_from, p_stage, auth.uid());
end;
$$;

revoke execute on function advance_lead(uuid, lead_stage, text) from public, anon;
grant  execute on function advance_lead(uuid, lead_stage, text) to authenticated, service_role;

-- The question the tool exists to answer: what is sitting still.
--
-- A lead is stalled when nobody has said what happens next, or when what was
-- meant to happen is overdue. Closed stages are excluded — a sale with no next
-- action is finished, not neglected.
create or replace function stalled_leads(p_client_id uuid, p_days integer default 7)
returns table (
  id uuid,
  name text,
  stage lead_stage,
  days_in_stage integer,
  next_action text,
  next_action_due date,
  overdue boolean,
  owner_name text,
  opportunity_value numeric
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select l.id,
         l.name,
         l.stage,
         greatest(0, (current_date - l.stage_at::date))::integer,
         l.next_action,
         l.next_action_due,
         (l.next_action_due is not null and l.next_action_due < current_date),
         tm.name,
         l.opportunity_value
  from client_leads l
  left join team_members tm on tm.id = l.owner_member_id
  where l.client_id = p_client_id
    and (auth.role() = 'service_role' or can_access_client(p_client_id))
    and l.stage not in ('cash', 'lost')
    and (
      l.next_action is null
      or (l.next_action_due is not null and l.next_action_due < current_date)
    )
    and l.stage_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 365)))
  order by l.stage_at asc;
$$;

revoke execute on function stalled_leads(uuid, integer) from public, anon;
grant  execute on function stalled_leads(uuid, integer) to authenticated, service_role;

comment on function stalled_leads(uuid, integer) is
  'Leads with nothing scheduled next, or something overdue, oldest first. Excludes cash and lost, which are finished rather than neglected.';
