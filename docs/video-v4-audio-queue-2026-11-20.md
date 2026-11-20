# V4 storyboard-to-audio handoff

Migration 670 registers a paused `video_audio` agent and adds a service-only
handoff. An independently accepted storyboard moves from `needs_human` to
`timing` and queues exactly one job per current IR scene in one transaction.
The handoff locks and rechecks the reviewed source and campaign route. A
replayed script job completes the queue without another model call. A failed
independent review remains in human review.

The audio worker checks the exact project, scene, version and narration hash,
the Storage target, and the absence of an existing unreceipted object before
any speech request. A service-only attempt row is inserted first so a retry
cannot silently make a second paid request after an uncertain first attempt.
The worker uses the V4 synthesis, normalization, alignment and Storage filing
functions. The last completed scene marks the project `timed` only after every scene has a
current receipt and matching Storage object identity. The renderer and final
human review are still open.

The agent remains paused by default, and its alignment loss policy is
intentionally unset. A managed ElevenLabs key, fixed voice ID and reviewed
policy must be configured before it can be released. The worker does not
invent USD cost when the provider usage is unknown. Any crash after attempt
start and before receipt requires reconciliation; automated retry and cost
accounting are V7 work. No real ElevenLabs request, hosted Storage write,
migration or outward switch change was made in this source slice.

Local evidence: the disposable schema replay at
`/private/tmp/aa-video-v4-670-audio-queue-evidence-final/` passed clean and
released-to-current migration replay, catalog, generated types, lock-order and
the V2/V3 start fixtures. Its scene-commit fixture then exposed an ambiguous
test alias. The alias was corrected without changing the migration or types;
that rollback-only fixture passed against a separate disposable database at
the same migration head. The full combined CI job remains the exact-head gate.
Focused video-script, video-audio and Storage filing tests (15), runtime
typecheck/build, and the runtime parity manifest passed locally.
