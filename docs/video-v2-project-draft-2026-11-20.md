# Video V2 draft intake — 20 November 2026

Migration 666 adds a scoped, idempotent draft entry point on top of the
isolated project schema in PR #370. A current admin or active video approval
manager can create a draft for one client. The request binds an approved video
brief when supplied, and a current campaign route package when supplied.
Campaign and route IDs must be provided together and the route must match the
campaign's current plan fingerprint and latest version at draft creation.

The draft stores the exact request inputs, creator, and route/brief identity.
Reusing a request key with the same inputs returns the same draft; changed
inputs with that key are rejected. The database uses a transaction advisory
lock and a unique client/key index for concurrent retries. No agent job is
queued, and no render, review, attachment, or outward action occurs. A later
start operation must recheck the route and brief before using this draft; a
draft-time check is not an execution authorization.

The idempotent lookup occurs before source-currency checks. A repeated request
for an existing draft still returns that historical draft after its route has
been superseded. A **new** request against the stale route is rejected.

Disposable local verification at migration head 666 passed clean and upgrade
replay, generated types, parity manifest, catalog contract, frontend build,
the existing Video V2 schema fixture, Phase 9 scoped-read fixture, and a new
rollback fixture for draft creation, replay, changed-key rejection, invalid
aspects, cross-client brief rejection, assigned and unassigned manager access,
client-role denial, current and stale route versions, and no queued job.
Final local evidence: `/private/tmp/aa-video-v2-666-idempotency-evidence/`.

Remaining: exact start/stage operations, runtime workers, audio/render/critic, reviewed asset
attachment, Console entry points, hosted provider validation and acceptance.
No hosted migration or switch changed.
