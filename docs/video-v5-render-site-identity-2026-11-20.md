# V5 renderer site identity

Migration 675 records the exact deployed Remotion site URL with each Lambda
function, render ID, bucket and output name. The service handle RPC is versioned
to `record_video_project_lambda_handle_v2`; a repeated write must match all
fields, including the site. Runtime resume refuses a provider handle whose
stored site differs from the current deployment input. This preserves which
renderer code was used when the output is later reviewed.

Disposable local evidence at
`/private/tmp/aa-video-v5-675-site-evidence-final` passed clean and
released-to-current upgrade replay, generated types, catalog contract, B006,
video V2–V5 rollback fixtures and Phase 9 scoped reads. The render fixture
also rejects a changed site on replay. Six focused Lambda/handoff tests and
runtime typecheck passed. The render agent remains paused. No hosted migration,
Lambda render or outward switch change occurred.
