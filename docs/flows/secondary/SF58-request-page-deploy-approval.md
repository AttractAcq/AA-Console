# SF58 — Request page-deploy approval

**Where.** Clients → [client] → Delivery → Website Studio (v2) → Publish
**Owner.** Client manager requests; Marketing Director approves. **Reviewed.** 25 October 2026.
**Part of** MF11, MF15.

## Why this route only
A v6 campaign page cannot be published by any other route — not the admin route, not MCP, not
the legacy publisher. That block is deliberate and it stays. This is the one key.

## Do it
1. Finish the page (SF57). Do not request approval on a page you intend to keep editing.
2. Request page-deploy approval.
3. The request **snapshots the exact revision and the byte hash of the built HTML**. What the
   reviewer reads is what will ship.
4. A person approves it in **Approval Inbox → Campaign actions**.

## What the reviewer should actually do
Read the snapshot, not the preview. The snapshot is the artifact being approved. Check the
offer figures, the claims, and that the form is there.

## Why requests get refused
| Refusal | Meaning |
|---|---|
| *That approval has no reviewable snapshot* | Should not be reachable; a snapshotless deploy cannot be approved |
| *The campaign package was superseded after this page was approved* | A newer manifest version exists. Request again |
| *This page changed after it was approved* | Someone regenerated it. Request approval of the new version |

## Gotcha
Approval is bound to the bytes. Rebuilding the page for any reason — even a typo fix — voids
it. Collect your changes, then request once.
