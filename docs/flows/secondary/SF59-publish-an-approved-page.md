# SF59 — Publish an approved page

**Where.** Clients → [client] → Delivery → Website Studio (v2) → Publish
**Owner.** Marketing Director. **Reviewed.** 25 October 2026. **Part of** MF11, MF15.

## Do it
Once approved (SF58), the page publishes on the next sweep, provided
**`campaign_actions_enabled`** is on (SF06).

The write **re-hashes the page immediately before the commit**. A snapshot records what was
reviewed; it cannot stop somebody regenerating the page afterwards. Without the re-hash,
"the exact bytes a person approved" would mean "a page id a person approved".

If the hash no longer matches: *"This page changed after it was approved. Request approval of
the new version."*

## Read the board
Columns: **Page**, **Destination**, **State**, **Commit**, **Approved bytes**.
**Every commit, in order** below is the history.

States and what they mean:

| State | Meaning |
|---|---|
| *Ready to publish on the next sweep* | Approved, waiting |
| *Published. Nobody has tested the form yet.* | Live, unproven — **not finished** |
| *Published, but the form probe failed: …* | Live and broken. The page stays up |
| *Live and tested.* | The only state that earns the word live |

## Troubleshooting
Read `campaign_page_publish_due`, shown as **State**. The usual causes: the switch is off,
the package was superseded, the page has no built HTML, or the hash changed.

## Next
**Run the probe** (SF60). Publishing is not the end of MF11.
