# SF70 — Deduplicate a lead, and how the matching works

**Where.** Sales OS, `client_leads.dedupe_key`
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF12.

## How a duplicate is decided
Two rules, and they are narrow on purpose:

1. **Exact email match.**
2. **The last nine digits of the phone number.**

The phone rule exists because the same person gives their number as `07700 900123`,
`+447700900123` and `447700900123`, and those are one human. Matching on the last nine digits
catches all three without matching unrelated numbers.

## What happens
Two enquiries from the same person through different campaigns collapse to **one lead**, and
**the first source wins**.

## Why that matters before you argue about attribution
A prospect who saw a P1 ad, followed, and three weeks later filled in a form from a Google
search is recorded against the first touch. That is a defensible choice, but it is a choice —
know it before presenting a channel comparison.

## When to intervene
- Two leads that are genuinely the same person but gave different emails and numbers: merge
  by hand, keeping the earlier source.
- Two people at one business with one shared email: they will collapse. Use separate contact
  details if both need working.

## Gotcha
A probe lead uses real contact details too. Keep the probe's details distinctive so it never
collides with a real prospect (SF71).
