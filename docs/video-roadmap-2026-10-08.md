# Video: what is done, and what completing it means — 8 October 2026

Supersedes the **Spike status** and **Suggested phasing** sections of
`ai-video-edit.md`, which were written on 1 October and are now wrong in the
direction that matters: they describe the editor as unbuilt and unproven, and
it has cut three reels, one of which is approved.

Every count below is from production today.

---

## What the 1 October doc got wrong, because it is load-bearing

That doc says `video_edit` "is not registered as an agent, has no migration,
and the worker never imports it", and that there is "no real Higgsfield clip
to cut, and no reel has been briefed". All of it has changed:

| Claim on 1 Oct | Today |
|---|---|
| Not registered, no migration | Migration 141 registered it; `dispatch.ts` imports `runVideoEditJob` |
| `ffmpeg` not in the image | `apk add --no-cache ffmpeg` in the runtime stage |
| No Higgsfield clip exists | **6 clips on `clip_path`**, from 121 frames all with stills |
| No model has been called | **3 cuts completed**, 54,798 in / 11,868 out tokens |
| No reel briefed | 1 reel brief with a shot plan, 3 reel assets, **1 approved with a cut** |

**And the cost estimate was 6× too high.** The doc priced Opus 5.5 at ~$1.20
per reel from ~100K input tokens. Three real cuts cost **$0.5707 total — about
$0.19 each**, on ~18K input tokens per cut rather than 100K. That matters for
the model comparison below: the doc priced it at $20–40 and sign-off; it is
closer to **$2**.

The failure log reads as a clean narrative, which is worth knowing when
judging whether this path is fragile:

```
3 Oct  video_build ×2  Motion paused: HIGGSFIELD_* not set
4 Oct  video_build ×2  Motion paused: HIGGSFIELD_* not set
4 Oct  video_build     Higgsfield is still rendering. The request id is stored.
4 Oct  video_edit      The edit needs a clip for every shot. shot 1..6 never submitted.
4 Oct  video_edit      ffmpeg failed: Failed to configure output pad on Parsed_xfade_39
5 Oct  video_edit ×3   completed
```

Keys were set, clips landed, the xfade timebase bug was found and fixed, and
it has worked since. Nothing in that sequence is a design problem.

---

## The gap that blocks everything else

**The engine never cuts the reel.** `slot_pipeline` on production:

| stage | format | agent |
|---|---|---|
| building | *(any)* | `creative_build` |
| building | **reel** | **`video_build`** |
| copywriting | *(any)* | `copywriter` |
| qa | *(any)* | `qa` |

There is no row after `building/reel`. `video_build` finishes by calling
`handOffToSlot`, which finds the newest asset for the brief and advances the
slot to `copywriting` — whether or not anything was cut. So an engine-driven
reel goes:

```
building → (stills + Higgsfield clips) → copywriting → qa → awaiting_approval
```

with `render_path` still null. **A person is asked to approve a reel that has
no video in it.**

Two things make that worse rather than merely wrong:

1. **QA cannot catch it.** The aspect-ratio and duration checks read
   `client_media_assets.width/height/duration_sec`, which only `video_edit`
   writes. A reel that was never cut has nulls, and migration 158 deliberately
   treats a null as "not recorded, nothing to check rather than a fault". So
   an uncut reel scores 100 and passes.
2. **The one approved cut has nulls too**, because it was rendered on 5 October
   and 158 landed on the 6th. So the only reel that *has* been cut is also
   invisible to the check written to police it.

Everything below assumes this is fixed first. Model comparisons and motion
graphics on a pipeline that does not reach the editor are improvements to a
path nothing travels.

---

## Phase 1 — close the loop

**1.1 Give the cut a stage.** `slot_pipeline` is unique on `(stage, format)`,
so `building/reel` cannot have a second agent. The options are a follow-up job
queued by `video_build`, or a new stage. **A new stage is the right answer**,
for a reason specific to this pipeline: Higgsfield is asynchronous and clips
take minutes, so the slot genuinely has a state the current model cannot
express — *waiting on footage*. Today that state is invisible, which is why
the 4 October failure read "shot 1..6 never submitted" rather than "not ready
yet".

- `slot_stage` gains `editing`, with transitions `building → editing` and
  `editing → copywriting`, plus `editing → failed`.
- `slot_pipeline` gains `(editing, reel, video_edit)`.
- `video_build`'s `handOffToSlot` advances a reel to `editing` rather than
  `copywriting`; every other format is unchanged.
- `video_edit` advances `editing → copywriting` on success.
- The readiness gate in `handoff.ts` already distinguishes "waiting on
  Higgsfield" from "never submitted". Surface that on the slot as the
  blocked reason so a reel resting in `editing` says which it is.

Enum value in its own migration, as 163 had to be — `editing` cannot be used
in the transaction that adds it.

