# Video V4 per-scene audio pipeline — 20 November 2026

The new local scene pipeline combines speech synthesis, two-pass -16 LUFS
normalization, measured duration, forced alignment of the **normalized** MP3,
and exact spoken-word/timing validation. It retries the synthesis once when
alignment quality fails the caller's explicit loss policy. It returns the
audio bytes, alignment, measured loudness, duration and SHA-256 hashes of the
narration and final MP3. It clears its temporary files after success or
failure. Bad policy inputs stop before a provider call.

Tests use a real FFmpeg-generated sine MP3 for the normalise/align handoff and
mocked alignment responses for the retry and hold paths. Focused tests,
runtime typecheck and build passed. No ElevenLabs account was contacted.

This function does not file bytes to client Storage, record cost, choose a
voice, write `video_scenes`, or advance a project. Those writes need exact
scene/version binding, idempotent cost accounting and live provider evidence.
The narration voice and account availability are still unconfirmed. The
video script agent and outward switches remain unchanged.
