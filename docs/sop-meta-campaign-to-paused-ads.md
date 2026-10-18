# SOP — Campaign to paused ads in Meta

**Purpose.** Take a campaign from nothing to a complete, paused structure in a client's
Meta ad account, ready for a person to launch.

**Scope.** AA Console and Meta Ads Manager. Paid only. Organic distribution is a
different SOP.

**Owner.** Marketing Director.
**Last reviewed.** 4 October 2026.

**The one rule.** Nothing in AA Console can make an ad live. Campaigns, ad sets and ads
are created PAUSED and there is no code path that sets them active. Spend begins only
when a person switches them on in Ads Manager, deliberately. If you believe you have
launched ads from the console, you have not — read Stage 11.

---

## Before you start — per client, once

**Clients → [client] → Account → Integrations & Credentials**

1. **Add** → provider `Meta` → **Account ID** → the ad account as `act_1234567890`.
   Meta shows the bare number in its own UI; type the `act_` prefix yourself. Anything
   else in this field is refused, because a wrong value here puts real money in someone
   else's account and Meta accepts it silently.
2. **Credential** → the access token. Use a **System User** token from Business
   Settings → Users → System users, not a personal one: a personal token dies with the
   session that made it. The token is stored in Supabase Vault and never shown again,
   so keep your own copy until a build has succeeded.
3. In the table's **Ads** column, **"Add page for ads"** → **Facebook page ID**
   (required) and **Pixel ID** (optional). Digits only, no prefix, in both.

**Status must read `connected`.** If it reads `error`, the token is dead — the metrics
pull is the only thing that writes that state, and it only writes it when Meta rejects
the credential. Replacing the credential clears it.

**No pixel means fewer templates.** Without a pixel the only templates that can build
are **P5 (Lead magnet)** and **O2 (Event or webinar)**. Everything that optimises for
conversions or landing-page views — R1, R2, R3, C1, C2, C3, O1 — is refused until a
pixel is on the integration.

---

## Stage 1 — Create the campaign

**Clients → [client] → Delivery → Campaigns → New Campaign**

| Field | Notes |
|---|---|
| Campaign name | Becomes the campaign name in Meta |
| Campaign template | Labelled optional. **Not optional for ads** — see below |
| What this campaign is for | The planner writes the plan from this plus offer strategy and ICP |
| Generate content ideas with this plan | Leave on unless ideas already exist |

> **Trap.** The template field says "optional" because a campaign can be planned without
> one. A campaign with no template **cannot be built in Meta at all** — there is no
> objective to build it with. Pick one, and pick one that points at a **page**.

Saving queues the Campaign Planner.

## Stage 2 — Let the planner finish

The card reads "The planner is writing this now", then fills in Channels, Scored on and
the rest of the plan. If it never ran, press **"Run the planner"**.

## Stage 3 — Read the readiness gate

The card grows a **"Before this can launch"** list with a red or green dot per item.
This is the console's own campaign readiness. It is **not** the Meta build's checks —
those are separate and stricter.

## Stage 4 — Produce the creative

**Delivery → Ideation** (Generation, then Briefs) → assets arrive in
**Delivery → Media → Image Library** and in the campaign's own content list at the
bottom of the campaign card.

> **Only single images build as ads.** Carousels and video are refused by name. A
> campaign whose content is all carousels looks full and builds nothing.

## Stage 5 — Approve the assets

**Delivery → Approvals.** An asset must reach review status **approved** to be eligible.

> Note for whoever owns this gate: the Meta build requires `review_status = approved`
> and nothing more. The Approvals screen separately tracks whether a *human* approved,
> and the build does not check it. A bot-approved asset will build.

## Stage 6 — Write the ad copy

On the campaign card's content list each asset shows **"· No ad copy"**,
**"· Has ad copy"** or **"· Built in Meta"**. Press **"Write ad copy"**:

- **Primary text** — the words above the image (required)
- **Headline** — the bold line under it (required)
- **Description** — often not shown, depending on placement
- **Link** — where the ad sends people
- **Call to action** — the list is filtered to what the template allows

> **This is the step that opts an asset into the build.** An approved image with no copy
> is treated as organic content and silently left out — not an error, just absent. If a
> build reports fewer ads than you expected, look here first.

## Stage 7 — Budget, countries, conversion event

On the campaign card, the **Meta ads** section → **"Budget and countries"**:

- **Daily budget** — what the ad set may spend per day, **in the ad account's own
  currency**. Do not convert it. The runtime reads the currency from Meta at build time.
- **Countries** — two-letter codes, comma separated.
- **Conversion event** — only for templates that optimise for conversions, and only
  works with a pixel on the integration.

## Stage 8 — Check the three indicators

The same section shows: *Template points at a page* · *Daily budget and countries* ·
*Meta ad account and page*. Get all three green before continuing. This is a
convenience check and not the real one — the build runs the full check itself.

## Stage 9 — Build

Press **"Build in Meta (paused)"**.

- A second press while one is running is refused.
- A refusal lists **everything** wrong at once, not one problem per attempt. Fix the
  whole list and press again.
- **Pressing it twice is safe.** Every Meta id is written back the moment it arrives,
  so a second press finishes what is missing rather than duplicating. The button
  becomes **"Build again (paused)"**.

## Stage 10 — Open the paused structure

The card then reads *"Built in Meta [date], paused"* with an **"Open in Ads Manager"**
link that deep-links to that campaign in that account.

**That link is the end of the console's job.**

## Stage 11 — Launch, in Meta, by a person

In Ads Manager: review the campaign, the ad set, the budget, the targeting and every
ad. Then set them Active there.

> **The collision worth knowing.** The **"Launch"** button on the campaign card does
> *not* launch your ads. It marks the campaign live **in the console** once readiness
> passes, and touches nothing in Meta. Ad spend starts only in Ads Manager.

---

## When something is refused

| What you see | What it means |
|---|---|
| "This campaign has no template, so there is no Meta objective to build it with." | Stage 1. Set a template. |
| "X sends people to [somewhere], which cannot be built yet." | The template's destination is not a page. Only page templates build. |
| "No approved image in this campaign has ad copy yet." | Stage 5 and 6. Approve, then write copy. |
| "[Asset] is a carousel / is a video." | Only single images build. |
| "Set a daily budget" / "Choose at least one country" | Stage 7. |
| "The Meta integration has no Facebook page." | Stage 0, step 3. |
| "OFFSITE_CONVERSIONS needs a pixel to count conversions against." | Add a pixel, or use P5 or O2. |
| "This client has no ad account id recorded. "[name]" is the integration's name, not an account." | The Account ID field holds a label, not `act_…`. Stage 0, step 1. |
| "This campaign ended on [date]." | An end date in the past. Meta will not build an ad set that has already finished. |
| Status `error` on the integration | The token was rejected by Meta. Replace it; storing a new credential clears the state. |

## If there is no usable token

The build cannot run without a credential, and the credential is what usually breaks.
Until one exists, the campaign is still fully specified in the console and somebody with
Ads Manager access can create the structure by hand.

**If you do that, record the ids afterwards.** Until the Meta campaign id and ad set id
are on the console's campaign, reporting cannot match the spend, and a later press of
Build creates a second campaign beside the one you made — with the budget doubling the
moment both are launched.

> **Not yet in production.** A "Write build sheet" button that prints the exact fields
> to type, and a "Record a hand build" form for the ids, are complete and under review
> in PR #124. Until that ships, both steps are manual. Revisit this section when it
> lands.
