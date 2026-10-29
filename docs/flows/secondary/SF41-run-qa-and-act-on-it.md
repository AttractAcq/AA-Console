# SF41 — Run QA and act on a minimum-score failure

**Where.** Clients → [client] → Delivery → Content Production Factory, and engine settings
**Owner.** Creative lead. **Reviewed.** 25 October 2026. **Part of** MF07, MF08, MF09.

## The one rule
**QA is not approval.** The QA agent scores the asset against the brief and the brand. A
person then approves it (SF42). An asset that passed QA has not been approved by anybody.

## Reading a score
QA produces a score and the detail behind it. Read the detail, not the number — the detail
names which check failed and why.

`min_qa_score` on the engine settings (SF51) is the floor below which the engine will not
offer something for approval.

## When something fails
In order of preference:
1. **Fix the brief and rebuild.** Most QA failures are brief failures wearing a costume — the
   asset did what it was told, and it was told the wrong thing.
2. **Regenerate the one broken part** (SF35) if the rest is right.
3. **Rebuild the asset** if the brief was fine and the build was unlucky.

**Do not lower `min_qa_score` to clear a backlog.** That converts a quality problem into a
volume of published weak content, which is worse and harder to undo.

## For video, there is a second gate
**Media → Video quality reviews** screens a finished video for continuity, visual defects,
caption readability, crop, narrative, brand fit and brief execution (SF37).
