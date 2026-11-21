# Video V8 evaluation source slice

The 20-topic fixture is `agent-runtime/eval/video/ideas.json`. It spans intake,
offers, campaigns, proof, paid handoff, source lineage and attribution. Six
cases contain explicitly synthetic source records; the others test an
operator-only idea without external facts. These records are evaluation data,
not publishable client evidence.

`npm run eval:video -- --check` validates the fixture count and prints its
SHA-256 and the component-catalogue SHA-256. It makes no model call.

`npm run eval:video -- --plan --start 11 --limit 10` prints the selected case
IDs and the same hashes without a model call. `--start` is one-based and
defaults to 1. The range must fit within the twenty cases. This lets an
operator evaluate cases 11–20 after cases 1–10 without paying to rerun them.

The paid evaluation must be started manually from `agent-runtime` with a
configured `VIDEO_SCRIPT_MODEL` and either `ANTHROPIC_API_KEY_VIDEO_SCRIPT` or
`ANTHROPIC_API_KEY`. It requires `--limit`, `--max-usd` and `--out` (a new JSON
path). For example, the operator can run one case first:

```sh
npm run eval:video -- --limit 1 --max-usd 2 --out /private/tmp/aa-video-eval-one.json
```

Use a new output path for each batch, for example with `--start 11 --limit 10`.
The output file is reserved before the first provider call with owner-only
permissions, then atomically updated before and after each case. A running
report names `activeCaseId`; after a process interruption, that case's provider
outcome and billing must be reconciled before it is run again. A provider or
runtime error with unknown billing stops the batch before the next case.
`runStatus` distinguishes complete, estimated-budget stop and unknown-billing
stop. `selectedCaseIds`, fixture/catalogue hashes and the model make separate
batch reports comparable. A non-accepted review fails `qualityGatePassed` and
the command exits nonzero even when the report is complete.

The `--max-usd` value is an **estimated stop threshold checked between cases**,
not a hard provider spend cap. A case can pass the threshold and a provider
error can have unknown billing. An existing output path is never overwritten by
a new run. The report records model, fixture/catalogue hashes,
writer validation, writer attempts, independent-review verdict and edits,
estimated cost, accepted IR with citations and its digest. Failed cases remain
in the report. The report's `visionCriticOutcomes`, `goldRenders` and
`humanReview` are null or empty until those separate stages produce evidence.

This is the script/review part of V8. A 20-topic real-model run, three
audio-complete gold renders, visual critic outcomes, cost reconciliation and
human assessment remain required for the quality baseline. It does not prove
that an MP4 can be produced or that the video gate is accepted. No production
switch or provider configuration changes with this source slice.
