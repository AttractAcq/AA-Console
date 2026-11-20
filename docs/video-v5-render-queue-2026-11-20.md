# V5 exact render queue

Migration 674 queues one `video_render` job for a `timed` project after its
scene audio, optional music outcome and current source pass the existing
service checks. A unique project/version index and an idempotent queue RPC
prevent duplicate render jobs. The audio worker calls that RPC after the
terminal music decision and on a later `timed` replay. The render agent remains
paused, so queuing does not call AWS or make a video public.

The disposable rollback fixture now checks queue idempotence, stale IR and
browser denial before the exact-aspect Lambda claim. Local evidence at
`/private/tmp/aa-video-v5-674-render-queue-evidence-final` passed clean and
released-to-current replay, catalog, generated types, B006, video V2–V5
fixtures and Phase 9 scoped reads. Fifteen focused audio/worker tests and
runtime typecheck passed. No hosted migration, Lambda render or outward
switch change occurred.
