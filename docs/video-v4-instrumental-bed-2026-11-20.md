# V4 instrumental music preparation

This slice adds a guarded client for ElevenLabs' [Compose Music API](https://elevenlabs.io/docs/api-reference/music/compose/).
It requests `music_v2_5`, MP3, and `force_instrumental: true` from a bounded
prompt based on the video's mood and tone. The response keeps its `song-id`
when supplied. Local FFmpeg processing normalizes the returned MP3 to -24
LUFS and records duration and SHA-256. No API request was made by the tests.

The [API reference](https://elevenlabs.io/docs/api-reference/music/compose/)
accepts 3,000–600,000 ms, while the provider's [music overview](https://elevenlabs.io/docs/overview/capabilities/music)
describes a five-minute maximum. Requests are conservatively capped at five
minutes; the renderer's audio-bed component can loop a shorter bed for a
longer video. Exact loop quality and rights still require human QA.

Music is optional. The deterministic IR compiler now permits a requested
music bed with no `musicSrc`; the composition renders its narration without
music. The original IR request remains visible for audit. The orchestration
stage must still record a failed/disabled music attempt and file a successful
bed in client Storage with versioned provenance. This code has no Storage
write, hosted migration, provider cost, finished render or outward action.

Mocked transport tests cover request shape, instrumental enforcement, error
classification and response validation. A local four-second sine fixture
tests real -24 LUFS normalization, hashing and duration. Renderer compiler
tests cover the no-bed fallback; runtime and renderer builds passed locally.
