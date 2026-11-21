# Video V2 project schema checkpoint — 20 November 2026

Migration `20261124054000_665_video_projects_core.sql` adds `video_projects`,
`video_scenes`, and `video_project_costs`. It leaves all existing Motion Design
tables, candidates, decisions, attachments, and jobs intact. The new route is
not active and has no browser or worker write path yet.

Each scene and cost row carries a client ID constrained to the parent project
by a composite foreign key. Authenticated clients can read only their entitled
client rows through RLS. Direct browser insert, update, and delete privileges
are revoked; future writes must use separately reviewed scoped functions or
the service role. The schema records IR versions, scene timing/alignment,
stage, errors, critic reports, and per-stage cost. It does not declare an IR
approved, attach it to a campaign, or publish a video.

Disposable local verification at head 665 passed clean replay,
released-to-current upgrade equivalence, catalog contract, generated database
types, the existing Phase 9 scoped-read fixture, and the Video V2 rollback
fixture. The latter checked cross-client foreign keys, aspect validation,
read-only grants, client-scoped RLS, and preservation of legacy table names.
Evidence is in `/private/tmp/aa-video-v2-665-schema-evidence-verified/`.
The first fixture run found an inherited browser write grant; the migration
now explicitly revokes it and the second run passed.

Next: create scoped project/stage functions with exact-version review and
invalidation, implement runtime agents and audio/critic/render stages, bind
the new output to Content Production and Campaign Factory, then complete
operator and hosted acceptance. No hosted migration or outward switch changed
at this checkpoint.
