# MF03 — Campaign build, organic mode

**Flow.** MF03 · main · Attract / Nurture
**Purpose.** Take an approved opportunity to an organic campaign whose approved posts are
going out on a rhythm.
**Scope.** Campaign Factory through the manifest spine to Organic Content Distribution.
Organic only — paid is MF04 and MF05.
**Owner.** Marketing Director, with the SMM on distribution.
**Last reviewed.** 25 October 2026.
**Entry.** An approved opportunity (MF02).
**Exit.** Scheduled, human-approved posts publishing on a cadence.

**Composes:** SF18, SF19–SF22, SF23–SF32, SF33–SF42, SF49–SF53.

---

## The one rule

**An organic campaign's mode is organic for its whole life.** It cannot later become paid.
If the idea deserves paid money, clone it into a paid campaign — the clone keeps lineage and
copies no approvals, creative, results or external IDs.

---

## Stage 1 — Create the campaign

From **Market Opportunities → Activate** (MF02 stage 5) with mode **organic**, or directly:

**Clients → [client] → Delivery → Campaign Factory → Campaigns → New Campaign**

| Field | Notes |
|---|---|
| Campaign name | How it will be referred to everywhere |
| What this campaign is for | The planner writes the plan from this plus offer strategy and ICP |
| Generate content ideas with this plan | Leave on unless ideas already exist |

**Propose a campaign** queues the planner. Organic campaigns do not need a template from the
paid matrix — the matrix is the paid campaign matrix. What they need is a clear job and a
pillar to sit under.

---

## Stage 2 — Let the planner finish, then read it

**Campaign Factory → Campaigns → [the campaign] → Campaign plan**

Read it. **Edit and regenerate plan** if the plan has misread the brief — with
**Anything to steer it (optional)** to say what to change. **Edit campaign** changes the
fields the plan was built from.

---

## Stage 3 — Work the manifest spine

**Campaign Factory → Campaigns → [the campaign] → Readiness and blockers**

Every campaign names its required deliverables and their dependency order. Work it in order;
each item names the module that owns it.

| Item | Module | Needs | What done means |
|---|---|---|---|
| `intelligence` | Intelligence OS | — | A versioned snapshot for this campaign (SF11) |
| `offer` | Offer Studio | intelligence | A **signed-off** offer version bound to the campaign (SF19, SF20) |
| `proof` | Proof Production Factory | intelligence | Cleared proof for the claims being made (MF06) |
| `creative` | Content Production Factory | offer + proof | Approved assets (MF07 / MF08) |
| `website` | Website Studio | offer + proof | Only if the campaign needs a page (MF11) |
| `lead_magnet` | Lead Magnet Studio | — | Only if the campaign needs a magnet |
| `sales_path` | Sales OS | — | Somewhere for an interested person to go (MF12) |
| `proof_distribution` | Proof Distribution | proof | Proof placed where a buyer looks (MF06) |
| `distribution` | **Organic Content Distribution** | — | The organic route (stage 5 below) |
| `attribution` | Attribution OS | — | The campaign can be reported on (MF13) |

**Readiness is honest.** It does not go green because the work looks done; each item is
validated by the module that owns it. A prose note is never evidence.

---

## Stage 4 — Produce the creative

MF07 for AI production, MF08 for the human route. Per asset:

1. **Content Production Factory → Ideation** — generate ideas for this campaign (SF33).
   Ideas come as **Auto Idea**, **Manual Idea**, **Pillar Idea** or **Proof Idea** — a proof
   idea is one rooted in a specific proof asset, and it is the one that converts.
2. **Briefs** — build a brief from an approved idea (SF34).
3. **Create** — build the asset. A reel goes stills first, then motion (SF37).
4. **Copy** — write and attach post copy (SF40).
5. QA runs automatically. Read the score (SF41). **QA passing is not approval.**
6. Approve the asset: **Approval Inbox → Assets** (SF42).

---

## Stage 5 — Distribution

**Clients → [client] → Delivery → Organic Content Distribution**

| Tab | Job |
|---|---|
| **Assets** | What is available to send, with Platform, Channel, Date and Time |
| **Organic** | The schedule itself (SF49) |
| **Engine** | The autonomous cadence (MF09, SF51) |

Two ways to run organic, and you should pick one per client deliberately:

- **By hand** — schedule each post. Right for a new client while you learn their voice.
- **The engine** — MF09. It plans slots, picks ideas, briefs, builds, QAs and stops at one
  human gate per post. Right once the pillars and the voice are settled.

Scheduling a post is not publishing it. A post publishes when `publishing_enabled` is on,
the post has its human approval, and the publish sweep runs. Read `distribution_due` and
`publish_due` (SF50) — each names in one sentence what is stopping a given post.

---

## Stage 6 — Confirm it is actually live

- [ ] `Readiness and blockers` has no outstanding required item
- [ ] At least one post has been approved by a person, not just QA'd
- [ ] `publishing_enabled` is on for this client (SF06) — **it is off by default**
- [ ] A post has actually appeared on the platform; `publish_due` says nothing is stuck
- [ ] Attribution OS shows the campaign (MF13)

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Readiness will not clear | The item names its module. Most often `offer` — the version is not signed off |
| Posts scheduled but never publish | `publish_due`. Usually `publishing_enabled` off, or no human approval |
| An asset will not approve | Rights on its source proof are `not_cleared` or expired (SF25) |
| The engine plans nothing | `enabled` is off, or no pillars exist (SF09, SF51) |
| Carousel went out as one image | Carousels publish whole; check the format on the asset (SF38) |

---

## Next

MF09 to put it on a rhythm. MF06 in parallel, because proof takes real-world time.
