# SF52 — Read the slot board and move a slot

**Where.** Clients → [client] → Delivery → Organic Content Distribution → Engine
**Owner.** SMM. **Reviewed.** 25 October 2026. **Part of** MF09.

## The path a slot walks
`planned` → `ideating` → `idea_selected` → `briefing` → `building` → `editing` →
`copywriting` → `qa` → `awaiting_approval` → `scheduled` → `published`

with `failed` and `rejected` as the exits. **`awaiting_approval` is the human gate**;
everything before it is internal.

Every transition is recorded, so a slot that stalled tells you exactly where.

## Read it weekly, not quarterly
A slot sitting in `failed` is a silent gap in the client's feed. Nothing shouts.

## Where slots usually stall, and why
| Stuck at | Usually |
|---|---|
| `planned` | No pillars, or the horizon is zero (SF51) |
| `ideating` | Ideation job queued or held (SF53) |
| `building` | Build job held behind a cap, or failed (SF53) |
| `qa` | Scoring below `min_qa_score` repeatedly — read the detail (SF41) |
| `awaiting_approval` | Waiting for you |
| `scheduled` | `publishing_enabled` off, or the sweep (SF50) |

## Related views
`slot_board`, `slot_timeline`, `slot_decisions`, `engine_activity`, `engine_readiness`.
`engine_readiness` is the one to read before claiming the engine is working.
