# SF31 — Place proof manually where no write API exists

**Where.** Clients → [client] → Delivery → Proof Distribution → Placements
**Owner.** Whoever does the placing. **Reviewed.** 25 October 2026. **Part of** MF06.

## When
`third_party_directory` is supported *manually*: no write API exists for most directories.
The payload is rendered here, a person places it, and they record what happened. The
placement sits at **`awaiting_manual_placement`**.

## Do it
1. Open the placement. The rendered payload is what to paste — use it rather than rewriting,
   so what is placed matches what was approved.
2. Place it on the directory.
3. Record the **external record** — the URL or listing ID — and the evidence.
4. The placement moves to `placed`, then `verified`.

## Why the evidence matters
Without it, "we placed proof in twelve directories" is a claim with nothing behind it, and
nobody can check or retract it later. If rights lapse (SF32) the external record is how you
find the thing that needs removing.

## Gotcha
Do not mark it placed before you have placed it. The state is the only thing standing between
an honest omnipresence report and a fictional one.
