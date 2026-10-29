# SF07 — Run one intelligence agent and read the record

**Where.** Clients → [client] → Delivery → Intelligence OS (`?view=intelligence`)
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF01.

## Do it
Each tab is a record domain with its own run button, named after the inputs it takes.

| Tab | Run button | Reads |
|---|---|---|
| Business Context | **Draft the business context** | Onboarding |
| ICP | **ICP Inputs** | Business context |
| Market | **Market Inputs** | Business context |
| Competitors | **Competitor Inputs** | Business context, market |
| Branding & Associations | **Branding Inputs** | The above |
| Campaign Intelligence | **Campaign Inputs** | The above |
| Proof Intelligence | **Proof Inputs** | The above |

Run them in that order — the later ones read the earlier ones.

## Reading the state
`Not generated` → `Queued — waiting for a worker` → `Claimed — starting` → `Running` →
`Completed`. Two others matter:

- **Held — waiting on a cap or a paused agent** — a spend cap or a paused agent, not a
  failure (SF53).
- **Failed** — the error prints above the record.

The header shows `n/m generated`. Each record has **Content**, **Reference** and **Enums**
sections from its template.

## The part people skip
**Edit** what is wrong. These are drafts by a model that has only what you gave it in SF01.
A client manager who reads and corrects them is the difference between intelligence and
plausible text. Saved edits are what everything downstream reads.
