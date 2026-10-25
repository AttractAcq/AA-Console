# MF05 — Campaign build, paid mode (Google)

**Flow.** MF05 · main · Attract
**Purpose.** Take an approved opportunity to a complete, reviewable Google Ads build sheet,
and get the campaign built by hand in Google Ads.
**Scope.** Campaign Factory through the spine to Google Ads Studio.
**Owner.** Marketing Director.
**Last reviewed.** 25 October 2026.
**Entry.** An approved opportunity (MF02).
**Exit.** A build sheet a person has used to build the campaign in Google Ads.

**Composes:** SF18, SF19–SF22, SF55.

---

## The one rule

**There is no Google Ads adapter. This flow ends in a document, not in an ad account.**
Migration 243 produces a build sheet that specifies every object; a person then builds it by
hand in Google Ads. Anyone who tells a client the console builds their Google campaigns is
wrong. This is gap **G03**.

---

## Stage 1 — Create the campaign, in paid mode

**Market Opportunities → Activate** → mode **paid** → *choose Meta Ads or Google Ads* →
**Google Ads**. **Create and plan.**

## Stage 2 — Work the manifest spine

As MF03 stage 3, with `distribution` resolving to **Google Ads Studio**. Search intent is
unlike social: the offer and the landing page carry more of the weight, so do not skimp on
`offer` or `website`. If the sheet points at a page, **MF11 must be complete**.

## Stage 3 — Derive the sheet

**Clients → [client] → Delivery → Google Ads Studio**

| Tab | Job |
|---|---|
| **Build sheet** | **Derive the sheet** / **Derive again** — generates it from the campaign |
| **Account** | Which Google account this is for |
| **Automated build** | *The build a person does by hand* — deliberately not a button |

The sheet covers **Campaign**, **Budget**, **Geography**, **Conversion action**,
**Destination** and **Search intent groups**.

**Read what is missing.** The panel says either *Everything it needs is here* or lists the
gaps. **`keyword_research` is always listed as missing** — the system never claims to have
done keyword research, because it has not. That is the honest part of this flow: do the
keyword work yourself, in Google's own tools, and treat the sheet's intent groups as a
starting structure rather than a finished keyword plan.

The sheet is immutable and deduplicated by hash: deriving again with no changes produces the
same sheet rather than a second one.

## Stage 4 — Build it in Google Ads

A person creates the campaign, ad groups, keywords and ads in Google Ads from the sheet.
Record the external campaign ID against the campaign so Attribution OS can join spend to the
operational campaign (MF13).

## Stage 5 — Attribution

Because nothing was created by the system, nothing is automatically linked. Bind the external
IDs yourself, then read coverage in Attribution OS → Paid. Expect `estimated` and `unknown`
to be larger here than on Meta, and report them as such (SF72).

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| Sheet will not derive | `google_ads_sheet_due`, surfaced on the Build sheet tab |
| Sheet says things are missing | It is right. Fill them on the campaign, then **Derive again** |
| Expecting an automated build | There is not one. G03 |

---

## Where this stops today

**G03 — no Google Ads adapter**, and `google_ad_build` is registered unsupported with the
note that the build sheet specifies every object for a person to build. Until an adapter
exists, every Google campaign is hand-built and this flow's value is the specification and
the attribution binding, not automation.
