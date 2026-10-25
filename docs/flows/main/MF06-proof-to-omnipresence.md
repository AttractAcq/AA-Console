# MF06 — Proof to omnipresence

**Flow.** MF06 · main · Nurture
**Purpose.** Capture genuine proof, clear its rights, turn it into the forms each surface
needs, and place it where a prospect will look before they buy.
**Scope.** Proof Production Factory, Proof Distribution, Google Profile, Meta Profile.
**Owner.** Client manager for capture and rights; Marketing Director approves placement.
**Last reviewed.** 25 October 2026.
**Entry.** E4 — proof arrives — or a campaign's `proof` manifest item.
**Exit.** Verified placements on the surfaces a buyer checks.

**Composes:** SF03, SF23–SF32, SF56.

---

## The one rule

**Proof rights default to `not_cleared`, and nothing derived from uncleared or expired proof
can go out.** This is not bureaucracy: a testimonial used without permission, or a result
quoted after the client lost the right to quote it, is the one mistake in this system that
creates legal exposure rather than wasted spend. Rights and expiry follow every derivative —
a reel made from a review inherits that review's permission.

---

## Why this flow has no conversion event

Omnipresence is exit track **X-f**. It produces no lead and no sale, and it is still
essential: a prospect who has decided to trust the client will search them before buying, and
what they find decides it. Measure this flow by **existence and freshness**, never by leads.

---

## Stage 1 — Get real proof

**Clients → [client] → Delivery → Proof Production Factory → Proof Bank**

Three ways in, in order of value:

1. **Ask the customer.** **Prepare evidence request** → **Capture link**, sent to a real
   customer who submits their own words and files (SF24). Strongest proof, slowest to get.
   Start this on day one of an engagement — it is the long-lead item.
2. **Capture by hand** (SF23) — a result the client already has. Record `proof_type`
   (`customer_result`, `testimonial`, `review`, `case_study`, `before_after`, `stat`,
   `credential`, `award`, `press`, `process`, `team_expertise`), the **source**, and the
   evidence. `media_type` is required.
3. **Find proof online** — queues the proof finder to search for what already exists publicly
   about the client. It proposes; it does not clear.

**From Google reviews:** **Delivery → Google Profile → Reviews → Capture as proof** pulls a
real review into the Proof Bank. It arrives *"Captured into the Proof Bank, uncleared"* —
capture and clearance are separate acts on purpose (SF26).

---

## Stage 2 — Clear the rights

**Proof Production Factory → Proof Bank → [asset]** (SF25)

| `usage_rights` | Meaning |
|---|---|
| `not_cleared` | Default. Refuses everything downstream |
| `restricted` | Usable only where the permission says |
| `approved` | Cleared to use |

Set **expiry** where the permission has an end date. An expired asset behaves like an
uncleared one, and `offer_claim_evidence` and `motion_candidate_due` will both start
reporting any claim or cut that still leans on it.

---

## Stage 3 — Produce the artifacts each surface needs

**Proof Production Factory → Proof Artifacts** (or **(v2) → Produce**)

Raw proof is not placeable. An artifact is proof rendered for a surface:

| `artifact_kind` | For |
|---|---|
| `geo_answer` | The answer-shaped content a generative search engine will quote |
| `seo_case_study` | A case study page that ranks |
| `local_proof_snippet` | Short local proof for a profile or directory |

**Request** the artifact (SF27), read it, then **sign off the version** (SF28). The signoff is
a person's act; the build is the agent's.

---

## Stage 4 — Place it

**Clients → [client] → Delivery → Proof Distribution**

| Tab | Job |
|---|---|
| **Destinations** | Where this client's proof can go, and which have adapters |
| **Placements** | Each placement and its state |
| **Rights** | What is cleared, restricted, expiring or expired |

A placement moves `drafted` → `awaiting_approval` → `approved` → `queued` → `placing` →
`placed` → `verified`, or into `awaiting_manual_placement`, `failed`, `rejected` or
`retraction_required`.

**What can actually be placed today:**

| Destination | Supported | How |
|---|---|---|
| `google_business_profile` | **yes** | Posts, photos and review replies through the API |
| `proposal_quotation` | **yes** | A proof pack rendered into the document a salesperson sends |
| `third_party_directory` | **yes, manually** | The payload is rendered here, a person places it, and records the evidence (SF31) |
| `main_website`, `campaign_landing_page`, `seo_geo_content` | no — **G09** | Route through the page pipeline |
| `email_sms_nurture` | no — **G02** | No governed send path |
| `organic_social`, `paid_advertising`, `sales_conversation` | no — **G10** | They execute elsewhere but are not recorded as placements |

1. Request a placement (SF29) → it is bound to the artifact version.
2. Approve it (SF30) — **Approval Inbox → Campaign actions**.
3. It places on the sweep, if `proof_publishing_enabled` is on.
4. For a manual destination, the payload is rendered, a person places it, and records the
   external record and evidence (SF31).

---

## Stage 5 — The profile surfaces

### Google Business Profile

**Clients → [client] → Delivery → Google Profile**

- **Location** — **Connect a Business Profile location** → **Connect a location** (SF03).
  *"Connected. Nothing is read until a credential exists."*
- **Reviews** — **Draft a reply** → *"Drafted. It waits for a person."* →
  **Approve this reply** → *"Approved. It posts when the adapter runs."* The draft is the
  agent's; the reply is a person's.
- **Posts** — publish proof posts (SF56).
- **Metrics** — what the profile actually did.

Watch for **Gone but cited** in `google_profile_due`: a review that has been deleted but is
still cited somewhere. That is the expensive case, because the citation is now unevidenced.

### Meta Profile

**Clients → [client] → Delivery → Meta Profile (v2)**

- **Identities** — which account is connected. *"No Meta identity is connected"* blocks the rest.
- **Profile** — **Proposed changes** with **Field** / **Says now**, then **Approve** or
  **Reject**. **Nothing writes these yet — G05.** The decision is recorded; a person makes
  the change in Meta.
- **Presence** — whether the profile looks like a real business.
- **Outcomes** — what it produced.

---

## Stage 6 — Keep it true

Proof decays. Two standing jobs:

1. **Rights expiry** — the sweep flags placements whose proof expired as
   `retraction_required`. Retract and verify (SF32). This covers proof that was `drafted` or
   `awaiting_approval` as well as live placements.
2. **Freshness** — a profile last posted to eight months ago reads worse than one with no
   posts. Keep a cadence.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Nothing will place | `proof_placement_due`. Usually rights, or `proof_publishing_enabled` off |
| An artifact will not sign off | A quantified claim with no proof attached (SF20, SF21) |
| A destination is greyed out | It has no adapter. The row says why |
| A review reply never posts | Approved replies wait for the adapter run |
| *Gone but cited* | A review was deleted. Find the citation and retract it (SF32) |
| Proof placed but no lineage | `organic_social` / `paid_advertising` are not recorded as placements — G10 |

---

## Where this stops today

- **G09** — proof cannot be placed on the client's own website or a campaign landing page,
  arguably the most important surface. These route through the page pipeline, which MF11 has
  now built, so this is likely cheap to unblock.
- **G05** — profile *management* is record-only on both Google and Meta. Posts work;
  changing the profile itself is a person in the platform.
- **G10** — proof-derived ads and posts exist but no placement row says so, so proof lineage
  is incomplete.
