# Video V3 independent storyboard review — 20 November 2026

After the source-bound writer returns valid IR, the paused `video_script`
worker now makes a second model call with a separate accuracy and pedagogy
system instruction. The reviewer sees the IR, per-scene citations and exact
source text. It returns a pass or fail, reasons and at most twelve bounded
narration/props edits. Code applies edits only to unlocked, existing scenes,
requires valid cited source IDs and revalidates the resulting IR. A failed or
malformed review holds the project for a human. A passing review still stores
the draft in `needs_human` because renderer compilation and human claim
acceptance are not complete.

Writer and reviewer usage are recorded under distinct idempotent receipt keys
for the same job attempt. The worker checks source currency after writing and
again after review, before storing output. If a source changes, it does not
store the draft. An API failure after a paid writer pass does not trigger a
blind retry that could repeat the call under the same receipt key.

Local verification uses mocked model completions: focused review tests cover
valid edits, a failed review, unknown citations and invalid props; worker
tests cover source changes, successful replay and invalid review cost
accounting. Typecheck and build are required before this source slice can be
reviewed. No real model call, render, hosted migration or outward action was
performed. Independent model review is an additional gate, not proof of claim
truth; exact human review remains required.
