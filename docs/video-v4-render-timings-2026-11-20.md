# V4 render timing source boundary

`renderTimingsFromReceipts` assembles the Remotion timing shape from the
persisted scene audio and optional music receipt for one client, project and IR
version. It refuses a missing or duplicate scene receipt, changed narration,
duration or alignment drift, an unfiled music path, and unsigned or extra media.
The MP3s already contain the physical 400 ms tail; no extra tail is added.

This is a source boundary for the later render worker. A signed URL and a
database receipt do not prove that Storage still has the same bytes. Before
using this assembly in a render, the worker needs a service-only readback that
compares the current Storage object ID, version and update time with each
receipt and verifies the media bytes or hashes. The existing audio upload
identity functions are limited to the `timing` stage, so they cannot serve
this `timed` render preflight unchanged.

Focused timing tests and the runtime production TypeScript build passed
locally. No live provider, render, hosted migration or distribution was run.
