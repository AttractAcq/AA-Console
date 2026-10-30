-- Rule 6 / 280: a `supported` flag is a promise that something can perform
-- the action. Four of them are promises nothing keeps.
--
-- The build blueprint states the rule twice. §1.1 rule 6: "A database
-- `supported` flag may be true only when the deployed runtime has the
-- matching handler and required credentials are configured for that client."
-- The §6 final sign-off rule: "no known unsupported action is labeled
-- supported". §6 also names two of these as fail conditions to exercise --
-- "the migration-239 support/handler mismatch" and "PR-233 migration-260
-- support/handler mismatch" -- so this is a gating condition, not tidying.
--
-- WHY A FALSE PROMISE IS WORSE THAN A MISSING ONE
--
-- `campaign_action_due` sets its blocker from `supported is not true`, and
-- `claim_campaign_actions` takes any approved row the view has cleared. It
-- has no action-key filter and asks no handler whether it exists. So a row
-- marked supported with no handler behind it is not inert: it is claimable.
-- The claim consumes an attempt, the executor finds nothing registered, and
-- `record_campaign_action_failure` writes a nonretryable failure, which the
-- due view then reports as "Abandoned after a failure that cannot be safely
-- retried". The exact human approval is spent. A person decided once, on a
-- specific version, and the decision was burned by a flag rather than by
-- anything about the decision.
--
-- The honest state costs nothing by comparison. With `supported` false the
-- same view says "There is no executor for meta ad build yet.", the approval
-- stays approved and visible, and the work to do is named.
--
-- WHICH FOUR, AND THE EVIDENCE FOR EACH
--
-- campaign_action_executors.meta_ad_build: the deployed runtime registers
--   four handlers (proof_publish, page_deploy, lead_message, budget_change)
--   in agent-runtime/src/campaigns/actions/executor.ts. meta_ad_build is not
--   among them. The v6 gate assert_meta_build_allowed_v6 exists and the
--   meta_build agent consults it, but that agent writes nothing to
--   campaign_action_executions, so campaign_launch_readiness -- which needs
--   status 'executed' -- can never read green for this deliverable while the
--   generic claim is what burns the approval.
--
-- campaign_action_executors.profile_update: migration 254 anticipated the
--   executor and said so. No handler was registered, and the deployed
--   runtime now holds every profile field patch before any claim
--   (agent-runtime/src/profiles/prewrite-gate.ts). A recorded profile change
--   is a proposal, not an applied field.
--
-- proof_destinations.organic_social and .paid_advertising: migration 218
--   seeded both false "until placements are recorded against those posts",
--   and that is still the case. proof_placement_due only clears api-mode
--   destinations to the sweep, and agent-runtime/src/proof-distribution/
--   placer.ts has transport for the google_business provider alone --
--   everything else raises "There is no transport in this runtime for ...",
--   nonretryably. Both of these are api mode with provider meta.
--
-- WHAT THIS DOES NOT CHANGE
--
-- Not organic posting, which runs through the publish sweep and its own
-- approval, and is the reason organic_publish is deliberately false already.
-- Not google_ad_build or campaign_launch, already false for stated reasons.
-- Not profile_field_support: `writable` there describes what a platform
-- permits an adapter to write, which is a fact about Meta and Google, not a
-- claim about this runtime. The runtime-capability gate for a profile write
-- is profile_update, corrected here.
--
-- Not the generic claim hold either. docs/campaign-action-claim-hold.md
-- holds every generic claim in the runtime until an atomic SQL claim
-- contract exists, and asked for exactly this correction as separate work:
-- "A later migration must also correct currently over-advertised support
-- flags". That hold is a runtime state the runtime reports. This is the
-- database's own claim about which adapters exist, which is why the four
-- handler-backed rows stay true and carry an attestation instead.

-- ---------------------------------------------------------------------------
-- The corrections
-- ---------------------------------------------------------------------------

update public.campaign_action_executors
   set supported = false,
       note = 'The v6 approval gate exists (assert_meta_build_allowed_v6) but no runtime action handler is registered for meta_ad_build, so an approved build is claimed and abandoned rather than built. Supported again only when a registered handler performs the build and records its execution, attested against the deployed runtime build.'
 where action_key = 'meta_ad_build';

update public.campaign_action_executors
   set supported = false,
       note = 'Migration 254 anticipated this executor and no handler was registered. The deployed runtime additionally holds every profile field patch before any claim (profiles/prewrite-gate.ts), so an approved profile change is a recorded proposal, not an applied field. Supported again only when the exact-version decision, a registered handler and the last-moment prewrite check are connected together.'
 where action_key = 'profile_update';

update public.proof_destinations
   set supported = false,
       note = 'Migration 218 seeded this false until placements are recorded against the scheduled posts, and that is still outstanding. This is an api-mode destination, so proof_placement_due clears it to the sweep, but proof-distribution/placer.ts has transport for the google_business provider only and raises nonretryably for anything else. Organic posting itself is unaffected: it runs through the publish sweep, not this one.'
 where destination_key = 'organic_social';

update public.proof_destinations
   set supported = false,
       note = 'Same transport gap as organic_social: an api-mode destination the placer has no provider branch for, so a claim is abandoned. Meta Ads Studio placing a creative is not the same act as this sweep recording a proof placement against it, which is what remains to be built.'
 where destination_key = 'paid_advertising';

-- ---------------------------------------------------------------------------
-- The guard, so rule 6 is enforced rather than restated
-- ---------------------------------------------------------------------------

-- Correcting four rows does nothing about the fifth time this happens. The
-- rule needs a claim that cannot be made silently: naming the deployed build
-- whose handler map was read. A migration author who cannot name one has not
-- checked, which is the whole mistake. The runtime already computes the same
-- comparison in campaigns/actions/support.ts and reports unhandled supported
-- keys through readiness, so a wrong SHA here is observable rather than
-- merely asserted.
alter table public.campaign_action_executors
  add column handler_attested_sha text,
  add column handler_attested_at timestamptz;

comment on column public.campaign_action_executors.handler_attested_sha is
  'The full 40-character runtime commit whose registered handler map was read when this action was marked supported. Required for supported = true. It records that an adapter exists in that build, not that the runtime is currently accepting claims: the generic claim hold is separate and the runtime reports it.';

comment on column public.campaign_action_executors.handler_attested_at is
  'When the attested build was checked against this row.';

-- The four the deployed runtime does register, read from HANDLERS in
-- agent-runtime/src/campaigns/actions/executor.ts at this commit, which the
-- live heartbeat reported as the running runtime version.
update public.campaign_action_executors
   set handler_attested_sha = '92191b3e854abce86f9f5f8cd7810f86ba318b9d',
       handler_attested_at = now()
 where supported;

alter table public.campaign_action_executors
  add constraint campaign_action_executors_attested_sha_shape
    check (handler_attested_sha is null or handler_attested_sha ~ '^[0-9a-f]{40}$');

-- Validated against the rows above, so this migration fails here rather than
-- in production if any correction above was missed.
alter table public.campaign_action_executors
  add constraint campaign_action_executors_supported_needs_attestation
    check (not supported
           or (handler_attested_sha is not null and handler_attested_at is not null));

comment on table public.campaign_action_executors is
  'Which approved campaign actions something can actually perform, and for the rest, what is missing. The same discipline as proof_destinations: unsupported is a visible state, not silence. A row may claim supported only while naming the deployed runtime build whose handler map was read for it.';
