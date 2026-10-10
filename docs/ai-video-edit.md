# AI video edit — proposal, 1 October 2026

> **Superseded in part.** The *Spike status* and *Suggested phasing* sections
> below are out of date: the editor is registered, migrated, has ffmpeg in the
> image, and has cut three reels, one of them approved. Real cost came in at
> ~$0.19 per cut rather than the ~$1.20 estimated here. See
> [video-roadmap-2026-10-08.md](video-roadmap-2026-10-08.md). The reasoning in
> the rest of this document still holds and is why the roadmap is shaped as it
> is.

Status: **proposal only.** No code, migration or deploy is in this change.

## The question

Can a model do the editor's job on a reel, cheaply enough to replace the
`brief_dispatch` handoff for most pieces?

## What "Fable 5 / GPT-6 Astra edits video" actually means

Neither model renders video. Both edit by **driving tools**:

- **Claude Fable 5 (Claude Code).** The published workflow transcribes clips
  with Whisper (word-level timestamps), has the model pick takes and write a
  JSON **edit decision list (EDL)**, renders the cut with **ffmpeg**, grades with
  generated `.cube` LUTs and builds motion graphics in **Remotion**. The model
  sees video as sampled frames plus the transcript, never as a video stream.
- **OpenAI GPT-6 Astra.** A computer-use model that operates desktop editors
  (CapCut PC, Final Cut Pro) through the GUI. Video is not a native modality.

The Astra route needs a desktop session per edit, which does not fit a headless
worker on Railway. The Claude route is a code pipeline, and
`agent-runtime` already ships `@anthropic-ai/sdk`. So the proposal follows the
Claude pattern: **the model decides, ffmpeg renders.** The model choice stays a
config value (`AGENT_RUNTIME_MODEL` pattern), so Opus 5.5 vs Fable 5.1 is a
measured decision, not an architectural one.

## The chain as it stands

What is already built, verified against the code rather than recalled:

| # | Step | Where | What it leaves behind |
|---|---|---|---|
| 1 | Brief | `agents/brief` + `brief/shots.ts` | `client_briefs.frame_plan`: one JSON shot per line (beat, duration, `ai_generated`, motion preset), plus `format_code` F6/F7 |
| 2 | Approve & Build | `ApproveAndBuildModal.tsx` → `build_brief_with_ai` (migration 136) | AI route on a Phase 1 reel queues `video_build` on the brief, and the opening stills as an image build on `creative_build` |
| 3 | Opening stills | `creative_build/openingStills.ts` | `client_media_assets` + one `client_media_frames` row per shot, with `storage_path` |
| 4 | Motion | `video_build/` → `higgsfield.ts` (DoP image-to-video) | `provider_job_id` on submit, then `clip_path` once `clip.ts` copies the clip into `client-media` |
| 5 | **Assembly** | `video_build/assembly.ts` | **A stub.** `{ via: "brief_dispatch", status: "not_started" }` — a human editor |
| 6 | Review | `ReelShotsPanel` / `ReelShotGrid.tsx` | Per shot: still on file, clip submitted or on file. Approval sits on the parent asset |

Step 5 is the hole, and it is where AI editing goes. Everything either side
already exists: step 4 produces exactly the inputs an editor needs, and step 6
is where the cut would be reviewed.

**The chain has never been run.** Counted on the production database on
1 October 2026:

| | Count |
|---|---|
| Reel briefs (`content_format = 'reel'`) | **0** |
| F6/F7 briefs | **0** |
| Reel shot rows (`shot_source_kind` set) | **0** |
| Shots submitted to Higgsfield (`provider_job_id`) | **0** |
| Clips on file (`clip_path`) | **0** |
| Stills on file (carousel and story frames) | 103 |

```sql
select count(*) filter (where clip_path is not null) as clips_on_file,
       count(*) filter (where provider_job_id is not null) as submitted,
       count(*) filter (where shot_source_kind is not null) as reel_shots,
       count(*) as all_frames
from client_media_frames;
```

So the gap is not only assembly. Nothing upstream of it has been exercised
either: no reel has been briefed, so no still has been generated for one and
no motion request has been sent. `decideMotion` also pauses before any request
unless all four of `HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_SECRET`,
`HIGGSFIELD_MODEL_DRAFT` and `HIGGSFIELD_MODEL_FINAL` are set, and the motion
catalog carries exactly one confirmed id (Zoom In,
`fbcbec5b-30f8-4b17-ba6e-8e8d5b265562`).

