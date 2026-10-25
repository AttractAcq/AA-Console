# SF21 — Read claim evidence and fix a claim whose proof expired

**Where.** Clients → [client] → Delivery → Offer Studio (v2) → Live use →
**Claims, and what stands behind them**
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF15, MF06.

## Why it exists
Sign-off checks that a quantified claim has proof. It cannot check it forever: **rights
expire after a sign-off and the claim does not know.**

## Do it
Read the table: **Claim**, **Kind**, **Proof**, **Problem**. The good state per claim is
**Fine**.

| Problem | Fix |
|---|---|
| *A quantified claim with no proof recorded* | Attach proof, or soften the claim (SF20) |
| *The proof behind this claim no longer exists* | The asset was deleted. Re-capture it (SF23) |
| *The proof behind this claim is not cleared* | Clear the rights (SF25) |
| *Permission for the proof behind this claim expired on …* | Renew the permission, or stop making the claim |

## When to run it
- Whenever you reprice (MF15)
- On a schedule, regardless — monthly is reasonable
- Before any client-facing report that repeats the claims

## Gotcha
A claim with expired proof is still sitting on every live page and ad that quoted it. Fixing
the claim here does not fix those — follow MF15 stage 4 for each live surface.
