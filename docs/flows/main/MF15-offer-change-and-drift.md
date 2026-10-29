# MF15 — Offer change and drift sweep

**Flow.** MF15 · main · Lifecycle
**Purpose.** Change or reprice an offer and find every live asset still quoting the old
figure, before a customer does.
**Scope.** Offer Studio, then every surface that carries an offer version.
**Owner.** Client manager.
**Last reviewed.** 25 October 2026.
**Entry.** E3 — the client changes a price, a guarantee, an inclusion or a claim.
**Exit.** No live surface carries a superseded version.

**Composes:** SF19–SF22, SF58, SF59, SF63.

---

## The one rule

**A reprice is not finished when the new version is signed off. It is finished when nothing
live still quotes the old one.** Every new asset will be correct automatically; the danger is
the PDF that keeps being emailed, the published page nobody rebuilt, and the magnet still
being delivered. This is the one failure in the system that damages the client's credibility
rather than just wasting money, and it gets worse with time rather than better.

---

## Stage 1 — Create the new version

**Clients → [client] → Delivery → Offer Studio → Service Offers**

1. Create a new **version** of the existing offer (SF19). Versions are immutable — you never
   edit a signed-off version, you supersede it.
2. Record the claims. A **quantified** claim must carry a `proof_asset_id`; sign-off refuses
   one that does not (SF20). This is why repricing often surfaces a proof problem.

---

## Stage 2 — Sign it off

Sign off the version (SF20). The newest **signed-off** version is what "current" means —
a draft v4 nobody approved does not make a live v3 wrong, and `offer_current_version`
compares against the highest version that has a sign-off.

---

## Stage 3 — Read the drift

**Clients → [client] → Delivery → Offer Studio (v2) → Live use**

This tab exists for exactly this moment. It is the join nobody could make before.

| Column | Meaning |
|---|---|
| **Offer** / **Version** / **Current** | What this surface carries, and what current is |
| **Carrying it** | The surface: campaign, package, lead magnet or campaign page |
| **Live** | Whether that surface is actually live |
| **Problem** | The sentence saying what is out of date |

The good state is *"Nothing live is carrying a superseded offer."*

The expensive state is a row that is **superseded and live**:
*"Carrying v2 while v3 is current, and it is live."*

Surfaces, and what "live" means for each:

| Surface | Live when |
|---|---|
| **Campaign page** | An approved publication has committed it |
| **Lead magnet** | A version of the magnet has a standing approval |
| **Package** | Never — a frozen input, not a live surface |
| **Campaign** | Not claimed. A v6 campaign's live state is gated elsewhere, and this view does not pretend to know it |

That last row is deliberate: unknown stays unknown rather than being guessed.

---

## Stage 4 — Fix each live superseded surface

Work the list. Nothing updates itself.

### A campaign page

1. Rebuild the page against the new offer version (MF11 stage 1).
2. Request page-deploy approval (SF58) — the old approval is void; it was bound to the old
   bytes.
3. Publish and **re-run the probe** (SF59, SF60). The row must return to **Live and tested.**

### A lead magnet

1. **Lead Magnet Studio → Build → Add a version** with the corrected file.
2. **Approve this file and route** (SF63). The old approval does not carry over, and the
   courier re-hashes the bytes before sending, so the old file cannot go out by accident.

### A proposal or quotation

This is the one most often missed. A proof pack or proposal document already sent is gone,
but the **template version** that carries the offer is a proof placement
(`proposal_quotation`), so retract and re-place it (SF32, SF29).

### A campaign's own bound version

Bind the campaign to the new offer version. If the campaign has already built ad copy from
the old figure, that copy is wrong: the Meta approval was version-bound, so fix the copy and
**Ask again** (MF04 stage 5).

---

## Stage 5 — Check the claims still stand

**Offer Studio (v2) → Live use → Claims, and what stands behind them**

Columns: **Claim**, **Kind**, **Proof**, **Problem**. The good state per claim is **Fine**.

Problems it will name (SF21):

- *A quantified claim with no proof recorded.*
- *The proof behind this claim no longer exists.*
- *The proof behind this claim is not cleared.*
- *Permission for the proof behind this claim expired on …*

**Rights expire after a sign-off and the claim does not know.** So this check is not only for
repricing — run it periodically regardless (SF21, MF06 stage 6).

---

## Stage 6 — Confirm

- [ ] **Live use** reads *Nothing live is carrying a superseded offer*
- [ ] Every claim reads **Fine**
- [ ] Any republished page is back to **Live and tested.**
- [ ] Any new magnet version is approved, and delivery is still on if it should be

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Sign-off refused | A quantified claim has no proof (SF20) |
| A surface shows no version | It was never bound to an offer version |
| Page republish refused | The approval is stale; request it again (SF58) |
| Magnet still delivering the old file | The old version still has a standing approval. Revoke it (SF63) |
| Drift row says live but you think it is not | For pages, live means a commit exists. Check the Publish board |
