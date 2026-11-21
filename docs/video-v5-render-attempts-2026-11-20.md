# V5 durable render attempts

Migration 673 adds a paused `video_render` agent and one render attempt per
project, IR version and aspect. A service-only claim rechecks the exact timed
project, source, audio and job before any Lambda call. It returns the existing
attempt on replay, including a started or uncertain state; it does not create a
second attempt. The handle writer binds the returned region, function, render
ID, bucket and expected output name to the same claim. A start with no handle
can be marked uncertain, which remains visible and requires provider
reconciliation before another render can be proposed.

The project remains at `timed` while these early attempts are claimed. The
render worker, completion/probe receipt and transition to `rendering` and
`rendered` are still required. The agent stays paused. The rollback fixture
does not invoke AWS.

Disposable local evidence at
`/private/tmp/aa-video-v5-673-render-attempt-evidence-v3` passed clean replay,
released-to-current upgrade equivalence, generated types, catalog contract,
B006, video V2–V5 rollback fixtures and Phase 9 scoped reads. The first two
local runs caught a wrong registry column and a fixture assertion ordering
error; both were corrected before this passing run. No hosted migration,
provider call or outward switch change occurred.
