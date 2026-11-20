# Video V3 atomic scene commit — 20 November 2026

Migration 668 adds a service-only storyboard commit. It locks the video
project, selected model sections, approved brief and bound campaign route,
then checks source currency. It writes the reviewed IR, citation packet and
ordered `video_scenes` rows in one transaction. Unknown citations, wrong job
or IR version, stale sources, existing scenes and malformed scene packets
reject the whole write. The project remains `needs_human`; no audio, render,
asset attachment, publication or approval is implied.

The `video_script` runtime now calls this RPC after its independent review.
It records writer/reviewer usage separately and handles a failed commit as a
held job. The rollback-only fixture tests browser denial, invalid citation
without partial rows, exact three-scene commit, replay denial and stale-model
denial. Clean and released-to-current schema replay, generated types, catalog
contract, Video V2/V3 rollback fixtures and the Phase 9 scoped-read fixture
passed on a disposable database. Evidence:
`/private/tmp/aa-video-v3-668-scene-evidence-pass/`. This is source
preparation; it does not unpause the agent or alter a hosted project.

The renderer has still not compiled a real writer output. The next gates are
the ten-topic V3 evaluation, actual scene narration/audio alignment, renderer
compile and human review. A local fixture validates the database contract,
not provider output or production data.
