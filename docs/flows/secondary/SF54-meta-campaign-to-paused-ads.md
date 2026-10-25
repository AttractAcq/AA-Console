# SF54 — Build a Meta campaign to paused objects

**Where.** Clients → [client] → Delivery → Meta Ads Studio (v2) → Build
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF04.

## This memo is a pointer
The full field-by-field memo is
**[`../../sop-meta-campaign-to-paused-ads.md`](../../sop-meta-campaign-to-paused-ads.md)** —
eleven stages, from the per-client integration setup to launching in Ads Manager. Follow that
one for the detail. This page is the v6 summary and the differences.

## The one rule
**Nothing in AA Console can make an ad live.** Objects are created **paused** and there is no
code path that sets them active. Spend begins only when a person switches them on in Ads
Manager.

## What v6 changed
1. **The build is requested and approved, not just run.** On **Meta Ads Studio (v2) → Build**:
   **Ask for approval** → a person approves in **Approval Inbox → Campaign actions** → it
   builds on the next sweep.
2. **The approval is version-bound.** It covers this exact package version, account, audience,
   budget and creative. Change any of them and **Ask again**.
3. **The write re-checks immediately before building** — account, audience, budget and
   creative are verified again at the moment of the write, not trusted from the decision.
4. **`campaign_actions_enabled` must be on** (SF06), or nothing builds however approved it is.
5. **What is stopping it** shows `meta_build_due` in one sentence.

## The pre-conditions people forget
- **No pixel means only P5 and O2 can build.** R1, R2, R3, C1, C2, C3 and O1 are refused (SF02).
- **R1 needs P1 or P4 running 14 days or more.**
- If the template's destination is a page, **MF11 must be complete including the probe.**

## After it builds
**Campaign Builds** shows what was created with external IDs. Open the paused structure in
Ads Manager, read it against the approved package, and launch it yourself.
