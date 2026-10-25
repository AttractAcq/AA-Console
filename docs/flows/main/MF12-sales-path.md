# MF12 — Sales path

**Flow.** MF12 · main · Convert
**Purpose.** Take an identified lead through conversation, qualification and a booked call to
a closed sale and collected cash, without losing where they came from.
**Scope.** Sales OS end to end, plus the sales agent on the client's page.
**Owner.** Whoever owns the client commercially. The closing is a person's job.
**Last reviewed.** 25 October 2026.
**Entry.** A lead exists (MF11), or arrived from an ad, a DM or a magnet.
**Exit.** `stage = cash`, attributable to a content piece.

**Composes:** SF66–SF71, SF77.

---

## The one rule

**The console records the sale; it does not make it.** A human closes. Everything here is
about making sure the person closing knows who they are talking to and where they came from,
and that what happened is written down in a way MF13 can read.

---

## The pipeline

`lead_stage` in order, with the two pre-lead states that P1 produces:

| Stage | Meaning |
|---|---|
| `profile_visit` | Came from an ad to the profile. Not yet a lead |
| `follower` | Followed. S2 — a channel owned for free |
| `lead` | Identified. S3 |
| `conversation` | Talking |
| `qualified_conversation` | Talking, and a fit |
| `appointment` | A call is booked |
| `qualified_appointment` | Booked, and a fit |
| `shown` | Turned up |
| `sale` | Bought |
| `cash` | Paid |
| `lost` | Did not buy |
| `qualified` | Qualified outside the conversation path |

**`sale` and `cash` are different stages on purpose.** A signed deal that never pays is not
revenue, and the economics in MF13 read `cash`.

---

## Stage 1 — Where the lead comes from

**Clients → [client] → Delivery → Sales OS (v2)** has three tabs:
**Capture**, **Pipeline**, **Agents**. v2 leads with Capture because where a lead came from
is the question v1 could never answer.

**Capture** shows, per lead: **Came from**, **Attributed to**, **Consent**, and
**Came in without creating a lead** for submissions that arrived but did not become a lead.
*"Nobody has arrived from outside yet"* means no external capture has happened.

If leads are arriving with no campaign, the capture endpoint was never attributed to one —
fix it in MF11 stage 2 (SF61). Attribution cannot be reconstructed later.

---

## Stage 2 — The sales agent, where the destination is a page

**Sales OS (v2) → Agents**

### Build it

1. **Brief the sales agent** — **Agent name**, **What this agent is for**,
   **What surface is this agent for**, with **Anything to steer it (optional)**.
2. Choose the role: **Appointment setter**, **Inbound qualifier**, **Closer assist**,
   **Nurture** or **Reactivation**. For the flagship journey it is an **Appointment setter**.
3. **Build Sales Agent** → *"Queued. The builder is writing the agent now."*

The builder writes the agent's greeting, system prompt, qualification, objections,
`booking_rule`, escalation rule and guardrails. Read all of it (SF66). The qualification and
the guardrails are what stop the agent promising something the client cannot deliver.

### Approve and deploy it

4. **Approve for public use** → *"Approved for public use."* Until then it reads
   *"Not approved for public use"*. **Revoke approval** takes it down.
5. Deploy it to a page (SF67): **Page it lives on**, the allowed origin, and the daily
   message and cost limits. *"Not attached to a page yet"* means it is built but live nowhere.
6. *"Live, but has not spoken to anyone yet"* is the healthy state before traffic arrives.

The agent refuses to cite uncleared proof. That is deliberate and it is not a bug to work
around.

---

## Stage 3 — Where the destination is a DM

**There is no DM path. G01.**

No webhook ingestion, no Instagram or Messenger adapter, no DM conversation record. If a
campaign's destination is `message` (template P3), then:

1. A person monitors the client's inbox.
2. They add the lead by hand: **Sales OS (v2) → Pipeline → Add Lead**, with the
   **Initial stage** set to `conversation`.
3. They record the campaign it came from themselves, because nothing carries it.

Attribution for DM leads is therefore only as good as the person's note. Say so when
reporting.

---

## Stage 4 — Work the pipeline

**Sales OS (v2) → Pipeline** — **Lead pipeline**

- **Add Lead** for leads that arrived outside the system, with an **Initial stage**.
- Move a lead by dragging or using the stage control (SF68). Each move is recorded as a
  `stage_change` event, so the pipeline has a history rather than just a current state.
- **Add note** against a lead — calls made, voicemails, what was said. Event kinds are
  `note`, `conversation`, `stage_change`, `appointment` and `outcome`.
- **Archive this lead** → **Confirm archive** for dead leads. Archived leads leave the
  pipeline without being deleted (SF68).

**Probe leads.** MF11's form probe creates real lead rows marked `is_probe`. Exclude them
(SF71) — they are real in every other respect, which is the point, but they are not prospects.

**Duplicates.** A lead is deduplicated on exact email, or the **last nine digits** of the
phone number (SF70). Two enquiries from the same person through different campaigns collapse
to one lead, and the first source wins — worth knowing before you argue about attribution.

---

## Stage 5 — The booking

**The booking is manual. G04.**

`booking_rule` is prompt text telling the agent when to offer a booking. No calendar is
connected and nothing creates an appointment row. So:

1. The agent offers and the prospect agrees.
2. A person puts it in the actual diary.
3. A person sets the stage to `appointment`, then `qualified_appointment` if it is a fit
   (SF69).

If you are demonstrating this flow, say that the booking is a person. The agent's transcript
will read as though it booked something.

---

## Stage 6 — Show, close, collect

1. `shown` when they turn up. Tracking no-shows is half of why `appointment` and `shown` are
   different stages.
2. `sale` when they buy, with the amount.
3. `cash` when the money arrives (SF69). **Cash collected** is what the economics read.
4. `lost` with a reason when they do not. The reason is what R2 objection campaigns are built
   from — an objection you have written down is a campaign you can run.

---

## Stage 7 — Close the loop

**Clients → [client] → Delivery → Attribution OS → Attribution** shows the chain:
**From the idea** → **Hook** → **Asset** → **Leads** → **Conversations** →
**Appointments** → **Sales** → **Cash**.

That chain only exists because the lead carried its source from capture. Trace one customer
back to the content that caused them (SF77), then take it into MF13.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Agent not answering | Not approved for public use, or not attached to a page (SF67) |
| Agent stopped mid-day | Daily message or cost limit reached (SF67) |
| Agent refuses to mention a result | The proof behind it is uncleared (SF25). Correct behaviour |
| Leads with no campaign | Endpoint not attributed (SF61). Not fixable retrospectively |
| Duplicate leads | Check email and last-nine-digits matching (SF70) |
| Pipeline counts look wrong | Probe leads are included somewhere (SF71) |
| Cash ROAS looks impossible | `sale` recorded without `cash`, or spend not bound (MF13) |

---

## Where this stops today

- **G01 — no DM path.** Half of the described convert stage is a person and a phone.
- **G04 — no booking integration.** The agent cannot book.
- **G02 — no governed outbound send.** You cannot follow up a lead from the console.
- **G11 — no per-lead nurture.** A lead who went quiet is only reachable by a new campaign.
