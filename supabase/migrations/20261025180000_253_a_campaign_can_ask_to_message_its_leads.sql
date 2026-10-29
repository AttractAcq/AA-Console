-- G11 and the last of G02: the campaign-level decision.
--
-- 249 can send one approved message to one person. 252 can walk one person
-- through a sequence. What was still missing is the thing a campaign
-- actually asks for: "message the leads this campaign produced."
--
-- That is the `lead_message` action, unsupported since 230. It becomes
-- supported here, and what it does is narrow on purpose: it enrols this
-- campaign's own leads into one approved sequence. It sends nothing itself.
-- The courier sends, under the per-message rules, which means every refusal
-- in 249 still applies to every individual message afterwards.
--
-- WHAT THE APPROVAL IS BOUND TO
--
-- The sequence's shape and its words together: a hash over each step's
-- position, delay and template version id. Adding a step, reordering them or
-- changing one word all change that hash, so the approval does not survive
-- it. The approver is agreeing to a specific series of specific messages
-- going to the people this campaign brought in.
--
-- WHOSE LEADS
--
-- Only leads carrying this campaign as their source. Not everybody at the
-- client, which is the mistake that turns a campaign action into a list
-- blast -- and not leads from a sibling campaign, whose consent was given in
-- a different context.

update public.campaign_action_executors
   set supported = true,
       note = 'Enrols this campaign''s own leads into one approved nurture sequence. Sends nothing itself: the courier sends each message under the per-message rules, so consent, suppression and the daily cap still apply to every one.'
 where action_key = 'lead_message';

-- ---------------------------------------------------------------------------
-- Asking
-- ---------------------------------------------------------------------------

