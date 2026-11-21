# V8 local gold-render preflight — 21 November 2026

Three hand-written IR/timing pairs now cover a nine-scene campaign journey,
a five-scene opportunity-to-offer explanation, and a five-scene proof-rights
explanation. The additional pairs are `gold-02` and `gold-03` under
`video-render/fixtures/{ir,timings}`. The compiler test validates the pairs,
scene counts, timing IDs and deterministic frame count.

Using local headless Chrome and Remotion, one aspect of each pair rendered to
H.264 MP4. The copies for Alex's review are in
`/Users/alex/Desktop/AA-video-V8-gold-2026-11-21/`:

| File | Aspect | Duration | SHA-256 |
|---|---:|---:|---|
| `A-clearer-route-to-growth-1x1.mp4` | 1080×1080 | 120.0 s | `9758be27ac5592cd92979896d8200f536cc9524023074f16ecb1cc9c7edffb5b` |
| `From-opportunity-to-offer-16x9.mp4` | 1920×1080 | 24.6 s | `2e3e771cbcb01b9d63479388466702eff692127254e552b7420a73cde20378f9` |
| `Proof-with-permission-9x16.mp4` | 1080×1920 | 24.6 s | `af2ef03bbaa1c9a2fd90d8d02ea8677fb1dcdf438cb9a8dcb91ed1e668dc00ec` |

`ffprobe` confirmed each codec, dimensions, frame rate and duration. `ffmpeg`
decoded each whole file without an error. A frame from each was inspected for
obvious clipping; that sample does not prove every frame is visually correct.

These fixtures use `audioSrc: null` and empty word timings. **They are silent
local visual preflights**, not finished narrated videos, model-written outputs,
vision-critic passes or human-approved assets. They do not satisfy the full V8
or prompt-to-MP4 acceptance gate. The three aspects were each exercised on a
different topic; every aspect of every topic remains untested. No Lambda,
ElevenLabs, production route, outward switch or paid evaluation was used.

Reproduce from `video-render` after installing dependencies:

```sh
npm run build
AA_VIDEO_OUT_DIR=/private/tmp/aa-video-v8-gold npm run render:ir -- fixtures/ir/gold-v2.json fixtures/timings/gold-v2.json 1:1
AA_VIDEO_OUT_DIR=/private/tmp/aa-video-v8-gold npm run render:ir -- fixtures/ir/gold-02.json fixtures/timings/gold-02.json 16:9
AA_VIDEO_OUT_DIR=/private/tmp/aa-video-v8-gold npm run render:ir -- fixtures/ir/gold-03.json fixtures/timings/gold-03.json 9:16
```

The local run supplied `AA_REMOTION_BROWSER` pointing to the installed Google
Chrome executable. The output hashes can change with renderer or browser
versions; check the fixture and build identities when comparing future renders.
