-- Proof Distribution starts moving, and the campaign gate is wired to it.
--
-- Migration 218 built the whole proof placement spine and deliberately left
-- it inert: every destination unsupported, no sweep, no cron, and a claim
-- function with nothing calling it. Its own comment says the expiry sweep
-- "gets a cron entry in the migration that brings up the first adapter,
-- because a schedule that has never run is not evidence that it works".
-- This is that migration.
--
-- WHAT BECOMES GENUINELY POSSIBLE HERE
--
-- Two different things, and the difference matters more than it looks:
--
--   assisted destinations (directories, proposals) become supported. There
--   is no API to call and there never will be. What the system does is hold
--   the exact approved version, render it, record which person placed it and
--   where, and keep the trail that makes retraction possible a year later.
--   That is a real capability and it needs no credential, so it is provable
--   today.
--
--   google_business_profile becomes supported, and its transport ships in
--   the runtime with this migration. It is gated by `requires_integration`,
--   so until somebody connects a Google Business credential for a client the
--   due view says "No usable google_business integration for this client"
--   and nothing is claimed. The transport is therefore code-complete and
--   unproven, and the acceptance gate for it is a real account, not this
--   migration.
--
-- The other eight destinations stay unsupported, each with the sentence
-- saying what is missing. organic_social and paid_advertising in particular
-- stay off: their transport exists in content distribution and Meta Ads, and
-- recording placements against those posts is its own slice rather than a
-- second publisher competing with the first.
--
-- THE CAMPAIGN BRIDGE
--
-- 218 left `proof_placement_approvals.campaign_action_approval_id` nullable
-- and unused, "until that executor exists". Migration 230 built it. This
-- migration connects the two, and the connection is one idea: when proof is
-- being placed as part of a campaign, the human decision is the campaign
-- action approval, and the placement approvals hang off it rather than being
-- a second queue asking the same person the same question twice.
--
-- The thing that makes that safe is the scope. The campaign approval names
-- every placement and the hash of every payload, so a person is deciding
-- about specific words at specific destinations rather than about the idea
-- of publishing proof. At release time each placement's current hash is
-- compared with the one in the scope, and anything that moved is skipped
-- with a reason rather than released under a decision that was made about
-- something else.

-- ---------------------------------------------------------------------------
-- Destinations that can now carry a placement to its end
-- ---------------------------------------------------------------------------

-- `supported` means "this system can carry a placement at this destination
-- all the way to placed", not "there is an API". For an assisted destination
-- the last step is a person, and mark_proof_placement_placed_v6 has been
-- waiting for them since 218.
update public.proof_destinations
   set supported = true,
       note = 'No write API exists for most directories. The payload is rendered here, a person places it, and they record the URL.'
 where destination_key = 'third_party_directory';

update public.proof_destinations
   set supported = true,
       note = 'A proof pack rendered into the document a salesperson sends. The placement is the document version, placed by a person.'
 where destination_key = 'proposal_quotation';

update public.proof_destinations
   set supported = true,
       note = 'Posts, photos and review replies through the Business Profile API. The transport exists in the runtime; it is unproven until a client has a connected Google Business credential and a verified location.'
 where destination_key = 'google_business_profile';

-- ---------------------------------------------------------------------------
-- A gap in 218, found by wiring the release path to it
-- ---------------------------------------------------------------------------

-- 218's rights trigger moves every live placement of a proof to
-- `retraction_required` when permission comes off it. Its status list starts
-- at `approved` and leaves out the two states before that: a drafted
-- placement and one waiting for its decision both stayed exactly where they
-- were when the permission behind them ended.
--
-- That was nearly harmless while nothing acted on a placement, because
-- `proof_placement_due` re-checks clearance and the sweep never claims a
-- blocked row. It stops being harmless now. The release path below reads
-- `awaiting_approval` as "waiting on this decision", and without this fix a
-- proof whose permission ended between the ask and the yes would be released
-- into `queued` -- blocked at the transport, but recorded as released and
-- sitting in a queue, which is the wrong answer to "what do we pull".
--
-- So: the two missing transitions, and the trigger taught about them. A
-- revoked proof now stops at the earliest state it can be in rather than at
-- the last gate before the write.
insert into public.proof_placement_transitions (from_status, to_status, note) values
  ('drafted',           'retraction_required', 'Permission ended while it was still a draft.'),
  ('awaiting_approval', 'retraction_required', 'Permission ended while somebody was deciding.')
on conflict (from_status, to_status) do nothing;

