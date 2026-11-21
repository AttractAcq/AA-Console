# Video V8 evaluation source slice

The 20-topic fixture is `agent-runtime/eval/video/ideas.json`. It spans intake,
offers, campaigns, proof, paid handoff, source lineage and attribution. Six
cases contain explicitly synthetic source records; the others test an
operator-only idea without external facts. These records are evaluation data,
not publishable client evidence.

`npm run eval:video -- --check` validates the fixture count and prints its
SHA-256 and the component-catalogue SHA-256. It makes no model call.

The paid evaluation must be started manually from `agent-runtime` with a
configured `VIDEO_SCRIPT_MODEL` and either `ANTHROPIC_API_KEY_VIDEO_SCRIPT` or
`ANTHROPIC_API_KEY`. It requires `--limit`, `--max-usd` and `--out` (a new JSON
path). For example, the operator can run one case first:

```sh
npm run eval:video -- --limit 1 --max-usd 2 --out /private/tmp/aa-video-eval-one.json
```

The `--max-usd` value is an **estimated stop threshold checked between cases**,
not a hard provider spend cap. A case can pass the threshold and a provider
error can have unknown billing. The file is created with owner-only permissions
and is never overwritten. The report records model, fixture/catalogue hashes,
writer validation, writer attempts, independent-review verdict and edits,
estimated cost, accepted IR with citations and its digest. Failed cases remain
in the report. The report's `visionCriticOutcomes`, `goldRenders` and
`humanReview` are null or empty until those separate stages produce evidence.

This is the script/review part of V8. A 20-topic real-model run, three
audio-complete gold renders, visual critic outcomes, cost reconciliation and
human assessment remain required for the quality baseline. It does not prove
that an MP4 can be produced or that the video gate is accepted. No production
switch or provider configuration changes with this source slice.
