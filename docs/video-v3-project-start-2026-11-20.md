# Video V3 project start and script worker — 20 November 2026

Migration 667 adds an explicit start gate to a manual video draft. A client
video approval manager or admin supplies the draft's expected IR version, up
to twelve model section IDs, and an optional operator note. The start RPC
rechecks its brief and latest campaign route, requires each model section to
have a current supported review, snapshots its text and review identity, and
queues one `video_script` job. The model sections and operator note remain
separate in the snapshot. Source and intake identity cannot be edited after
the project leaves draft.

The new agent is **paused by default**. Once a later release deliberately
enables it, the runtime checks the exact project/job/source identity before
and after writing. It uses the source-bound storyboard writer and the bundled
component catalogue. It stores a validated IR and scene source IDs as a
draft in `needs_human`; renderer compile and independent claim review remain
pending. A stale source moves the project to human review without storing its
output. The service-only cost RPC records one receipt per job attempt and
rejects a changed retry of that receipt. No video is rendered, attached,
approved, published, or sent to a provider by this stage.

Local checks: full clean and released-to-current schema replay, generated
types, catalog contract, Video V2 schema and draft fixtures, the new rollback
fixture for paused-start, wrong-version, cross-client, source-current and cost
guards, and the Phase 9 scoped-read fixture passed in
`/private/tmp/aa-video-v3-667-final-evidence-pass/`. Runtime typecheck and
build passed; the built runtime includes the component catalogue. Three
focused worker tests passed, covering stale preflight, source change during
writing and an idempotent successful job replay. Tests use a mock completion;
they do not spend model tokens or establish provider behavior.

This is a stacked source candidate. It has not been applied to staging or
production. The project still needs the UI start control, real completion
test, renderer timeline compile, audio, visual and claim review, finished
MP4 generation, exact approval and operational acceptance. V1 visual and
licence decisions remain open. Phases 8 and 9 remain unaccepted; outward
switches were not changed.
