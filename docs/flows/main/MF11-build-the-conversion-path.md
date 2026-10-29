# MF11 — Build the conversion path

**Flow.** MF11 · main · Convert
**Purpose.** Build the place an interested person goes, and **prove** that arriving there
creates a lead in Sales OS carrying its campaign, its source and its consent.
**Scope.** Website Studio, Lead Magnet Studio, lead capture, and the probe. Not the sales
conversation — that is MF12.
**Owner.** Client manager, with the Marketing Director approving the publish.
**Last reviewed.** 25 October 2026.
**Entry.** A campaign needing a page or a magnet (MF03 / MF04 / MF05).
**Exit.** The Publish row reads **Live and tested.**

**Composes:** SF04, SF57–SF65.

---

## The one rule

**Published is not working.** A page whose form posts nowhere looks identical to one that
works — same commit, same URL, same screenshot. The only difference is a test submission
that arrived. So this flow is not finished when the page is live; it is finished when the
probe has passed. The Publish board deliberately shows
*"Published. Nobody has tested the form yet."* as its own state, in a different colour from
*"Live and tested."*

---

## Before you start

- A site repository connected, and the GitHub installation in place (SF04):
  **Clients → [client] → Account → Sites → Settings**. Without it there is nowhere to publish.
- An offer version signed off (SF20) — the page freezes a version, so an unsigned offer
  means unapproved copy on a public page.
- Cleared proof for any claim the page makes (SF25).

---

## Stage 1 — Build the page

**Clients → [client] → Delivery → Website Studio → Landing Pages** (or **Offer Pages**)

1. **Brief the page** — with **Anything to steer it (optional)** for the angle. The brief
   reads the campaign, the offer version and the ICP.
2. **Build Page** queues the landing page agent.
3. Audit and revise it (SF57). The page auditor finds the problems; the reviser fixes them.
   Iterate here, not after publishing.

Primary landing pages and secondary offer pages are different kinds (`page_type` is
`landing`, `offer` or `recruitment`). Recruitment pages belong to AA's own house client and
are deliberately kept out of client page lists (MF14).

---

## Stage 2 — Put a real capture endpoint on it

A form that posts nowhere is the failure this flow exists to prevent. The form needs an
endpoint, and the endpoint is what carries attribution and consent.

**Clients → [client] → Delivery → Sales OS (v2) → Capture**

1. **Open a capture link** → **Choose what the link is for.**
2. **On which page** — bind it to the page.
3. **Attribute to campaign** — bind it to the campaign. A lead with no campaign cannot be
   attributed later, and this is where that is decided (SF61).
4. **Consent** — the consent wording that will be stored on every lead this endpoint creates.
   Write what the person actually agreed to; it is kept verbatim on the lead.
5. The token is shown **once** and stored only as a hash. **I have it** confirms you copied
   it. If you lose it, revoke and create another.

Optional limits: an expiry and a maximum number of submissions. Use them for a campaign with
a known end date.

---

## Stage 3 — If the campaign needs a lead magnet

Skip to stage 4 if not. P5 requires *a magnet and the page that gates it*.

**Clients → [client] → Delivery → Lead Magnet Studio**

| Tab | Step |
|---|---|
| **Magnets** | **Build a magnet** / **Create** — then *"Created. Add the file as its first version."* |
| **Build** | **Add a version** — upload the actual file. Versions are immutable |
| **Build** | **Approve this file and route** — approves these exact **Bytes approved** and this delivery route |
| **Delivery** | Shows delivery state. *"Delivery switched off."* means `lead_magnet_delivery_enabled` is off |
| **Opt-ins** | Who opted in, whether they **Became a lead**, and what they were **Attributed to** |

Connect it: **Attribute to campaign**, and bind the magnet version to the capture endpoint
that gates it (SF64). The courier re-downloads and re-hashes the bytes before attaching
them, so a file swapped after approval is refused rather than sent.

---

## Stage 4 — Request approval to publish

**Clients → [client] → Delivery → Website Studio (v2) → Publish**

A v6 campaign page cannot be published by any other route — not the admin route, not MCP,
not the legacy publisher. That block is deliberate and it stays. This tab is the one key.

1. Request page-deploy approval (SF58). It snapshots the exact revision and the byte hash of
   the built HTML — what the reviewer reads is what will ship.
2. A person approves it (**Approval Inbox → Campaign actions**).
3. On the next sweep it publishes, **re-hashing the page immediately before the commit**. If
   anyone regenerated the page between the approval and the write, it refuses with
   *"This page changed after it was approved. Request approval of the new version."*

The board's columns are **Page**, **Destination**, **State**, **Commit** and
**Approved bytes**. **Every commit, in order** below it is the history.

---

## Stage 5 — The probe. Do not skip this

Still on **Publish**. The probe posts a real test submission to the live public endpoint and
requires that it comes back as a lead with **consent, a campaign and a source**.

- Pass → the row reads **Live and tested.**
- Fail → **Published, but the form probe failed:** and the reason. A failed probe does **not**
  unpublish the page; the page stays up and the row tells the truth about it.
- Never run → **Published. Nobody has tested the form yet.**

Probe leads are real rows in `client_leads` marked `is_probe`, so the pipeline can exclude
them (SF71). They have to be real rows, or the probe would be testing a path a customer never
takes.

---

## Stage 6 — Confirm

- [ ] **Live and tested.** on the Publish board
- [ ] The probe lead shows a campaign, a source and the consent wording in Sales OS
- [ ] `campaign_actions_enabled` on, or nothing publishes at all (SF06)
- [ ] For a magnet: an approved version, and `lead_magnet_delivery_enabled` on if it should
      actually deliver
- [ ] The page's offer version is the current signed-off one (SF22)

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Publish refused | `campaign_page_publish_due`, shown as **State** |
| *The page changed after it was approved* | Someone regenerated it. Request approval again |
| *The campaign package was superseded* | A newer manifest version exists. Request again |
| Published but no leads | Run the probe. If it passed, the traffic is the problem, not the form |
| Probe fails on consent | The capture endpoint has no consent wording (stage 2) |
| Leads arrive with no campaign | The endpoint was not attributed to one (SF61) |
| Magnet never arrives | `lead_magnet_delivery_enabled` off, or the version is not approved (SF63) |
| Nothing publishes at all | `campaign_actions_enabled` off |

---

## Next

MF12 — what happens to the lead this path creates.