create or replace function public.request_campaign_lead_message_v6(
  p_campaign_id uuid, p_sequence_id uuid, p_actor uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_sequence public.nurture_sequences%rowtype;
  v_lines text[] := array[]::text[];
  v_hash text;
  v_eligible integer;
  v_step record;
  v_approval public.campaign_action_approvals%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service can request a campaign action.';
  end if;

  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  if not found then raise exception 'No such campaign.'; end if;

  select * into v_manifest from public.campaign_manifest_versions
   where campaign_id = p_campaign_id order by version desc limit 1;
  if not found then
    raise exception 'This campaign has no package yet. Plan it before asking to message its leads.';
  end if;

  select * into v_sequence from public.nurture_sequences where id = p_sequence_id;
  if not found then raise exception 'No such sequence.'; end if;
  if v_sequence.client_id <> v_campaign.client_id then
    raise exception 'That sequence belongs to a different client.';
  end if;
  if v_sequence.approved_at is null then
    raise exception 'That sequence is not approved. Approve its shape and its words first.';
  end if;
  if v_sequence.archived_at is not null then
    raise exception 'That sequence is archived.';
  end if;

  -- The shape and the words together.
  for v_step in
    select position, delay_hours, template_version_id
      from public.nurture_sequence_steps
     where sequence_id = p_sequence_id order by position
  loop
    v_lines := v_lines || (v_step.position::text || ':' || v_step.delay_hours::text
                           || ':' || v_step.template_version_id::text);
  end loop;
  if array_length(v_lines, 1) is null then
    raise exception 'That sequence has no steps.';
  end if;
  v_hash := encode(sha256(convert_to(
    p_sequence_id::text || '|' || array_to_string(v_lines, '|'), 'UTF8')), 'hex');

  -- Asking to message nobody is a mistake worth refusing rather than
  -- recording as an approval that will quietly do nothing.
  select count(*)::int into v_eligible
    from public.client_leads l
   where l.source_client_campaign_id = p_campaign_id
     and l.client_id = v_campaign.client_id
     and not l.is_probe
     and l.stage = v_sequence.trigger_stage
     and l.consent_given_at is not null
     and not exists (
       select 1 from public.lead_suppressions s
        where s.client_id = l.client_id and s.dedupe_key = l.dedupe_key)
     and not exists (
       select 1 from public.lead_sequence_enrollments e
        where e.lead_id = l.id and e.sequence_id = p_sequence_id);
  if v_eligible = 0 then
    raise exception 'No lead from this campaign is eligible for that sequence right now: none are at % with consent and not already enrolled.',
      v_sequence.trigger_stage;
  end if;

  select * into v_approval from public.request_campaign_action_approval_v6(
    v_manifest.id,
    'lead_message:' || p_campaign_id::text || ':' || v_hash,
    'lead_message',
    'nurture sequence: ' || v_sequence.name,
    v_hash,
    jsonb_build_object(
      'sequence_id', p_sequence_id,
      'sequence_name', v_sequence.name,
      'purpose', v_sequence.purpose,
      'trigger_stage', v_sequence.trigger_stage,
      'steps', array_length(v_lines, 1),
      'eligible_leads', v_eligible,
      'requested_by', p_actor));
  return v_approval.id;
end $$;

comment on function public.request_campaign_lead_message_v6(uuid, uuid, uuid) is
  'Asks for permission to enrol this campaign''s own leads into one approved sequence, bound to a hash over the sequence''s steps and their words. Refuses when no lead is eligible rather than recording an approval that would do nothing.';

revoke all on function public.request_campaign_lead_message_v6(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.request_campaign_lead_message_v6(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Doing it
-- ---------------------------------------------------------------------------

create or replace function public.enrol_campaign_leads_in_sequence_v6(p_execution_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  x public.campaign_action_executions%rowtype;
  a public.campaign_action_approvals%rowtype;
  v_sequence uuid;
  v_sequence_row public.nurture_sequences%rowtype;
  l record;
  v_enrolled integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_reason text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may perform a campaign action.';
  end if;

  select * into x from public.campaign_action_executions where id = p_execution_id;
  if not found then raise exception 'No such execution.'; end if;
  select * into a from public.campaign_action_approvals where id = x.approval_id;
  if a.action_key <> 'lead_message' then
    raise exception 'That approval is a %, not a lead message.', a.action_key;
  end if;

  v_sequence := nullif(a.scope->>'sequence_id', '')::uuid;
  if v_sequence is null then raise exception 'That approval names no sequence.'; end if;
  select * into v_sequence_row from public.nurture_sequences where id = v_sequence;
  if not found then raise exception 'The sequence no longer exists.'; end if;

  -- Re-checked immediately before acting, not trusted from the decision: an
  -- approval dropped by an edit between the yes and the sweep must not act.
  if v_sequence_row.approved_at is null then
    raise exception 'The sequence''s approval was dropped after this was approved. Ask again.';
  end if;

  for l in
    select id from public.client_leads
     where source_client_campaign_id = a.campaign_id
       and client_id = a.client_id
       and not is_probe
       and stage = v_sequence_row.trigger_stage
     order by created_at
  loop
    v_reason := public.sequence_exit_reason_v6(l.id, v_sequence);
    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('lead_id', l.id, 'reason', v_reason));
      continue;
    end if;
    begin
      perform public.enroll_lead_in_sequence_v6(l.id, v_sequence);
      v_enrolled := v_enrolled + 1;
    exception when others then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('lead_id', l.id, 'reason', sqlerrm));
    end;
  end loop;

  return jsonb_build_object(
    'enrolled', v_enrolled,
    'skipped', v_skipped,
    'sequence_id', v_sequence,
    'sequence_name', v_sequence_row.name);
end $$;

comment on function public.enrol_campaign_leads_in_sequence_v6(uuid) is
  'Enrols this campaign''s own leads into the approved sequence, skipping any whose exit condition is already true and saying why. Sends nothing: the courier does that under the per-message rules.';

revoke all on function public.enrol_campaign_leads_in_sequence_v6(uuid)
  from public, anon, authenticated;
grant execute on function public.enrol_campaign_leads_in_sequence_v6(uuid) to service_role;

select lock_down_definer_functions();
