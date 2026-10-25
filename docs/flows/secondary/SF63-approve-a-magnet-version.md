# SF63 — Approve a magnet version and turn on delivery

**Where.** Clients → [client] → Delivery → Lead Magnet Studio → Build / Delivery
**Owner.** Client manager. **Reviewed.** 25 October 2026. **Part of** MF11, MF15.

## Do it
1. **Build** → read the version, then **Approve this file and route**.
   The approval covers **Bytes approved** — these exact bytes — **and** the delivery route.
   Both, together.
2. **Delivery** shows the state. *"Delivery switched off."* means
   `lead_magnet_delivery_enabled` is off (SF06).

## The bytes are re-checked at send time
The courier **re-downloads and re-hashes the file before attaching it**. A file swapped after
approval is refused rather than sent. So "approved" means these bytes, not this filename.

## Turning delivery on
This is the switch that starts emailing strangers. Before turning it on:
- [ ] An approved version exists
- [ ] The file is the right one, opened and read
- [ ] The offer figures in it are current (SF22)
- [ ] The consent wording on the capture endpoint covers sending it (SF61)

## Revoking
Revoke the approval when the file is superseded (MF15 stage 4). Until you do, the old
version still has a standing approval and still counts as live in the drift view.

## Troubleshooting
Read `lead_magnet_due`. One delivery per submission is enforced, so a lead does not get the
same magnet twice.