That changes the order of work. The editor is the last link of a chain whose
earlier links are untested, so proving steps 1–4 on one real reel comes before
spending anything on comparing editing models.

## Where it fits

`video_build` already turns an F6/F7 reel brief into a shot plan, stills and
Higgsfield clips stored at `client_media_frames.clip_path`. The last step,
assembly, is a stub (`video_build/assembly.ts`): "Editor assembly v1. Clips are
not composited here." The Repurposing Engine also writes a brief instead of a
file because "AA cannot cut video".

AI edit fills that gap:

```
brief + shot plan ─┐
clips (clip_path) ─┼─► edit_plan (model) ─► EDL (validated JSON) ─► render (ffmpeg) ─► review ─► client_media_assets
brand profile    ──┘                                                   ▲                    │
                                                                       └── revise (model) ◄─┘
```

1. **Inputs.** Brief (hook, shot list, CTA), clips in order, brand profile
   (palette, type, bans), target format (9:16, length cap).
2. **See the footage.** Sample frames per clip (e.g. 2 fps, `sharp`-resized),
   and transcribe any audio. Higgsfield clips have no speech, so Phase 1 is
   frames only; talking-head and repurposed long-form need transcription.
3. **Plan.** One Claude call with structured output returns an EDL: per clip
   `in`/`out`, order, transitions, caption lines with timings, text overlays,
   music cue, end card. Strict schema; nothing free-form reaches ffmpeg.
4. **Validate.** Pure code: timings inside clip bounds, total length within the
   format cap, captions inside the safe area, no brand-banned words, no claim
   absent from the brief (same rule the brief agent already enforces).
5. **Render.** Build the ffmpeg command from the EDL (trim, concat, `drawtext`
   or burned ASS subtitles, `xfade`, audio mix, scale/pad to 1080×1920).
   Upload to `client-media` like `clip.ts` does.
6. **Self-review.** Sample frames from the render and ask the model to check it
   against the brief (caption legibility, cut on action, hook in first 2s). One
   revise pass at most, then hand to the existing human approval step.
7. **Fallback.** Anything that fails validation or review twice falls back to
   today's `brief_dispatch` editor handoff, with the EDL attached as notes.

## Cost

Model cost per 30s reel, estimated from list prices (Opus 5.5: $4/$20 per
MTok; Fable 5.1: $10/$50) and roughly 60 sampled frames plus a review pass:

| | Input | Output | Opus 5.5 | Fable 5.1 |
|---|---|---|---|---|
| Plan | ~100K tok | ~8K tok | ~$0.56 | ~$1.40 |
| Review + 1 revise | ~120K tok | ~8K tok | ~$0.64 | ~$1.60 |
| **Per reel** | | | **~$1.20** | **~$3.00** |

Render compute is CPU seconds on Railway. Whisper, when needed, is cents.
**Editor cost per reel is not in this repo** — fill it in to complete the
comparison. These are estimates; the first spike should log real `usage` per
reel, as every other agent already does.

## What it will not do well (yet)

- **Taste.** Pacing and music choice are where a good editor still wins. Keep
  human approval; measure how often the AI cut is approved unchanged.
- **Complex motion graphics.** Remotion can do it, but adds a headless Chromium
  render and a company licence (Remotion requires one above 3 employees). Start
  with ffmpeg text and transitions; add Remotion only if approvals demand it.
- **Proof footage.** Phase 2 shots marked `source_asset` must not be
  regenerated or altered beyond cut and caption. The EDL schema should carry
  `shot_source_kind` and the validator should refuse effects on proof shots.

## Infrastructure changes it would need

- `ffmpeg` in the runtime image (`apk add ffmpeg` in the `runtime` stage) or a
  separate render worker if memory on the main worker is tight.
- A new agent `video_edit` (queued after motion completes), or a stage inside
  `video_build` replacing `assemblyHandoff()`. A separate agent keeps retries
  and spend isolated and is the recommendation.
- Migration: an `edit_plan jsonb` + `render_path` on the reel's asset row, and
  the new agent row. Applied by Alex via Chief of Staff, per the Phase 6 gate.

## Spike status

Built in `agent-runtime/src/agents/video_edit/`. It is not registered as an
agent, has no migration, and the worker never imports it.

