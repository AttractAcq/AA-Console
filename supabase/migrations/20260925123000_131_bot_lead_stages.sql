-- Bot stage allowlist; kept in SQL as the final guard after gateway and runtime validation.
create or replace function mcp_internal.update_lead_stage(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_lead_id uuid, p_stage text, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v_lead client_leads;
  v_from text;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  if p_bot_id <> 'bot_sales_ops' then
    raise exception using message = 'bot_forbidden', errcode = 'P0001';
  end if;
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_lead_id is null or p_stage is null then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  if p_stage not in
    ('profile_visit','follower','qualified','conversation','qualified_conversation',
     'appointment','qualified_appointment','shown','lost') then
    raise exception using message = 'invalid_stage', errcode = 'P0001';
  end if;
  if p_note is not null and length(p_note) > 4000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'lead_id', p_lead_id, 'stage', p_stage, 'note', p_note));
  v_existing := mcp_internal.take_pipeline_request(
    p_bot_id, p_execution_id, 'pipeline.update_stage', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_lead from client_leads where id = p_lead_id for update;
  if not found then
    raise exception using message = 'lead_not_found', errcode = 'P0001';
  end if;
  if v_lead.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  if p_stage = 'lost' and coalesce(trim(p_note), '') = '' then
    raise exception using message = 'lost_reason_required', errcode = 'P0001';
  end if;

  v_from := v_lead.stage::text;
  update client_leads
     set stage = p_stage::lead_stage,
         stage_at = now(),
         lost_reason = case when p_stage = 'lost' then p_note else lost_reason end,
         next_action = case when p_stage = v_from then next_action else null end,
         next_action_due = case when p_stage = v_from then next_action_due else null end,
         updated_at = now()
   where id = p_lead_id;
  insert into lead_events (lead_id, client_id, kind, body, from_stage, to_stage, created_by_bot)
  values (p_lead_id, p_client_id, 'stage_change', nullif(trim(coalesce(p_note, '')), ''),
          v_from::lead_stage, p_stage::lead_stage, p_bot_id);

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'lead_id', p_lead_id,
    'from_stage', v_from,
    'stage', p_stage,
    'replayed', false
  );
  insert into mcp_internal.mcp_pipeline_requests (
    bot_id, execution_id, request_id, tool, client_id, lead_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'pipeline.update_stage', p_client_id, p_lead_id, v_payload, v_result
  );
  return v_result;
end;
$$;
revoke all on function mcp_internal.update_lead_stage(text, text, text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function mcp_internal.update_lead_stage(text, text, text, uuid, uuid, text, text)
  to service_role;
