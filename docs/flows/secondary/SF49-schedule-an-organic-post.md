# SF49 — Schedule an organic post

**Where.** Clients → [client] → Delivery → Organic Content Distribution → Assets / Organic
**Owner.** SMM. **Reviewed.** 25 October 2026. **Part of** MF03, MF09.

## Do it
1. **Assets** shows what is available to send, with **Platform**, **Channel**, **Date** and
   **Time**.
2. Pick the approved asset. Only approved assets should be scheduled (SF42).
3. Set **Platform** (`facebook`, `instagram`, `tiktok`, `linkedin`, `youtube`) and
   **Channel** (`organic`).
4. Set **Date** and **Time** in the client's audience's timezone, not yours.
5. **Organic** shows the resulting schedule.

## Scheduling is not publishing
A post publishes when:
1. `publishing_enabled` is on for the client (SF06)
2. The post has its human approval (SF42)
3. The publish sweep runs at its time

Read `publish_due` and `distribution_due` (SF50) for anything stuck.

## Gotcha
The format must be supported on the surface. A carousel publishes whole (SF38), a story is
vertical and short-lived (SF39), and not every platform takes every format — the `_due` view
says so rather than failing silently at send time.
