# MF04 — Campaign build, paid mode (Meta)

**Flow.** MF04 · main · Attract
**Purpose.** Take an approved opportunity to a complete, **paused** campaign structure in the
client's Meta ad account, ready for a person to launch.
**Scope.** Campaign Factory through the manifest spine to Meta Ads Studio. Paid Meta only.
**Owner.** Marketing Director.
**Last reviewed.** 25 October 2026.
**Entry.** An approved opportunity (MF02), Meta connected with a pixel (SF02).
**Exit.** Paused Meta objects matching an approved package.

**Composes:** SF02, SF54 (the detailed Meta SOP), SF19–SF22, SF33–SF42, SF55.
**The long-form Meta memo is [`../../sop-meta-campaign-to-paused-ads.md`](../../sop-meta-campaign-to-paused-ads.md)** —
eleven stages, field by field. This memo is the v6 wrapper around it: what changed now that
campaigns route through an opportunity, a manifest and an approval gate.

---

## The one rule

**Nothing in AA Console can make an ad live.** Campaigns, ad sets and ads are created
**paused**, and there is no code path that sets them active. Spend begins only when a person
switches them on in Ads Manager, deliberately. If you believe you have launched ads from the
console, you have not.

---

## Before you start

- Meta integration `connected`, with ad account as `act_…`, a **System User** token, a
  Facebook page ID, and a **pixel ID** (SF02).
- **No pixel means fewer templates.** Only **P5** and **O2** can build. R1, R2, R3, C1, C2,
  C3 and O1 are refused until a pixel is on the integration.
- An offer version signed off (SF20).

---

## Stage 1 — Create the campaign, in paid mode

From **Market Opportunities → Activate**: mode **paid**, then *choose Meta Ads or Google Ads* →
**Meta Ads**. **Create and plan.**

## Stage 2 — Choose the template

**Campaign Factory → Campaigns → [the campaign] → Edit campaign → Campaign template**

The template is labelled optional and is **not optional for ads**. It sets the entry and exit
audience state, the optimisation event and the destination. Pick from the matrix in
[`../../core-delivery-flows-map.md`](../../core-delivery-flows-map.md):

- Building a pool from strangers → **P1** (to profile), **P4** (reach), **P2**/**P3** (direct), **P5** (magnet)
- Spending against a warm pool → **R1**, **R2**, **R3**
- Customers → **C1**, **C2**, **C3**
- Offer with a deadline → **O1**; a date → **O2**
- Scaling what works → **X1**; buying information → **X2**

Check the prerequisite. **R1 requires P1 or P4 to have been running 14 days or more.** R3
requires a pixel that recorded the step. C1/C2 require a customer or lapsed list.

## Stage 3 — Work the manifest spine

As MF03 stage 3, with one difference: `distribution` resolves to **Meta Ads Studio** instead
of Organic Content Distribution. Everything above it in the spine is identical — the offer,
the proof and the creative are the same work.

If the template's destination is a page (R1, R2, R3, C1, C2, C3, O1, P5, O2, X1, X2), then
`website` is required and **MF11 must be complete, probe included**, before you build.

## Stage 4 — Creative, copy, budget

Follow the long-form SOP stages 4 through 8: produce the creative, approve the assets, write
the ad copy, set budget, countries and conversion event, then check the three indicators.

Creative here answers **one awareness stage** from the opportunity's awareness journey
(MF02 stage 3). One objection or one stage per ad, sequenced — not everything in one.

## Stage 5 — Ask, approve, build

**Clients → [client] → Delivery → Meta Ads Studio (v2) → Build**

This tab is the v6 change. v1 refused every Meta build outright; now the refusal is a gate
with a key.

1. **What is stopping it** — read it. It names the one thing blocking the build in a sentence.
2. **Ask for approval** — records a request bound to this exact package version, account,
   audience, budget and creative.
3. A person approves it (Approval Inbox → Campaign actions, SF78). Approval cannot be reused
   for changed copy, creative, page, audience or budget — change any of them and
   **Ask again**.
4. It builds on the next sweep, re-checking the account, audience, budget and creative
   immediately before the write. `campaign_actions_enabled` must be on (SF06).
5. **Campaign Builds** shows what was created, with the external IDs.

## Stage 6 — Launch, in Meta, by a person

Open the paused structure in Ads Manager, read it against the approved package, and switch it
on yourself. SOP stages 10 and 11.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Build refused | `meta_build_due`, surfaced as **What is stopping it** |
| Most templates unselectable | No pixel (SF02) |
| R1 refused | P1/P4 has not run 14 days |
| Approved but nothing built | `campaign_actions_enabled` off, or the sweep has not run |
| Built but copy is wrong | The approval was version-bound; fix the copy and **Ask again** |
| Token rejected | See *If there is no usable token* in the long-form SOP |

---

## Where this stops today

- **G07 — no `budget_change` executor.** Changing spend after launch is manual in Ads
  Manager, ungoverned and unattributed.
- **G08 — `campaign_launch` is not a real gate.** Nothing answers "is this campaign actually
  live" in one place; you confirm in Ads Manager.