create or replace function public.flag_proof_placements_for_retraction_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.usage_rights = 'approved'
     and (new.expires_on is null or new.expires_on >= current_date)
     and nullif(btrim(new.permission_basis), '') is not null then
    return new;
  end if;
  with flagged as (
    update public.proof_placements
       set status = 'retraction_required'
     where source_proof_id = new.id
       and status in ('drafted', 'awaiting_approval', 'approved', 'queued',
                      'awaiting_manual_placement', 'bound', 'placed', 'verified')
     returning id, client_id)
  insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
  select f.id, f.client_id, 'retraction_required', 'system',
         'Permission for the source proof ended.'
    from flagged f;
  return new;
end $$;

-- The calendar sweep has the same blind spot, for the same reason.
create or replace function public.sweep_expired_proof_placements()
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may sweep placements.';
  end if;
  with flagged as (
    update public.proof_placements pl
       set status = 'retraction_required'
      from public.client_proof_assets p
     where p.id = pl.source_proof_id
       and p.expires_on is not null and p.expires_on < current_date
       and pl.status in ('drafted', 'awaiting_approval', 'approved', 'queued',
                         'awaiting_manual_placement', 'bound', 'placed', 'verified')
     returning pl.id, pl.client_id)
  insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
  select f.id, f.client_id, 'retraction_required', 'system', 'Permission expired.'
    from flagged f;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.sweep_expired_proof_placements() from public, anon, authenticated;
grant execute on function public.sweep_expired_proof_placements() to service_role;

-- ---------------------------------------------------------------------------
-- Asking, at campaign level
-- ---------------------------------------------------------------------------

