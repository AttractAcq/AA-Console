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

Migration 697 adds a service-only planner for new `v6.daily.code_video.1`
runs. It freezes the current route, source digest and plan fingerprint, creates
the four daily roles, and gives each video role a `video_script` project step
instead of the old footage build/edit chain. The generic workflow reconciler
skips these code-video steps so it cannot queue a script job against a brief
ID or treat script completion as a final MP4. Image steps and all existing v5
runs keep their current logic.

Migration 698 adds the dedicated long-running project reconciler and connects
it to the runtime loop. It starts eligible pending video steps and leaves
script/audio/render work open. It accepts an attached MP4 only after checking
the exact project, brief, route, supported model snapshot, accepted render
candidates, attested bytes and current Storage object. Attachment now carries
the brief and daily content format onto the asset. The resulting artifact
passes the existing daily role/campaign/pillar validation trigger. A failed
or stale project retains a visible blocker; a completed script job alone
cannot finish the step.

## Required execution contract

1. Keep all v5 rows and their graph readable and executable; never rewrite
   their steps. The new planner is service-only and must be selected by an
   explicit daily setting or operator request before activation.
2. After accepted ideation and briefing, call the
   daily service start from the reconciler, without impersonating an MCP bot
   or manager. A paused worker must leave the item visibly held and no
   partial project.
3. Reconcile the project as a long-running item. Completion of its script job
   is not completion of the video. Bind a final asset only after every
   requested aspect has an accepted candidate, stored bytes pass read-back,
   and `video_project_attachments_v1` records the exact version. Preserve
   brief, campaign, organic route and daily item lineage on the asset.
4. Internal QA must verify project/asset/Storage identity and source currency
   before accepting the daily final step. Human asset approval remains a
   separate exact-version decision; scheduling and publication remain gated.
5. A stale route, changed model review, paused worker, retry, failed render,
   duplicate attachment or cutoff must produce a clear held/failed state
   without another external effect or fabricated ready asset.

## Exit evidence

The rollback fixture verifies one current brief creates one project, pause
and stale-source paths leave no project, retries do not duplicate jobs, and
script completion produces no final artifact. The full attached-MP4 positive
path, a stale Storage negative case, and coexistence with an in-flight v5
package still need a dedicated fixture. Then inspect the signed-in client
page and run one scoped preparation case before calling the bridge
operational. Keep outbound switches off until separate approval and provider
receipt gates pass.
