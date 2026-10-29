# SF22 — Read offer version drift after a reprice

**Where.** Clients → [client] → Delivery → Offer Studio (v2) → Live use
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF15.

## What it answers
"Where is the old version still live?" — the question somebody asks the day after a reprice,
and which nothing could answer before this view existed.

## Read it
| Column | Meaning |
|---|---|
| **Offer** / **Version** / **Current** | What this surface carries vs what current is |
| **Carrying it** | Campaign, package, lead magnet or campaign page |
| **Live** | Whether that surface is actually live |
| **Problem** | The sentence saying what is out of date |

Good state: *"Nothing live is carrying a superseded offer."*
Expensive state: *"Carrying v2 while v3 is current, and it is live."*

## What "live" means per surface
| Surface | Live when |
|---|---|
| Campaign page | An approved publication has committed it |
| Lead magnet | A version has a standing approval |
| Package | Never — a frozen input, not a live surface |
| Campaign | **Not claimed.** A v6 campaign's live state is gated elsewhere and this view does not guess |

That last row is deliberate: unknown stays unknown.

## Then
Fix each live superseded surface — MF15 stage 4. Nothing updates itself.