-- Service role only, like request_campaign_action_approval_v6 itself and for
-- the same reason: a request has to be built from the real placements and
-- their real hashes, not typed by whoever wants the yes. The runtime calls
-- this on behalf of a person it has already authenticated, and passes who
-- that was.
create function public.request_campaign_proof_publish_v6(
  p_campaign_id uuid, p_actor uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_placement record;
  v_lines text[] := array[]::text[];
  v_destinations text[] := array[]::text[];
  v_count integer := 0;
  v_scope jsonb := '[]'::jsonb;
  v_approval public.campaign_action_approvals%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service can request a campaign action.';
  end if;
  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  if not found then raise exception 'No such campaign.'; end if;

  select * into v_manifest from public.campaign_manifest_versions
   where campaign_id = p_campaign_id
   order by version desc limit 1;
  if not found then
    raise exception 'This campaign has no package yet. Plan it before asking to publish its proof.';
  end if;

  -- Only drafts. A placement already under its own approval belongs to that
  -- decision, and sweeping it into a campaign request would be two people
  -- answering for the same words.
  for v_placement in
    select pl.id, pl.payload_hash, pl.destination_key, d.label, pl.artifact_version_id
      from public.proof_placements pl
      join public.proof_destinations d on d.destination_key = pl.destination_key
     where pl.campaign_id = p_campaign_id
       and pl.client_id = v_campaign.client_id
       and pl.status = 'drafted'
     order by pl.created_at
  loop
    -- 218's precondition for the placement decision, re-checked here because
    -- this path does not go through request_proof_placement_approval_v6.
    if v_placement.artifact_version_id is not null and not exists (
      select 1 from public.proof_artifact_signoffs s
       where s.artifact_version_id = v_placement.artifact_version_id) then
      raise exception 'Approve the source and claim of every artifact before asking to publish this campaign''s proof.';
    end if;
    v_count := v_count + 1;
    v_lines := v_lines || (v_placement.id::text || ':' || v_placement.payload_hash);
    if not (v_placement.label = any (v_destinations)) then
      v_destinations := v_destinations || v_placement.label;
    end if;
    v_scope := v_scope || jsonb_build_array(jsonb_build_object(
      'placement_id', v_placement.id,
      'payload_hash', v_placement.payload_hash,
      'destination_key', v_placement.destination_key));
  end loop;

  if v_count = 0 then
    raise exception 'This campaign has no drafted proof placements to publish.';
  end if;

  -- One hash over the whole set, so the approval is bound to this exact
  -- collection of payloads. Adding a placement afterwards changes it, which
  -- is the point: the new one was not in what anybody read.
  select * into v_approval from public.request_campaign_action_approval_v6(
    v_manifest.id,
    'proof_publish:' || p_campaign_id::text || ':' ||
      encode(sha256(convert_to(array_to_string(v_lines, '|'), 'UTF8')), 'hex'),
    'proof_publish',
    array_to_string(v_destinations, ', '),
    encode(sha256(convert_to(array_to_string(v_lines, '|'), 'UTF8')), 'hex'),
    jsonb_build_object('placements', v_scope, 'placement_count', v_count));

  -- The placement approvals, hanging off that one decision. Pending until
  -- the campaign action is decided and the executor releases them.
  insert into public.proof_placement_approvals (
    client_id, placement_id, destination_key, payload_hash, scope,
    campaign_action_approval_id, requested_by)
  select v_campaign.client_id, pl.id, pl.destination_key, pl.payload_hash,
         jsonb_build_object('destination_key', pl.destination_key,
                            'source_proof_id', pl.source_proof_id,
                            'campaign_id', p_campaign_id),
         v_approval.id, p_actor
    from public.proof_placements pl
   where pl.campaign_id = p_campaign_id
     and pl.client_id = v_campaign.client_id
     and pl.status = 'drafted';

  update public.proof_placements pl
     set status = 'awaiting_approval',
         approval_id = a.id
    from public.proof_placement_approvals a
   where a.campaign_action_approval_id = v_approval.id
     and a.placement_id = pl.id
     and pl.status = 'drafted';

  insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
  select a.placement_id, a.client_id, 'requested', 'human',
         'Asked as part of this campaign''s proof publication.'
    from public.proof_placement_approvals a
   where a.campaign_action_approval_id = v_approval.id;

  return v_approval.id;
end $$;

comment on function public.request_campaign_proof_publish_v6(uuid, uuid) is
  'Builds one campaign-level proof publication request from a campaign''s drafted placements, naming every placement and payload hash in its scope, and hangs a pending placement approval off it.';

revoke all on function public.request_campaign_proof_publish_v6(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.request_campaign_proof_publish_v6(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Releasing, after the yes
-- ---------------------------------------------------------------------------

-- What migration 230's executor calls for action_key 'proof_publish'. It
-- performs no external write: it converts one campaign-level human decision
-- into the placement approvals that decision was about, and leaves the
-- transport to the sweep that owns it.
create function public.release_campaign_proof_placements(p_execution_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_execution public.campaign_action_executions%rowtype;
  v_approval public.campaign_action_approvals%rowtype;
  v_item jsonb;
  v_placement public.proof_placements%rowtype;
  v_mode text;
  v_next text;
  v_released integer := 0;
  v_skipped jsonb := '[]'::jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may release placements.';
  end if;
  select * into v_execution from public.campaign_action_executions where id = p_execution_id;
  if not found then raise exception 'No such execution.'; end if;
  if v_execution.action_key <> 'proof_publish' then
    raise exception 'That execution is a %, not a proof publication.', v_execution.action_key;
  end if;
  select * into v_approval from public.campaign_action_approvals where id = v_execution.approval_id;
  if v_approval.status <> 'approved' then
    raise exception 'That action is %, not approved.', v_approval.status;
  end if;

  for v_item in select * from jsonb_array_elements(coalesce(v_approval.scope -> 'placements', '[]'::jsonb))
  loop
    select * into v_placement from public.proof_placements
     where id = (v_item ->> 'placement_id')::uuid
       and client_id = v_execution.client_id
     for update;

    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'placement_id', v_item ->> 'placement_id',
        'reason', 'The placement no longer exists.'));
      continue;
    end if;
    -- Anything that is not still waiting on this decision has moved on
    -- without it: retracted for a rights change, rejected, already released.
    if v_placement.status <> 'awaiting_approval' then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'placement_id', v_placement.id,
        'reason', 'The placement is ' || v_placement.status || '.'));
      continue;
    end if;
    -- Rights, re-read now rather than trusted from the ask. The trigger
    -- above should already have moved this placement out of
    -- `awaiting_approval`, so reaching this check means something changed
    -- without firing it -- a proof row written by a path that bypasses the
    -- trigger, say. 218's rule is that rights are checked at placement and
    -- not at request, and this is the placement decision being made.
    if exists (
      select 1 from public.client_proof_assets p
       where p.id = v_placement.source_proof_id
         and (p.usage_rights <> 'approved'
              or (p.expires_on is not null and p.expires_on < current_date)
              or nullif(btrim(p.permission_basis), '') is null))
    then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'placement_id', v_placement.id,
        'reason', 'Permission for the source proof is no longer in place.'));
      continue;
    end if;
    -- The exact-version check, at the moment of release rather than at the
    -- moment of asking. These are the words a person actually read.
    if v_placement.payload_hash <> (v_item ->> 'payload_hash') then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'placement_id', v_placement.id,
        'reason', 'The payload changed after approval. Draft a new placement.'));
      continue;
    end if;

    update public.proof_placement_approvals
       set status = 'approved', decided_at = now(), decided_by = v_approval.decided_by
     where placement_id = v_placement.id and status = 'pending'
       and campaign_action_approval_id = v_approval.id;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'placement_id', v_placement.id,
        'reason', 'No pending approval for this placement belongs to this decision.'));
      continue;
    end if;

    update public.proof_placements set status = 'approved' where id = v_placement.id;
    insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
    values (v_placement.id, v_placement.client_id, 'approved', 'system',
            'Released by the campaign proof publication a person approved.');

    -- Where it waits next depends on who performs the act, exactly as
    -- decide_proof_placement_approval_v6 decides it.
    select mode into v_mode from public.proof_destinations
     where destination_key = v_placement.destination_key;
    v_next := case v_mode
                when 'api' then 'queued'
                when 'reference' then 'queued'
                when 'assisted' then 'awaiting_manual_placement'
                else 'bound' end;
    update public.proof_placements set status = v_next where id = v_placement.id;
    if v_next = 'queued' then
      insert into public.proof_placement_events (placement_id, client_id, event, actor)
      values (v_placement.id, v_placement.client_id, 'queued', 'system');
    end if;
    v_released := v_released + 1;
  end loop;

  return jsonb_build_object('released', v_released, 'skipped', v_skipped);
