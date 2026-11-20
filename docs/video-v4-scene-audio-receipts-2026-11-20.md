# V4 exact-scene audio filing contract

Migration 669 adds one receipt per `video_scenes` row. The service-only upload
target checks the current project, IR version, scene, source review and route
before Storage upload. The file path includes client, project, IR version and
scene key. The runtime uploads without upsert, downloads the stored MP3, hashes
its bytes, checks the Storage object identity twice, and commits the path,
alignment words, loss, duration, loudness, voice, model and attempts in one
database transaction. A retry with the same file and receipt is idempotent;
different bytes or a replaced Storage object are held.

The runtime does not call ElevenLabs or write Storage until a later audio worker
uses this function. The current storyboard remains at `needs_human`; no worker
advances it to `timing` yet. The exact final review, renderer, cost receipt and
post-filing Storage read-back are also separate future stages. The SQL verifies
object identity and scene provenance, while the runtime verifies actual bytes;
the renderer must recheck the receipt and object before using it. No hosted
migration, audio API call, outward switch or accepted video is implied here.

Local checks: `file-scene.test.ts` covers upload/retry, byte mismatch, changed
Storage identity, stale scene and forged generated digest. The disposable
`video-v4-scene-audio-smoke.sql` covers service-only access, source currency,
exact target, idempotence, conflicting replay and replaced object. The schema
replay also checks released-to-current upgrade, clean reset, catalog and
generated TypeScript types.
