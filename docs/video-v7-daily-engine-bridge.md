# Daily Engine → code-video bridge

## Current state

The deployed v5 daily planner creates `creative_build → video_build → video_edit`
for a reel or video story. That path remains necessary for existing workflow
runs. The code-video project path starts from a reviewed brief and supported
model records, then produces a review-ready asset only after scene, audio,
render, physical probe and internal creative checks. Its current manual and
Production-bot entry points do not accept a v5 daily workflow step.

Migration 695 adds a **configuration prerequisite only**. A service-only
function records the selected current organic route package and exact
supported model review IDs/hashes for a client's daily settings campaign.
It checks client ownership, organic route, plan fingerprint, latest route
version and model review state. It leaves the Engine and video workers
unchanged, creates no project, and makes no provider request. The receipt is
mutable for the next run; each run must snapshot it and recheck currency.

Migration 696 adds an atomic service-only start for an explicitly versioned
daily item. It requires a sealed v6 daily run, accepted and approved video
brief, matching frozen route/source receipt, enabled daily settings, available
video script worker and unexpired cutoff. One transaction creates one
`video_projects` row, one script job and one step binding. A duplicate start
returns the same IDs. It also binds the exact brief-body hash and daily source
digest into downstream source checks, so a changed brief or review holds
later workers. The deployed v5 planner does not create v6 runs, so this start
path is not automatically invoked yet.

## Required execution contract

1. Add a new workflow version for newly planned daily packages. Keep all v5
   rows and their graph readable and executable; never rewrite their steps.
2. Before sealing a new run, require the current organic route, accepted
   campaign plan, supported model sources and approved brief policy. Freeze
   their IDs, review hashes and plan fingerprint in the run snapshot.
3. For each video role, stop after accepted ideation and briefing. Call the
   daily service start from the reconciler, without impersonating an MCP bot
   or manager. A paused worker must leave the item visibly held and no
   partial project.
4. Reconcile the project as a long-running item. Completion of its script job
   is not completion of the video. Bind a final asset only after every
   requested aspect has an accepted candidate, stored bytes pass read-back,
   and `video_project_attachments_v1` records the exact version. Preserve
   brief, campaign, organic route and daily item lineage on the asset.
5. Internal QA must verify project/asset/Storage identity and source currency
   before accepting the daily final step. Human asset approval remains a
   separate exact-version decision; scheduling and publication remain gated.
6. A stale route, changed model review, paused worker, retry, failed render,
   duplicate attachment or cutoff must produce a clear held/failed state
   without another external effect or fabricated ready asset.

## Exit evidence

Use a disposable rollback fixture with an existing v5 package and a new
versioned package in the same database. Verify one current video brief creates
one project, pause and stale-source paths leave no project, retries do not
duplicate jobs or assets, attached bytes and route/brief lineage match, and
the old v5 run still reconciles. Then inspect the signed-in client page and
run one scoped production preparation case before calling the bridge
operational. Keep outbound switches off until separate approval and provider
receipt gates pass.
