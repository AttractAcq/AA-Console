# Archived surfaces, v6.1

Alex on 31 October, on archiving: *"make sure we are keeping a list of
everything that is actively archived becasue this is a bad habit and a way to
make the repo messy. we will have to clean up in v6.2 once v6.1 is live and
working, but for now, archive and document."*

So this is the list. **Archived means a standalone way in is gone.** Some
underlying code now serves a consolidated page. Check its current callers and
tests before deleting it in v6.2.

## Archived in v6.1

| Surface | Where the code still is | Why |
|---|---|---|
| Proof Distribution → standalone **Rights** tab | `src/pages/proof-distribution/ProofDistributionPanel.tsx` | The unique coverage, rights and removal work now appears in Distribution Log alongside each placement's event trail. |
| Lead Magnet Studio → **Opt-ins** | `src/pages/lead-magnet/LeadMagnetStudioPanel.tsx` | The notes: "The opt ins isnt necissary to track, and it all needs to be compiled into the single page functionality." |

The standalone Rights tab is removed from `src/config/navigation.ts`; the
placement history is reachable as **Distribution Log**. The navigation test
pins the two-tab layout.

## Archived in v6.1, Phase 1.1

| Surface | Where the code still is | Why |
|---|---|---|
| Offer Studio → **Live use** | `src/pages/offer/OfferLiveUsePanel.tsx` | Its question — where is a superseded version still live? — is a real one and is **not** dropped. It moved into the Offers table, where a drifting offer is named on the offer it belongs to rather than in a separate list, with the specifics in that row's detail. The panel and its 2 tests still compile. |

## Archived in v6.1, Phase 3.7

Lead Magnet Studio became one page. Three of its four tabs went, and none of
them was simply deleted — each one's question is still answerable, somewhere
it belongs better.

| Surface | Where the code still is | Why |
|---|---|---|
| Lead Magnet Studio → **Build** | folded into `src/pages/lead-magnet/LeadMagnetStudioPanel.tsx` | It was a second list of the same magnets with a create button above it. The button is the page's action now; the list was the table twice. Nothing to preserve. |
| Lead Magnet Studio → **Delivery** | folded into the same panel | Three separate things lived here. The **delivery switch** was already duplicated on the Dashboard switch panel, which is where the notes put every switch, so this copy went and the Dashboard's is now asserted by a test rather than assumed. The **approval queue** moved into the row detail. **What-is-owed** moved with it, scoped to the open magnet. |
| Lead Magnet Studio → **Opt-ins** | `src/pages/sales/LeadCapturePanel.tsx` | Capture endpoints are created and switched in Sales OS → Capture, which the notes leave alone, and its tests already covered the show-the-token-once rule. Nothing became unreachable, so the duplicate here went rather than being rebuilt. |

**What did not flatten.** The approval act stayed a full panel rather than
becoming a row-menu item. Approving a magnet means approving exact bytes and
the words that carry them, and the old Delivery tab showed the recorded scope
and payload hash before you decided. A menu item that approved something you
could not see would have been a worse page, not a tidier one, so the decision
sits in the detail panel beside the thing it decides — and it shows what the
*approval* recorded, not what the version row says now, because the gap
between those two is exactly the "changed after approval" blocker.

## Archived in v6.1, Phase 0.3 — Motion Design

| Surface | Where the code still is | Why |
|---|---|---|
| **Motion Design** (whole module: Scenes, Renders, Brief) | `src/pages/motion/MotionScenesPanel.tsx`, `src/pages/motion/MotionDesignPanel.tsx` | Alex's decision of 4 November. Only the route in is gone; both panels still compile, as with every other archived surface. |

This one needed asking rather than inferring, because the instructions
conflicted and the conflict was not resolvable from the text:

- the 31 October notes said "This page can be left alone for now as I believe
  we will discontinue it" — left alone, not removed
- the phase 0 list named Motion Design among the surfaces to
  archive-and-document, **and** named it again under "deliberately deferred"