end $$;

comment on function public.release_campaign_proof_placements(uuid) is
  'Turns one approved campaign proof publication into the placement approvals it named, re-checking each payload hash at release. Writes nothing externally; the proof sweep owns the transport.';

revoke all on function public.release_campaign_proof_placements(uuid)
  from public, anon, authenticated;
grant execute on function public.release_campaign_proof_placements(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The sweep, and the two schedules 218 left for this migration
-- ---------------------------------------------------------------------------

create function public.enqueue_proof_placement_sweep()
returns uuid language plpgsql security definer
set search_path to 'public' as $$
declare v_job uuid;
begin
  if exists (select 1 from agent_jobs
              where agent_key = 'proof_placer'
                and status in ('queued', 'claimed', 'running')) then
    return null;
  end if;
  -- Only api-mode rows with no blocker are claimable; the view already knows
  -- that, so an empty answer here means there is genuinely nothing to do.
  if not exists (select 1 from proof_placement_due
                  where blocker is null and mode = 'api') then
    return null;
  end if;
  insert into agent_jobs (agent_key, params)
  values ('proof_placer', jsonb_build_object('limit', 5))
  returning id into v_job;
  return v_job;
end $$;

comment on function public.enqueue_proof_placement_sweep() is
  'Queues one proof placement sweep, if an approved placement at an api destination is actually unblocked and no sweep is in flight.';

revoke all on function public.enqueue_proof_placement_sweep() from public, anon;
grant execute on function public.enqueue_proof_placement_sweep() to authenticated, service_role;

-- A lease that ran out is not a failure anybody saw. The attempt may have
-- reached a client's public profile and died before recording it, so this
-- does not requeue: it fails the placement non-retryably and says to go and
-- look. A retried review reply posts twice and there is no unposting it.
create function public.reap_stale_proof_placement_claims()
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_count integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may reap placements.';
  end if;
  with stale as (
    update public.proof_placements
       set status = 'failed', lease_until = null,
           last_error = 'The attempt stopped without recording an outcome. Check the destination before trying again.'
     where status = 'placing' and lease_until is not null and lease_until < now()
     returning id, client_id)
  insert into public.proof_placement_events (placement_id, client_id, event, actor, detail)
  select s.id, s.client_id, 'failed', 'system',
         'The lease expired with no outcome recorded.'
    from stale s;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.reap_stale_proof_placement_claims() from public, anon, authenticated;
grant execute on function public.reap_stale_proof_placement_claims() to service_role;

insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('proof_placer', 'Proof Placer', 'PP', null,
   'Places approved proof at destinations that have an API, re-checking rights, the client switches and the exact approved version immediately before the write, and records the external id it comes back with.',
   array[]::text[])
on conflict (agent_key) do update
  set name = excluded.name,
      initials = excluded.initials,
      description = excluded.description,
      requires_upstream = excluded.requires_upstream;

select cron.unschedule('proof-placement-sweep')
 where exists (select 1 from cron.job where jobname = 'proof-placement-sweep');
select cron.schedule('proof-placement-sweep', '*/10 * * * *',
  $cron$ select public.enqueue_proof_placement_sweep(); $cron$);

select cron.unschedule('reap-stale-proof-placements')
 where exists (select 1 from cron.job where jobname = 'reap-stale-proof-placements');
select cron.schedule('reap-stale-proof-placements', '35 * * * *',
  $cron$ select public.reap_stale_proof_placement_claims(); $cron$);

-- Expiry by the calendar writes no row, which is why 218 wrote this sweep
-- and left it unscheduled. Daily, early, before anybody is looking at the
-- board: a permission that ended overnight should be off the live list by
-- the time somebody reads it.
select cron.unschedule('sweep-expired-proof-placements')
 where exists (select 1 from cron.job where jobname = 'sweep-expired-proof-placements');
select cron.schedule('sweep-expired-proof-placements', '15 3 * * *',
  $cron$ select public.sweep_expired_proof_placements(); $cron$);

select lock_down_definer_functions();