**1.2 Make QA refuse an uncut reel.** A null dimension stays "not recorded"
for every other format. For `format = 'reel'` specifically, a null
`render_path` is a blocker, not an absence. This is a check in
`agents/qa/checks.ts` plus a `record_qa_result` guard, in the same shape as
the below-threshold refusal: the agent should not be the only thing enforcing
it.

**1.3 Backfill the one approved cut.** `ffprobe` its `render_path` and write
`width`, `height`, `duration_sec`. One row. Without it the only cut in
existence is the one asset QA cannot check.

**Done when:** a reel slot planned by the engine reaches `awaiting_approval`
with a non-null `render_path`, and an uncut one cannot.

---

## Phase 2 — prove it is good, not merely working

**2.1 The model comparison, now cheap.** Still the open question from the 1
October doc, and the only one of its phases genuinely undone. `spike.ts
--model` already does it. At $0.19 per cut, 5 reels against two models is
about **$2**, not the $20–40 the doc priced — which removes the sign-off that
was holding it up.

Score on what matters rather than on taste: **approval rate unchanged**, cost
per reel, and validator rejections per reel. The last one is the useful
signal — a model that produces plans the validator refuses is expensive twice.

**2.2 Self-review of the render.** In the proposal, not built. Sample frames
from the finished file and ask the model whether the captions are legible,
nothing is cut mid-word, and the end card is readable. Bounded to one revise,
as the planner already is.

**2.3 Caption centring per line.** `drawtext` centres the block, not each
line, so a two-line caption with unequal lines looks wrong. Known, cosmetic,
and the sort of thing that decides whether an operator sends the AI cut or
re-does it by hand.

---

## Phase 3 — let somebody watch it

There is no preview of a finished cut anywhere in the console. The approval
inbox offers "Open the asset", which for a reel is a signed URL to the raw
file — it works, but it opens a tab. The reel shot grid says "Cut on file"
without letting you see it.

An inline `<video>` on the approval card and beside the shot review, from the
same signed URL. Small, and it is the difference between approving a reel and
approving a filename.

---

## Phase 4 — extend

In the order the chain allows, not the order of interest:

**4.1 Transcription-driven cuts** — the Repurposing Engine still writes a
brief instead of a file because "AA cannot cut video". It can now. This needs
Whisper (cents per reel) and a different planner input: a transcript with
timestamps rather than a shot plan.

**4.2 Motion presets beyond one.** Only Zoom In is confirmed in the Higgsfield
catalog; anything else pauses. Worth establishing which ids actually work
before the planner is allowed to choose among them.

**4.3 Remotion, if approvals demand it — and probably not yet.** This is
"Claude Motion Graphics" as far as this codebase has a plan for it, and the
1 October doc argues against it twice: it needs a headless Chromium in the
render image, and Remotion requires a company licence above three employees.
The honest sequencing is that Phase 2's approval-rate number decides this. If
operators approve ffmpeg cuts unchanged most of the time, Remotion is cost
with no buyer.

Note what this is *not*: Claude does not render motion graphics. It would
write Remotion compositions that Remotion renders. Worth being precise about,
because the two have very different infrastructure bills.

---

## Automation and cron, specifically

Five cron jobs went live on production on 8 October. Where video sits in them:

| Job | Schedule | Touches video? |
|---|---|---|
| `engine-tick` | `7 * * * *` | Yes — queues `video_build` for reel slots. **Gated off.** |
| `publish-sweep` | `*/10 * * * *` | Only after approval. Inert: no client enabled. |
| `reap-stale-publish-claims` | `20 * * * *` | No |
| `resume-paused-jobs` | `10 * * * *` | Yes — a cut held by a spend cap resumes here |
| `token-health-daily` | `45 2 * * *` | No |

`video_edit` is on **no** schedule and in **no** pipeline. It runs only when
somebody presses "Cut the reel", which exists as of 8 October. Phase 1.1 is
what puts it on the engine's path; until then every cut is a manual act.

---

## What this costs, with real numbers

| | Per reel | Source |
|---|---|---|
| Planning + revise | **~$0.19** | 3 real cuts, $0.5707 total |
| Higgsfield clips | not in this repo | external billing |
| Render compute | CPU seconds on Railway | ~5s wall for a 10.6s cut locally |
| Whisper, if Phase 4.1 | cents | estimate |
| Editor cost per reel | **still not recorded** | the comparison is incomplete without it |

That last row was flagged on 1 October and is still blank. Until it is filled
in, "cheaper than an editor" is an assumption, not a finding.

---

## Order, and who it needs

1. **Phase 1** — mine, start to finish. One enum migration, one pipeline row,
   a QA check and a one-row backfill. Nothing needs production credentials
   beyond the push.
2. **Phase 2.1** — needs your sign-off on ~$2 and five briefed reels.
3. **Phase 2.2–2.3, Phase 3** — mine.
4. **Phase 4** — decide after 2.1 produces an approval rate.

Phase 1 is the only one that is blocking. The rest are improvements to
something that will, after it, actually run.
