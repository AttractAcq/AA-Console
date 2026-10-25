# MF07 — Produce a video with AI

**Flow.** MF07 · main · Nurture
**Purpose.** Take an idea to an approved, QA'd video asset in the library, with its lineage
back to the brief, the idea and any proof intact.
**Scope.** Content Production Factory, plus Motion Design where a motion piece is wanted.
AI route — the human route is MF08.
**Owner.** Creative lead.
**Last reviewed.** 25 October 2026.
**Entry.** E5, or the `creative` item of a campaign manifest.
**Exit.** An approved asset in the Video Library.

**Composes:** SF33–SF42, SF46, SF47.

---

## The one rule

**QA is not approval.** The QA agent scores the asset against the brief and the brand; a
person then approves it. The two are separate records and separate acts, and an asset that
passed QA has not been approved by anybody. The same applies in Motion Design: brand QA and
claim QA are AI verdicts, and `accepted_by` is a person.

---

## Stage 1 — The idea

**Clients → [client] → Delivery → Content Production Factory → Ideation**

Four kinds, and the choice matters:

| Button | What it is |
|---|---|
| **Auto Idea** | The ideation agent proposes from intelligence and pillars |
| **Pillar Idea** | Generated against a specific content pillar |
| **Proof Idea** | Rooted in a specific proof asset — **the one that converts** |
| **Manual Idea** | **Add idea** — yours, typed in |

Set **Assign to campaign (optional)** so the asset lands in the right campaign's manifest.
For a batch, **Choose between 1 and 60 ideas.**

Then **Approve** an idea, or **Approve & brief** to approve and queue the brief in one step.
**Archive** the ones you do not want — rejecting is part of the job, and an archived idea
stops the engine re-proposing it.

Idea states: `draft` → `approved` → `briefed`, or `rejected`.

---

## Stage 2 — The brief

**Content Production Factory → Briefs**

A brief carries **Type**, **Format**, **Destination**, the brief body, and **Brief created
at**. **View brief** to read it.

For a reel, the brief carries a **frame plan** — the beats of the video. You can regenerate
one frame without redoing the others (SF35), which is the whole point of the plan being
structured rather than prose.

Brief states: `draft` → `approved` → `in_production` → `complete`, or `rejected`.

**Approve & build** approves the brief and queues the build.

---

## Stage 3 — Build

**Content Production Factory → Create**

This is the same board at the build stage. What happens depends on the format:

| Format | Route |
|---|---|
| `single` | One image, built from the brief |
| `carousel` | Multiple frames, published whole (SF38) |
| `story` | Vertical, for the story surface (SF39) |
| `reel` | **Stills first, then motion** (SF37) |

**A reel goes stills before motion.** The opening stills are built and reviewed first,
because a motion render over a wrong still wastes the expensive step. **Track reel** follows
a reel build through its stages.

Creative stages: `concept` → `render` → `motion` → `done`, or `failed`. Render status is
`queued` → `rendering` → `done` / `failed`.

---

## Stage 4 — Motion Design, where it is wanted

**Clients → [client] → Delivery → Motion Design (v2)**

Motion Design is also its own creation mode — a prompt, a preset, an aspect and a duration —
and in v2 it becomes editable:

| Tab | Job |
|---|---|
| **Scenes** | **Seed its scenes** → *"Seeded from the plan this project already had."* Then edit or **lock** one scene and regenerate the others (SF46) |
| **Renders** | **Candidates** with **Attempt**, **Brand QA**, **Claim QA**, **Benchmark** — then **Accept this cut** or **Reject** |
| **Brief** | What the project was asked for |

Candidates are kept, not overwritten, because the interesting question after the fourth
attempt is which way the quality moved. **One accepted cut per project**; a second would be
two things claiming to be the finished video.

A scene can cite a proof asset. If that proof's rights are lost, `motion_candidate_due` says
*"A scene cites proof that is no longer usable. The cut is wrong whatever the QA says."*
That outranks both QA verdicts (SF47).

---

## Stage 5 — Copy

**Content Production Factory → Copy** (SF40)

The copywriter writes post copy against the asset and the brief. Copy is a separate record
from the asset, so the same asset can carry different copy per surface.

---

## Stage 6 — QA, then approval

1. QA runs automatically and scores the asset (SF41). `min_qa_score` on the engine settings
   is the floor below which the engine will not offer something for approval.
2. For video there is an extra acceptance screen: **Media → Video quality reviews**
   (**Video quality reviews**), which screens a finished video for continuity, visual
   defects, caption readability, crop, narrative, brand fit and brief execution. A visible
   action the brief required must actually be performed, not merely implied by a caption.
3. **Approve the asset: Clients → [client] → Delivery → Approval Inbox → Assets** (SF42).

**Assets and Engine are two different queues doing two different things.** Assets signs an
asset off. Engine is the one human commit the engine stops at, which also puts the post on
the calendar. Approving engine work on the Assets tab approves the asset and leaves the slot
where it was.

---

## Stage 7 — It lands in the library

**Content Production Factory → Videos** (**Finished reels**), **Images**, **Stories**,
**Carousels**, **Copy**, **Reel Shots**.

Lineage is intact: asset → brief → idea → campaign, and proof where it was a proof idea.
That lineage is what MF13 uses to attribute a customer to a piece of content.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Build never starts | The job is queued or **Held — waiting on a cap or a paused agent** (SF53) |
| Build failed | The error prints on the record. Often a brief that asks for the impossible |
| Asset will not approve | Source proof `not_cleared` or expired (SF25) |
| QA score too low | Read the QA detail; rebuild the brief rather than the asset (SF41) |
| Motion render fails locally | ffmpeg on this Mac has no drawtext; renders run on the runtime |
| Accepted a cut and it is wrong | A scene may cite lost proof. Read `motion_candidate_due` |

---

## Next

MF03 stage 5 or MF09 to get it distributed. MF08 if this piece needs a person instead.