| Module | What it does |
|---|---|
| `edl.ts` | EDL types, the strict tool schema, `parseEdl` (untrusted JSON → typed) and `validateEdl`. The validator checks clip bounds, flash frames, format length, the end card, caption length, read time and overlap. It flags brand-banned phrases, **figures not in the brief**, and crossfades over `source_asset` footage. |
| `render.ts` | EDL → ffmpeg argv, nothing executed. It scales and crops each clip to 1080×1920 at 30 fps and joins them with cuts or crossfades. Captions are word-wrapped, the end card uses brand colours, and music is optional and fades out. Caption text goes through files (`textfile=`, `expansion=none`), never into the filtergraph. |
| `media.ts` | Runs ffprobe/ffmpeg through `execFile` (no shell), samples frames for the planner and renders. |
| `plan.ts` | One Claude call: brief and labelled frames in, EDL out through a strict submit tool. The model is a parameter, and a revise call sends back every validation problem. |
| `handoff.ts` | The join to `video_build`. Turns brief + `client_media_frames` rows into shots, the brief text the claim check measures against, and the validation context. Readiness is a gate: a reel is edited whole or not yet, and a shot waiting on Higgsfield is reported differently from one never submitted. |
| `spike.ts` | Local CLI. `--edl` renders a hand-written plan with no API spend. `--model` plans with Claude, allows one revise, and prints tokens and cost. |

Verified so far:
- A local render of three synthetic clips with a crossfade, wrapped captions,
  a brand-coloured end card and music. It came out at the exact predicted
  length (10.6s), 1080×1920 H.264 + AAC, in about 5s of wall time.
- **The full chain, end to end** (`pipeline.test.ts`): a stored shot plan and
  `client_media_frames` rows in the shape PostgREST returns, through the brief
  agent's own plan parser, readiness, probing, validation and an ffmpeg render
  to a 1080×1920 file. Clips are generated locally because Higgsfield is not
  reachable from a test. The same test proves the gate holds while a clip is
  missing, and that a caption claiming "80%" against a brief that does not say
  it is refused.
- 44 tests. The three that call ffmpeg skip where it is not installed, so they
  may not run in CI.

Not done yet:
- **No model has been called.** The Opus 5.5 vs Fable 5.1 comparison needs an
  `ANTHROPIC_API_KEY`, real Higgsfield clips and sign-off on the spend
  (est. $1–3 per reel per model, so ~$20–40 for 5 reels on both).
- **No real Higgsfield clip exists to cut**, and no reel has been briefed. See
  the counts above.
- Self-review of the render, transcription, and caption centring per line
  (drawtext centres the block, not each line).

To run it:

```
cd agent-runtime
npx tsx src/agents/video_edit/spike.ts --brief reel.json --out reel.mp4 \
  --font /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
  --model claude-opus-5-5        # or --edl plan.json to skip the model
```

## Suggested phasing

Reordered after the counts above: the editor is the last link of a chain whose
earlier links have never carried anything.

1. **Prove the existing chain on one reel.** Brief an F6 or F7, press Approve &
   Build, and check that stills land on `client_media_frames`. This spends
   image credits only and needs no Higgsfield key. It is the cheapest way to
   find out whether steps 1–3 work, and nothing downstream matters until they
   do.
2. **Turn motion on.** Set the four `HIGGSFIELD_*` vars on Railway and run the
   same reel again. Expect the catalog to be the first problem: one id is
   confirmed, so anything but Zoom In pauses. A real clip on `clip_path` is the
   gate for everything below.
3. **Compare editing models** on 3–5 real reels, Opus 5.5 against Fable 5.1,
   scored on approval rate and cost per reel. `spike.ts --model` already does
   this; it needs the clips from step 2 and sign-off on roughly $20–40.
4. **Wire it:** `video_edit` agent, migration, ffmpeg in the Dockerfile,
   console preview of the cut next to the shot review.
5. **Extend:** Repurposing Engine produces real cuts from long-form uploads
   (transcription-driven), then Remotion graphics if approvals call for it.

Steps 1 and 2 are Alex's: they need production credentials and the Phase 6
release gate. The spike covers step 3 onwards as soon as there is footage.

## Sources

- How Fable 5 edited its own launch video — https://explainx.ai/blog/fable-5-edited-own-launch-video-thariq-claude-code-2026
- Vibe-editing videos in Claude Code — https://daily.dev/posts/forget-vibe-coding-apps-people-are-now-vibe-editing-videos-in-claude-code-now-9almkuoho
- invideo with GPT-6 Astra — https://openai.com/index/invideo-builds-with-gpt-6-astra/
- Is GPT-6 Astra a native video editor? — https://www.pilotcut.com/blog/is-gpt-6-astra-a-native-video-editor
