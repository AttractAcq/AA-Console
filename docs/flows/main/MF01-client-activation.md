# MF01 — Client activation

**Flow.** MF01 · main · Foundation
**Purpose.** Take a signed client to the point where the system understands their business
well enough for every other flow to run.
**Scope.** Account configuration and the first intelligence pass. No campaign, no content,
nothing external.
**Owner.** Client manager.
**Last reviewed.** 25 October 2026.
**Entry.** E1 — a client signs.
**Exit.** Business context written, brand profile set, integrations `connected`, and the
intelligence records generated.

**Composes:** SF01, SF02, SF03, SF04, SF05, SF07, SF08, SF09, SF10, SF19.

---

## The one rule

**Everything downstream is only as good as the business context.** The intelligence agents,
the ideation, the briefs, the offer and every ad read from it. A thin business overview
produces plausible, generic output that looks fine and converts nobody. Spend the time here;
it is the cheapest hour in the whole engagement.

---

## Stage 1 — Onboarding record

**Clients → [client] → Account → Onboarding**

Fill it from the sales call and the client's own words, not from their website.

| Field | Notes |
|---|---|
| Primary contact / Their role | Who we actually speak to. "Owner, practice manager…" |
| WhatsApp, Website, Instagram, Facebook, Address | The address matters — it drives the Google Business Profile work later |
| **Business overview** | What they do, for whom, and what makes it what it is. This is the field that matters most |
| **Ideal customer** | In their words. The ICP agent refines this; it does not invent it |
| **Main offer** | What they actually sell and for roughly what |
| Competitors | Who they lose to, named |
| Brand voice | How they talk. Used by the copywriter |
| Proof / testimonials | What proof already exists, even informally — this seeds MF06 |
| Current marketing | What they are already doing, so we do not duplicate or contradict it |
| Sales process | What happens after a lead arrives. This shapes MF12 |
| Primary / Secondary colour | Seeds the brand profile |

---

## Stage 2 — Contact, identity and brand

1. **Clients → [client] → Account → Contact & Identity** — confirm what Onboarding captured.
2. **Clients → [client] → Account → Brand & Design** — colours, logo and identity assets.
   Creative generation and page building both read this, so an empty brand profile produces
   off-brand output that then fails brand QA later.

---

## Stage 3 — Integrations

**Clients → [client] → Account → Integrations & Credentials**

This is the stage that quietly decides what the client can and cannot run.

- **Meta** (SF02): ad account as `act_1234567890` — type the `act_` prefix yourself; a
  System User token, not a personal one; a Facebook page ID; and a **pixel ID**.
  **Without a pixel, only P5 and O2 can build.** Everything optimising for conversions or
  landing-page views — R1, R2, R3, C1, C2, C3, O1 — is refused.
- **Google Business Profile** (SF03): connect the location. Needed for omnipresence (MF06)
  and for review capture.
- **Site repository** (SF04): **Clients → [client] → Account → Sites → Settings**, plus the
  GitHub installation. Needed before any page can be published (MF11).

Status must read `connected`. If it reads `error`, the credential is dead — only the metrics
pull writes that state, and only when the provider rejects the credential. Replacing the
credential clears it. Read `integration_health` (SF05).

---

## Stage 4 — The first intelligence pass

**Clients → [client] → Delivery → Intelligence OS** (`?view=intelligence`)

Each tab is a record domain with its own run button, named after the inputs it takes. Run
them in this order, because the later ones read the earlier ones:

| Order | Tab | Run button |
|---|---|---|
| 1 | Business Context | **Draft the business context** |
| 2 | ICP | **ICP Inputs** |
| 3 | Market | **Market Inputs** |
| 4 | Competitors | **Competitor Inputs** |
| 5 | Branding & Associations | **Branding Inputs** |
| 6 | Proof Intelligence | **Proof Inputs** |

Each run queues a job. The panel shows its state: *Not generated* → *Queued — waiting for a
worker* → *Claimed — starting* → *Running* → *Completed*. **Held — waiting on a cap or a
paused agent** means a spend cap or a paused agent, not a failure (SF53).

Read each record and **Edit** what is wrong. These are drafts by a model that has only what
you gave it in stage 1; a client manager who reads and corrects them is the difference
between intelligence and plausible text. The header shows `n/m generated`.

---

## Stage 5 — Strategy

**Clients → [client] → Delivery → Intelligence OS** (`?view=strategy`)

| Tab | Run button | Why |
|---|---|---|
| Branding Strategy | **Branding Input** | How the client is positioned |
| Content Pillars | **Propose content pillars** | What the engine is allowed to talk about (SF09) |
| Money Model Strategy | **Money Model Input** | The economics every offer is judged against |

Offer Strategy has moved to its own module: **Delivery → Offer Studio → Offer Strategy**.
Create the first offer and version there (SF19) and sign it off (SF20) — a campaign built
against an unsigned offer carries unapproved copy.

---

## Stage 6 — Confirm the client is activated

Before declaring MF01 done:

- [ ] Business overview and ideal customer are in the client's own words
- [ ] All six intelligence records read *Completed* and have been read by a person
- [ ] Content pillars exist
- [ ] At least one offer version is signed off
- [ ] Integrations read `connected`, and you know whether there is a pixel
- [ ] A site repository exists if the client will need pages

**Do not turn on any switch yet.** Activation is internal work. The five switches in
[`../CONVENTIONS.md`](../CONVENTIONS.md) stay off until there is something approved to send.

---

## Troubleshooting

| Symptom | Read this |
|---|---|
| A record stays *Queued* | The runtime may be down or at its job cap. Check `agent_runtime_status` (SF80) |
| A record reads *Held* | A spend cap or a paused agent (SF53) |
| A record reads *Failed* | The error prints above the record. Usually a thin business context |
| Integration reads `error` | The credential is dead. Replace it (SF05) |
| Only P5 and O2 selectable later | No pixel (SF02) |

---

## Next

MF02 — turn this intelligence into a micro-niche worth attacking.
