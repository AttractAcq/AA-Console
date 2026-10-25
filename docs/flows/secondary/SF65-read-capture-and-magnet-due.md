# SF65 — Read lead capture due and lead magnet due

**Where.** `lead_capture_due`, `lead_magnet_due`
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF11.

## Why these two exist
The public side of the system refuses in one sentence —
*"This form is not accepting submissions."* — and deliberately never says why, because an
explanatory refusal is a probing tool for anyone on the internet. These views are where the
real reason lives, on the inside.

## `lead_capture_due` — why a form is not taking submissions
| Cause | Fix |
|---|---|
| The endpoint is disabled | Enable it (SF61) |
| The endpoint was revoked | Create a new one; tokens cannot be un-revoked |
| It is past its expiry | Extend or re-create |
| It hit its maximum submissions | Raise the limit or re-create |
| No consent wording | Add it (SF61) — the probe fails without it |
| No campaign attributed | Attribute it, before traffic arrives |

## `lead_magnet_due` — why a magnet has not been delivered
| Cause | Fix |
|---|---|
| `lead_magnet_delivery_enabled` off | SF06 |
| No approved version | SF63 |
| The file's bytes no longer match the approved hash | Re-approve the correct file (SF63) |
| Already delivered for this submission | Nothing wrong — one delivery per submission |
| Delivery failed and is retrying | Watch the attempt count; there is a ceiling (SF81) |

## Gotcha
If a client says "the form is broken", read `lead_capture_due` before touching the page. The
page is usually fine and the endpoint is the problem.
