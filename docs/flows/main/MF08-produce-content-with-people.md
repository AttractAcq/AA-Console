# MF08 — Produce content with people

**Flow.** MF08 · main · Nurture
**Purpose.** Produce a content piece through a human — an avatar, an editor or the client
themselves — and bring it back into the system with the same lineage and the same approval
gate as an AI asset.
**Scope.** Content Production Factory and Team. The `human` build route.
**Owner.** Creative lead.
**Last reviewed.** 25 October 2026.
**Entry.** E5, or a `creative` manifest item where the piece must be filmed.
**Exit.** An approved asset in the library, indistinguishable downstream from an AI one.

**Composes:** SF34, SF41, SF42, SF43, SF44, SF45, SF48.

---

## The one rule

**The route changes who makes it, not what it has to satisfy.** A filmed piece still needs a
brief it was built from, a QA pass, a person's approval, and cleared rights on anything it
cites. `build_route` is `ai` or `human`; everything after the build is the same flow.

---

## When to choose the human route

- The proof is a real person — a customer on camera, the client explaining their process.
  AI cannot fake this and should not try.
- The piece needs the client's face, premises or work in progress.
- The niche is sceptical and authenticity is the whole message. This is most of the nurture
  layer for a service business.

Use AI (MF07) for volume, variations and motion. Use people for the pieces that carry trust.

---

## Stage 1 — Brief it the same way

**Clients → [client] → Delivery → Content Production Factory → Ideation → Briefs**

Create the idea and the brief exactly as MF07 stages 1 and 2. The brief is what the person
shoots against, and it is what QA will later judge the result by, so a vague brief produces
an unapprovable video and a wasted shoot.

Set the **Format** and **Destination** before dispatch — a story and a reel are different
shoots.

---

## Stage 2 — Dispatch to a person

**Content Production Factory → Briefs → [brief] → Team member**

The brief is dispatched to a team member. Team people live under
**Team → Avatars / Editors / SMM** (`team_category`), and are either `employee` or
`contractor` (`engagement_type`).

An assignment has its own lifecycle: `assigned` → `accepted` → `delivered` → `approved`,
with `declined`, `rework` and `cancelled` as the other outcomes. **View delivery** shows
what came back.

**Rework is normal and is a state, not a failure.** Send it back with what specifically is
wrong against the brief.

---

## Stage 3 — Take delivery

**View delivery** → the file arrives against the brief.

For video, record what the library needs (SF44): **Video title**, **Video source**,
**Video format** and **Usage rights**. Usage rights matter as much here as on proof — footage
of a customer carries that customer's permission.

---

## Stage 4 — Edit

Three routes, and they are different tools:

### AI edit of a source video

**Content Production Factory → Edit / Repurpose**

**Add video for editing** → **Video to edit**, **Editing notes**, **Related brief** →
the source video editor runs and returns an **AI edit result** (SF45). Request a revision if
it is not right; revisions are tracked rather than overwriting.

### Human edit

Dispatch to an editor as in stage 2. Editors are a `team_category` for exactly this.

### Repurpose

**Repurpose video** → **Video to repurpose** + **Repurpose direction** (SF43). This takes a
long piece and extracts clips. Clip extraction is its own job, and the derivatives keep a
link to the source, so one shoot legitimately becomes a month of content with lineage intact.

---

## Stage 5 — QA and approval, unchanged

1. QA scores it (SF41).
2. **Media → Video quality reviews** for the video acceptance screen.
3. **Approval Inbox → Assets** — a person approves (SF42).

An asset produced by a person still cannot go out on QA alone.

---

## Stage 6 — Into the library

**Content Production Factory → Videos** (**Finished reels**) and the other libraries. From
here it is identical to an AI asset: schedulable in MF03/MF09, usable as ad creative in
MF04, attributable in MF13.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| The assignment sits at `assigned` | Nobody accepted it. Chase the person, not the system |
| Delivered but unusable | `rework` with the specific brief clause it missed |
| Rights unclear on customer footage | Treat as `not_cleared` until the customer's permission is recorded (SF25) |
| Repurposed clips lost their source | They should carry it; check the derivative record (SF43) |
| Editor delivered the wrong format | The brief's **Format** was unset or wrong before dispatch |

---

## Where this stops today

**G12 — there is no creative-director or SMM seat in the system.** "Creative director" exists
only as a persona string inside the prompts that generate and screen creative. Team
categories are avatars, editors and SMM, but creative decisions are not routed to a named
person — so who decides a piece is on-brand is a convention in your team, not a record in the
console.
