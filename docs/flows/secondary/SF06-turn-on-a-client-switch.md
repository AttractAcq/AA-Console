# SF06 — Turn on a client switch

**Where.** `client_engine_settings`, via the owning module's settings
**Owner.** Whoever owns the client commercially — **not** an engineer.
**Reviewed.** 25 October 2026. **Part of** every external flow.

## The one rule
**These switches are the moment the system starts doing things to real people.** Turning one
on can email strangers, post to a client's public profile or create objects in their ad
account. They are a commercial decision for a named client, never a technical step.

## The five switches
| Switch | What turning it on starts |
|---|---|
| `enabled` | The content engine plans and produces. Internal only — nothing publishes |
| `publishing_enabled` | Approved organic posts actually go out |
| `proof_publishing_enabled` | Approved proof placements actually place |
| `campaign_actions_enabled` | Page deploys, Meta builds and proof releases execute |
| `lead_magnet_delivery_enabled` | Magnets are actually delivered to opt-ins |

**All five are currently off for every client.**

## Order to turn them on
1. `enabled` first. Watch slots reach `awaiting_approval` and read the output for a few days.
2. `publishing_enabled` once a human has approved content you are happy went out.
3. `campaign_actions_enabled` when a page or a Meta build is ready and approved.
4. `proof_publishing_enabled` when placements are approved and rights are clean.
5. `lead_magnet_delivery_enabled` last, and only with an approved magnet version.

## Before each one
- [ ] Something is actually approved and waiting
- [ ] The client knows this is about to become public
- [ ] Integrations read `connected` (SF05)
- [ ] For proof: rights are `approved` and not expiring (SF25)

## Gotcha
A switch being on is only one of four conditions. The runtime flag, the destination's support
flag and the human decision all still apply — see [`../CONVENTIONS.md`](../CONVENTIONS.md).
Turning a switch on does not retroactively send anything that was never approved.
