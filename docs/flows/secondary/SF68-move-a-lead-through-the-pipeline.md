# SF68 — Move a lead through the pipeline by hand

**Where.** Clients → [client] → Delivery → Sales OS (v2) → Pipeline
**Owner.** Whoever owns the client commercially. **Reviewed.** 25 October 2026. **Part of** MF12.

## Do it
**Lead pipeline** is the board. **Add Lead** for leads that arrived outside the system, with
an **Initial stage**.

Move a lead between stages. Every move is recorded as a `stage_change` event, so the pipeline
has a history and not just a current state.

## The stages
`profile_visit` → `follower` → `lead` → `conversation` → `qualified_conversation` →
`appointment` → `qualified_appointment` → `shown` → `sale` → `cash`, with `lost` and
`qualified`.

**`sale` and `cash` are separate on purpose.** A signed deal that never pays is not revenue,
and MF13's economics read `cash`.

## Record what happened
**Add note** against the lead. Event kinds are `note`, `conversation`, `stage_change`,
`appointment` and `outcome`. Real examples worth writing: **Called**,
**Called and left voicemail**, what was actually said.

**Record `lost` with a reason.** Those reasons are the briefs for R2 objection campaigns — an
objection you have written down is a campaign you can run.

## Archiving
**Archive this lead** → **Confirm archive**. Archived leads leave the pipeline without being
deleted.

## Gotcha
DM leads have to be added by hand, including their campaign, because nothing carries it
(**G01**). Attribution for them is only as good as your note.
