# MF09 — Run the organic content engine

**Flow.** MF09 · main · Nurture
**Purpose.** Put a client's organic content on a standing rhythm, so the nurture layer runs
continuously instead of in bursts, with exactly one human gate per post.
**Scope.** Organic Content Distribution → Engine, and the Approval Inbox → Engine queue.
**Owner.** SMM, with the client manager on approvals.
**Last reviewed.** 25 October 2026.
**Entry.** MF03 is done and the client's pillars and voice are settled.
**Exit.** Content shipping on a cadence without anyone starting each piece by hand.

**Composes:** SF09, SF41, SF42, SF51, SF52, SF53, SF50.

---

## The one rule

**The engine does everything except decide.** It plans slots, selects ideas, briefs them,
builds them, edits, writes copy and QAs — then stops at one human approval per post, which is
also what puts the post on the calendar. It never publishes on its own authority, and turning
the engine on is not the same as turning publishing on. They are two switches.

---

## When to turn it on

Not on day one. Turn it on when:

- Content pillars exist and are right (SF09)
- You have produced several pieces by hand (MF03 stage 4) and know the client's voice
- At least one full post has gone out and the client was happy with it

An engine pointed at wrong pillars produces a lot of wrong content efficiently.

---

## Stage 1 — Settings

**Clients → [client] → Delivery → Organic Content Distribution → Engine**

| Setting | What it does | How to choose |
|---|---|---|
| **Plan ahead days** | How far out slots are planned | Start at a week or two. Longer horizons plan content against stale intelligence |
| **Format mix** | The ratio of single / carousel / story / reel | Match what the platform and the niche actually reward |
| **Approval mode** | How much a person must approve | Start at the strictest. Loosen only after the output has been right for weeks |
| **Minimum QA score** | The floor below which nothing is offered for approval | Raise it if weak pieces are reaching you; do not lower it to clear a backlog |
| **Window day / Window start / Window end** | When posts may go out | The client's audience, not your working hours |
| Max jobs in flight | Concurrency cap | Leave it unless the runtime is saturated |
| Auto-approve ideas / briefs | Skips the human step on *internal* artifacts only | Reasonable once pillars are proven. Never confuses with publishing |

---

## Stage 2 — Turn the engine on

Set `enabled` for the client (SF06). The engine tick then runs on its schedule.

**This does not publish anything.** `publishing_enabled` is a separate switch, and it is off
by default. Turn the engine on first and watch a few slots reach `awaiting_approval` before
you enable publishing.

---

## Stage 3 — Watch a slot move

**Organic Content Distribution → Engine** — the slot board (SF52).

A slot walks this path:

`planned` → `ideating` → `idea_selected` → `briefing` → `building` → `editing` →
`copywriting` → `qa` → `awaiting_approval` → `scheduled` → `published`

with `failed` and `rejected` as the exits. Each transition is recorded, so a slot that
stalled tells you where.

**`awaiting_approval` is the human gate.** Everything before it is internal.

---

## Stage 4 — The Engine approval queue

**Clients → [client] → Delivery → Approval Inbox → Engine**

Approving here does two things: it signs the content off **and** it puts the post on the
calendar, moving the slot to `scheduled`. This is why the Engine queue is not the Assets
queue — approving engine work on the Assets tab signs the asset off and leaves the slot
sitting in `awaiting_approval` (SF42).

Reject with a reason. The reason is what stops the engine making the same mistake next week.

---

## Stage 5 — Publishing

Once `publishing_enabled` is on, the publish sweep sends `scheduled` posts at their time.

Read `publish_due` and `distribution_due` (SF50) for anything stuck. Common and legitimate
reasons a post does not go: the platform is not connected, the token has expired
(`integration_health`, SF05), the format is not supported on that surface, or the post never
got its human gate.

---

## Stage 6 — Running it week to week

- **Read the slot board once a week**, not once a quarter. A slot in `failed` is a silent gap
  in the client's feed.
- **Hold rather than delete** when something should pause — `held` jobs resume (SF53).
- **Watch `held_jobs`** for work stuck behind a spend cap or a paused agent.
- **Revisit pillars** when the engine's output drifts. The engine is downstream of them.
- **Keep the proof flowing** (MF06). The engine will keep producing process and expertise
  content; it cannot invent new customer results.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| No slots planned | `enabled` off, no pillars, or plan horizon at zero (SF51) |
| Slots stuck at `ideating` | Ideation jobs queued or held (SF53) |
| Nothing reaches me for approval | Everything is failing QA below `min_qa_score`, or auto-approve is masking it |
| Approved but not scheduled | You approved on the Assets tab instead of Engine (SF42) |
| Scheduled but never published | `publishing_enabled` off, or `publish_due` names the reason |
| Too much of one format | **Format mix** |
| Posting at the wrong time | **Window day / start / end** |

---

## Where this stops today

**G11 — the engine schedules content, not people.** It runs the broadcast nurture layer. It
does not move a specific identified lead along, and there is no per-lead sequencing; once
someone is S3 and did not buy, only a new campaign reaches them. Combined with **G02** (no
governed outbound send), nurture is public content only.