So one instruction said leave it, one said archive it, and one said defer it —
two of those three in the same message. The plan recorded it as deferred and
flagged the contradiction rather than picking, which is why it was still open
when phase 0 was otherwise finished. Asked directly on 4 November, Alex chose
to archive it now.

Worth keeping as a process note: a surface named in two places with two
different fates is not a detail to resolve by inference. It is one question,
and asking it cost a sentence.

Alex's 11 November client-view order puts Motion Design under Secondary Flow.
That later instruction restores the route to its existing Brief, Scenes and
Renders panels; the 4 November archive decision above remains historical.

## Archived in v6.1, Phase 3.9 and 3.11

| Surface | Where the code still is | Why |
|---|---|---|
| Website Studio → **Results** | `src/pages/reporting/PagesReportingPanel.tsx` | Not archived so much as **de-duplicated**. It rendered `PagesReportingPanel` with `pageType="landing"` — byte for byte what Attribution OS → Landing Pages already renders. Two routes to one component is a duplicate, not a tab, and reporting belongs to Attribution OS. The component is untouched and still reached from there. |
| Sales OS → **Pipeline** | `src/pages/sales/ProspectsLeadsPanel.tsx` | **Moved, not archived**: it is now Attribution OS → Pipeline. What happened to the leads is an attribution question rather than a sales-agent one. `SalesAccessRequestsPanel` moved with it, because it is the gate on who may see those leads and splitting the two would leave a list of names with its permission control on another page. The `prospects-leads` legacy redirect follows it. |

Sales OS now opens on **Agents**, per the notes' "Agents as the main table
page". The first tab is the one a module opens on, so the order is the claim
about what the module is for.

## Archived in v6.1, Phase 5.14 — Meta Ads Studio's write surfaces

The notes downgrade both Ads Studios to "read-only API views with per-campaign
data on click", and say why: *"Deliberately less than today: the build and
management moved to a human paid-ads operator."*

**Google Ads Studio needed no change.** All three of its tabs already perform
zero writes, so they are read-only views of build state already. Removing
informational views would have cut capability for no reason.

**Meta Ads Studio lost two tabs.**

| tab | was | why it went |
| --- | --- | --- |
| Build | `MetaBuildApprovalPanel` | It is the board that authorises creating real campaign, ad set, creative and ad objects on a live Meta account — an executor, and executors are out of v6.1's scope. Its own doc comment says it "adds the decision that lifts the refusal". |
| Campaign Builds | `CampaignExecutionPanel` | The same component Campaign Factory renders. A second route into one panel is the duplication this phase has removed four times. |

**Nothing was orphaned, which was checked before removing either.**
`CampaignActionApprovalsPanel` reads `campaign_action_approvals` generically and
decides any `action_key` through `decide_campaign_action_approval_v6`, so a
`meta_ad_build` approval is still decided in the Approval Inbox. The build sheet
and approved-creative preparation still live in Campaign Factory's own Meta
activation section, which already links to that inbox tab.

**The panels still compile and are still tested.** Only the routes in are gone,
which is this document's usual bargain: an unknown `?tab=` falls back to the
first tab, so a bookmarked `meta-ads-studio?tab=build` lands on Paid
Distribution rather than a blank page.

**What would bring Build back:** a verified executor for `campaign_action`. The
coverage ledger has it as `missing` — "Only Google Ads JSON and page HTML
previews are proved; other action keys and executor rechecks remain incomplete"
— and `CampaignExecutionPanel` still hardcodes `externalActionsAvailable={false}`.

## What replaces them

Proof Distribution has two tabs: **Destinations** and **Distribution Log**.
The log reuses the placement rows, append-only events, rights coverage and
removal actions. The former Rights deep link opens this combined view. This
restores the operator path to the existing history; provider read-back remains
a separate Phase 7 acceptance gate.

Opt-ins folded into the single-page Lead Magnet Studio, which is a table of
magnets plus one build button. That page is built: see Phase 3.7 above for
where each of its three retired tabs went.

## For v6.2

Delete only code that is genuinely unreachable after checking its data and
actions against the current Distribution Log. The placement rows, event trail,
rights coverage and removal actions are live parts of that page.
