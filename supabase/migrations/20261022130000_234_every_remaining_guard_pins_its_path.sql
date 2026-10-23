-- The other nine, and the end of this particular list.
--
-- 224 pinned one trigger guard's search_path. 233 pinned a second, which 230
-- had inherited by copying 218's pattern. Both migrations made the same
-- argument and both left the rest of the list alone on the grounds that the
-- one in front of them was the one they could honestly claim. Nine remain,
-- every one a trigger guard, and the argument for fixing them is the one
-- those two already made:
--
--   The practical exposure is nil. Each of these raises on a disallowed
--   change or stamps a timestamp; there is no unqualified object reference
--   for a hostile search_path to redirect.
--
--   A warning somebody has decided to live with is a warning nobody reads.
--   Nine is enough to make `function_search_path_mutable` a thing people
--   scroll past, which is how the tenth one — the one that does matter —
--   gets missed.
--
--   "It only raises" is a fact about the body as written today. The next
--   person to add a lookup to one of these inherits a mutable path with
--   nothing in the file to tell them.
--
-- Where they came from, so the list can be audited rather than trusted:
--
--   175  protect_approved_video_version
--   196  stamp_workflow_review_ready_at
--   205  guard_campaign_manifest_immutable
--   206  guard_campaign_action_approval_identity
--   207  guard_campaign_intelligence_snapshot_immutable
--   208  guard_service_offer_version_immutable
--   209  guard_proof_artifact_immutable_v6, require_new_proof_permission_v6
--   213  guard_campaign_page_approval_snapshot_immutable
--
-- 230's `guard_campaign_action_event_append_only` is pinned again at the end,
-- although 233 already pins it. `alter function ... set` is idempotent, and
-- 233 is on an open branch: repeating it here means this migration stands on
-- its own whichever of the two lands first, rather than leaving a window
-- where main has the test below and not the thing it asserts.
--
-- `alter function ... set` throughout, never a recreate, so no body is
-- touched and none of this can drift from what those migrations created.
-- That is also why the two created without a schema qualifier are addressed
-- as `public.` here: that is where they resolved to, and the linter reports
-- them that way.
--
-- A test scans every migration for a trigger function defined without a
-- path and not pinned afterwards, so the next one fails a test rather than
-- waiting for somebody to read the linter.

alter function public.protect_approved_video_version()
  set search_path = pg_catalog, public;

alter function public.stamp_workflow_review_ready_at()
  set search_path = pg_catalog, public;

alter function public.guard_campaign_manifest_immutable()
  set search_path = pg_catalog, public;

alter function public.guard_campaign_action_approval_identity()
  set search_path = pg_catalog, public;

alter function public.guard_campaign_intelligence_snapshot_immutable()
  set search_path = pg_catalog, public;

alter function public.guard_service_offer_version_immutable()
  set search_path = pg_catalog, public;

alter function public.guard_proof_artifact_immutable_v6()
  set search_path = pg_catalog, public;

alter function public.require_new_proof_permission_v6()
  set search_path = pg_catalog, public;

alter function public.guard_campaign_page_approval_snapshot_immutable()
  set search_path = pg_catalog, public;

-- Already pinned by 233, repeated so this migration does not depend on the
-- order the two branches merge in. Idempotent: setting a function's
-- search_path to what it already is changes nothing.
alter function public.guard_campaign_action_event_append_only()
  set search_path = pg_catalog, public;
