# AA code-rendered video library

This package is a local Remotion development renderer. It does not run in the deployed Console. Before production rendering, resolve the Remotion licence decision in `LICENSE-NOTE.md` and the audio/render service dependencies.

## Hand-written IR

`fixtures/ir/gold-v2.json` is a nine-scene, two-minute example. Its paired `fixtures/timings/gold-v2.json` has silent timing values so the compiler and layout can be tested without a voice provider. `fixtures/ir/three-scene-v2.json` and its timings demonstrate that a different video renders without adding a new component or writing per-video source code. The three-scene fixture uses synthetic word times to exercise captions and reveal timing; those values are not speech-alignment evidence.

The IR includes title, audience, tone, requested aspects, music intent and 3–40 scenes. A scene names a catalogue component, its validated props, narration, transition, optional minimum length, chapter marker and lock state. Timings bind by exact scene ID and provide audio length, word alignment and an optional audio source. `compile()` validates both documents and returns a serializable 30 fps timeline. The JSON Schema and component catalogue in `generated/` are copied byte-for-byte to `agent-runtime/src/video/`.

## Local commands

```bash
cd video-render
npm ci
npm run build
npm test
AA_REMOTION_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:visual
AA_REMOTION_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run render:ir -- fixtures/ir/three-scene-v2.json fixtures/timings/three-scene-v2.json 16:9
```

Omit the final aspect to render every aspect requested in the IR. `AA_VIDEO_OUT_DIR` selects the local output directory; otherwise MP4s go under ignored `out/`. The browser variable points to an installed Chrome binary when Remotion cannot download its own browser. `npm run studio` lists component demonstrations, the V1 Gold fixture and the V2 `VideoIR-*` compositions.

Run `node scripts/export-ir-schema.mjs --check` and `node scripts/export-v2-fixture.mjs --check` before committing changes to component schemas or fixtures. The CI video job enforces both, and the runtime test checks that the copied schema and catalogue are identical.

The renderer remains a source-level V2 slice: hosted video project tables, agents, Console Video Studio, real narration alignment, critic, exact review, downloadable accepted output and operational acceptance remain open.
