# Content Engine — build plan

1 October 2026. Status: **proposal, not yet cleared.** It needs Sec review for
the publish milestone (M2) and an Alex CLEAR before work starts on it.

The goal is an engine that keeps any client's channels full of on-brand
content, where the only thing a person does is **approve a post to be
distributed**. Everything before that approval is prepared by machines, and
everything after it is executed by machines.

Read alongside `gap-audit.md` (7 September). Where this plan quotes the state
of production, the figures come from that audit and should be re-checked
before M0 starts.

---

## 1. Where we start

| Stage | Today | Needed |
|---|---|---|
| Strategy (ICP, market, brand, offer, pillars) | Built | Unchanged, triggered automatically at onboarding (M6) |
| Ideation | Built. A person runs it | Started by empty slots in the plan |
| Idea → brief | Waits for a person (`approve_idea_and_generate_brief`) | Approved by policy |
| Brief → build | Waits for a person (`build_brief_with_ai`) | Approved by policy |
| Image / carousel / story build | Built | Unchanged |
| Reel build | Scaffold. Motion pauses, no assembly (`video_build`) | Built end to end (M5) |
| Post copy (caption, hashtags, alt text) | Does not exist. `scheduled_posts.notes` only | Copywriter agent (M3) |
| Quality check | Does not exist | QA agent with automatic regenerate (M3) |
| Asset approval | Person (`human_approved_at`) | **Still a person. This is the one human gate** |
| Scheduling | Person (`schedule_asset`), date only | Automatic slot with a timestamp (M0, M3) |
| Publishing | Does not exist. `record_publication` marks a row only | Platform publisher (M2) |
| Performance | Ingest built, never pulled. `get_performance` is a stub | Insights for each post feed back into the plan (M4) |

## 2. Principles the build keeps

1. **One human commit.** `client_media_assets.human_approved_at` stays the only
   thing that lets a post go out. Every earlier gate becomes a *policy approval*:
   recorded, attributed to the engine, reversible, and never sufficient for
   publishing on its own. This is the existing rule, "machines prepare, a person
   commits", with the commit moved to the one point that matters.
2. **Off by default, for each client.** Nothing starts producing or spending
   until a client's engine is switched on. This matches the ingest toggle.
3. **Budgets are enforced, not just reported.** Each client has a monthly cap.
   The engine checks it before every job it queues, and the cap stops the engine.
4. **Idempotent and resumable.** Every stage is a state change on a row. A worker
   restart or a duplicate tick cannot double-post or double-spend.
5. **Visible.** Every slot shows where it is, why it is stuck and what it cost.
   Silent queues are what `distribution_due` (122) was written to fix. Don't
   build a new one.
6. **Existing security posture.** SECURITY DEFINER RPCs with their own guards,
   RLS on every new table, bot isolation tests for any bot-reachable tool, no
   `can_access_client` on bot RPCs, and `workflow.record_decision` hard-denied.

## 3. Milestones

Each ticket is meant to be **one reviewable PR**. Migration numbers continue
from 135. Each PR keeps CI (frontend, agent-runtime, gateway) green and ships
with tests. Per `AGENTS.md`: no merge, no production migration apply and no
Railway deploy without Alex via Chief of Staff.

### M0 — Foundations

Unblocks everything else. No Sec gate beyond normal review.

| # | Ticket | Scope | Done when |
|---|---|---|---|
| M0.1 | **Post time and timezone** | Migration 136: add `clients.timezone` (IANA, default `Europe/London`) and `scheduled_posts.scheduled_at timestamptz`, backfilled from `scheduled_for` at 09:00 local. Keep `scheduled_for` as a generated or synced column so `distribution_due`, the board and the gateway keep working. Update `schedule_asset` and `content.queue_distribution` to accept a time. | `distribution_due` computes `due_now` from `scheduled_at`. Board and schedule form take a time. Existing tests pass, and new tests cover DST edges. |
| M0.2 | **Copy for each platform** | Migration 137: `post_copy` table (`scheduled_post_id` or `asset_id`, `platform`, `caption`, `hashtags text[]`, `alt_text`, `link_url`, `first_comment`, `cta`, `source` (human or agent), `version`). RLS matches `scheduled_posts`. A copy editor goes in the schedule modal. | A scheduled post shows and edits its caption for each platform. Length limits for each platform are validated in one shared module (`agent-runtime/src/content/platform-limits.ts`, mirrored in `src/lib`). |
| M0.3 | **Spend caps for each client** | Migration 138: `client_engine_budgets` (`client_id`, `month`, `cap_usd`, `spent_usd`) and a `agent_spend_for_client(month)` read over existing usage rows. In the runtime, `dispatchJob` refuses to start a job for a client whose month is over its cap. That is a non-retryable failure with a clear message, not a pause of the agent. | A test shows a capped client's job refused before any provider call. The Economics panel shows cap against spend. |
| M0.4 | **Notifications** | Configure Resend (verified domain, `RESEND_API_KEY` on Railway; an ops task, not code). Add a `notify` module with email and an optional Slack webhook, plus a `notifications` log table, migration 139. | The first real send goes to an internal address with an explicit CLEAR (gap 2 in the audit). |

### M1 — Platform connection

Long lead. **Start the external parts on day one** (see section 5).

| # | Ticket | Scope | Done when |
|---|---|---|---|
| M1.1 | **Meta sign-in flow** | A runtime route `/oauth/meta/start` and `/callback`, admin only, scoped to a client. Exchange for a long-lived user token, list Pages, store the **Page token** and the **IG business account id** in Vault through `admin_store_integration_credential`. Migration 140: `client_integrations` gains `external_account_id`, `token_expires_at`, `scopes text[]`, and `kind` (`ads`, `page`, `ig`). Providers `facebook_page` and `instagram`. | An admin connects a Page and its IG account from Account → Integrations without pasting a token. The secret never reaches the browser. |
| M1.2 | **Token health** | A daily cron job checks each token (`debug_token`), sets `status` to `expiring` or `error`, refreshes where Meta allows, and notifies through M0.4. Extend the migration 124 allow-list to the new states deliberately. | An expired token shows on the Integrations panel and stops publishing for that client only. |
| M1.3 | **Connect the first live client** | Ops: connect the internal AA account first, then Harbour Dental. Switch on the daily metrics ingest. | `metrics_daily` has rows. This closes gap 1 in the audit. |

### M2 — Publisher

**Sec gate.** This is the live publish that `SEC_BAR.md` keeps out until Phase
11c. It needs a design note in `aa-mcp-gateway/docs/` and Sec APPROVE before
merge.

| # | Ticket | Scope | Done when |
|---|---|---|---|
| M2.0 | **Sec design note** | `phase-11c-live-publish.md`: covers the classification matrix, which bot or job may publish, the human-gate proof, the kill switches (for each client, for each platform, globally), the rate limits, and the isolation tests. | Sec APPROVE. |
| M2.1 | **Publisher adapter interface** | `agent-runtime/src/publish/` defines `PublishAdapter { platform; validate(post, copy, media); publish(...): { externalId, permalink } }`. Errors are classified as retryable, needs-human or fatal, following the `metrics_ingest` pattern. | Adapter contract tests with a fake. |
| M2.2 | **Facebook Page and Instagram adapters** | Facebook: `/{page}/photos` and `/{page}/videos`, plus multi-photo posts. Instagram: container → `media_publish` for image, carousel (child containers), reel (poll container status until `FINISHED`), and story. Media goes from Supabase Storage through a signed URL with a short expiry. | Each format is published to a **test Page and IG account** from a staging runtime, with an `external_id` and permalink recorded. |
| M2.3 | **`publish` agent and scheduler** | Register a `publish` agent (`scheduled_only`, `requires_input`). Migration 141: `enqueue_due_publications()` selects from `distribution_due` where `human_approved` is true, `scheduled_at <= now()` and the platform is connected; it locks each row with `publication_status = 'publishing'` and an attempt count. A pg_cron job runs every 5 minutes. The runner calls the adapter, then writes through the same path as `record_publication` (published or failed, with `external_id` and `failure_reason`). Retry up to 3 times with backoff, then fail and notify. | Two concurrent ticks never publish the same row. An unapproved asset is never published even when overdue (a test against the `distribution_due` gate). The board shows publishing, published (with a link) and failed (with the reason). |
| M2.4 | **Kill switches** | `clients.publishing_paused`, a platform flag on the integration, and a global runtime `PUBLISH_ENABLED` env var that defaults to false. | Any one of them stops the next tick. Tests cover each. |

### M3 — The engine

This takes away every human touch except approval.

| # | Ticket | Scope | Done when |
|---|---|---|---|
| M3.1 | **Engine settings** | Migration 142: `client_engine_settings` covers `enabled` (default false), platforms and posts per week for each, `posting_windows` (weekday and local time ranges), `pillar_mix` (weights over `content_pillars`), `format_mix`, `plan_horizon_days` (default 14), `auto_approve_ideas`, `auto_approve_briefs`, `min_qa_score`, and `approval_mode` (per post or weekly batch). A settings panel goes under the client's Distribution section. | An admin configures a client and nothing runs until `enabled` is set. |
| M3.2 | **Slots and the state machine** | Migration 143: `content_slots` (`client_id`, `platform`, `scheduled_at`, `pillar_id`, `format`, `stage`, `idea_id`, `brief_id`, `asset_id`, `scheduled_post_id`, `attempts`, `cost_usd`, `blocked_reason`). Stages run: `planned → ideating → idea_selected → briefing → building → copywriting → qa → awaiting_approval → scheduled → published`, with `failed` and `rejected` as side exits. `advance_slot()` checks each transition and is the only writer. | Illegal transitions raise an error. Each transition is an event row, shown on a slot timeline. |
| M3.3 | **Planner** | A deterministic function, not an LLM: `plan_slots(client)` fills the horizon from cadence, windows and the pillar and format mix, avoiding windows that already have a post. | Unit tests cover cadence, the mix and the timezone. Running it twice creates no duplicates. |
| M3.4 | **Engine tick** | pg_cron runs hourly: `engine_tick()` loops over enabled clients that are under budget. It plans slots, then queues the next job for each slot that is ready, with a cap on jobs in flight for each client. Existing agents get the slot context in `params` (`slot_id`), and on completion they call `advance_slot`. | One tick on a staging client takes a slot from `planned` to `awaiting_approval` with no clicks. |
| M3.5 | **Ideation driven by slots** | Ideation takes `pillar_id`, `format` and `count` from the slot. It runs a small batch (3–5) for each slot, not a 25-idea dump. | The ideas cite the slot's pillar and format. |
| M3.6 | **Auto-select** | An agent (`idea_select`) or a scorer that scores candidates on pillar fit, how different they are from the content archive (118/119 — embedding or title similarity), proof available, and later on performance priors from M4. It records the score and reasons on the idea and approves the best one through a policy-approval RPC (`approved_by_policy`). | Each pick shows its reasons. Rejected candidates stay in the archive. |
| M3.7 | **Policy approvals** | Migration 144: policy-approval variants of `approve_idea_and_generate_brief` and `build_brief_with_ai`, callable only by the engine role. They write a decision row attributed to `engine` and **never touch `human_approved_at`**. | A test shows a policy-approved chain still cannot be scheduled for publishing without a human approval. |
| M3.8 | **Copywriter agent** | A new agent writes `post_copy` for each target platform from the brief, the asset, brand voice and banned words, within the limits from M0.2. | Every slot that reaches QA has copy for each of its platforms. |
| M3.9 | **QA agent** | Checks the asset and copy against brand (banned words, palette and logo use, from `client_brand_profiles`), claims (each claim must cite proof in `client_proof_assets`), platform rules (limits, aspect ratio, duration) and plain risk (health or finance claims, competitor names). It returns a score and findings. Below `min_qa_score` it regenerates automatically, using the existing remake and regenerate-frame paths (106, 108, 115), up to 2 times, then marks the slot `failed` with findings. | QA findings show in the approval card. No slot reaches approval below the threshold. |

### M4 — Approval inbox and feedback

The single human input, and the loop that makes the engine better over time.

| # | Ticket | Scope | Done when |
|---|---|---|---|
| M4.1 | **Approval inbox** | A new page, *Approve to distribute*, for admins and clients by role. Each card shows the asset preview (with carousel frames), the copy for each platform (editable inline), the slot time, the QA score and findings, the pillar, and the cost. Actions are **Approve** (sets `human_approved_at` and schedules), **Approve week**, **Reject with reason**, and **Change time**. | One click takes a slot from `awaiting_approval` to `scheduled`. Approve week works with a confirmation listing what will go out. |
| M4.2 | **Reject means regenerate** | A rejection reason goes back to the slot as an instruction. The engine rebuilds from the right stage (copy only, the asset, or a new idea) based on the reason category chosen. | A rejected slot comes back to the inbox revised, with the reason carried through. |
| M4.3 | **Approval reminders** | Notify through M0.4 when items wait more than 24 hours or when a slot within 48 hours of its time has no approval. Unapproved slots past their time are marked `missed` and re-planned. That is a slot change, not a publish. | No slot is published late without a person seeing it. |
| M4.4 | **Insights for each post** | Extend `metrics_ingest` to pull insights for each media item by `external_id` (reach, saves, shares, plays, follows), stored in `post_metrics_daily`. Make `content.get_performance` real. | Each published slot shows performance on its timeline. |
| M4.5 | **Learning** | A nightly job recomputes weights for each client (pillar, format and window performance against the client baseline, with decay). The planner (M3.3) and auto-select (M3.6) read them, inside bounds set in settings so the mix never collapses to one pillar. Add the prior-window block to `metrics_period_summary` (gap 6). | The weights move with real data, and the change is visible and explainable on a panel. |

### M5 — Video (reels)

Runs in parallel with M3 and M4 once M2 can publish reels.

| # | Ticket | Scope | Done when |
|---|---|---|---|
| M5.1 | **Higgsfield client** | An HTTP client behind the existing `decideMotion` and `readHiggsfieldEnv`. Submit, poll, download to Storage, with the deadline and abort handling from the audit's gap 4. | A shot plan produces motion clips on staging. |
| M5.2 | **Assembly** | Stitch clips with captions, a music bed (licensed library only) and 9:16 export. ffmpeg runs in a separate worker or service, kept out of the main runtime's memory budget. Allow video in `creative_generations`. | The `video_build` output is a publishable MP4 asset with a cover frame. |
| M5.3 | **Reels in the engine** | Allow the reel format in `format_mix`. QA checks duration, ratio and caption burn-in. | A reel slot runs from planned to published on staging. |

### M6 — "Any business" (productisation)

| # | Ticket | Scope | Done when |
|---|---|---|---|
| M6.1 | **Onboarding from a URL** | Website URL in, then crawl and extract to seed the ICP, offer, brand profile (palette and logo from the site) and proof. Run the strategy agents, then propose pillars. A person confirms once. | A new client goes from URL to a first approval queue with no other input. |
| M6.2 | **Self-serve connection** | Clients connect their own Meta account through M1.1 from the client console, not only admins. | No admin step is needed for a client to connect. |
| M6.3 | **More platforms** | LinkedIn (organisation posts), TikTok (Content Posting API; needs TikTok's app audit) and YouTube Shorts as further `PublishAdapter`s, each with its own Sec addendum. | Each platform publishes from staging. |
| M6.4 | **Templates for each industry** | Engine-settings presets (cadence, mix, QA rules) for each vertical, e.g. dental or recruitment, applied at onboarding. | A new client starts from a preset. |

## 4. Sequence

```
Weeks:     1    2    3    4    5    6    7    8    9   10   11   12
M0         ████████
M1 (code)       ████████
M1 (ext)   ░░░░░░░░░░░░░░░░░░░░  Meta app review / business verification
M2              ██(Sec note)█████████
M3                   ███████████████████
M4                                  ████████████
M5                        ██████████████████
M6                                            ████████████████→
```

The **critical path** runs from Meta app review to M2.2 (live publish on a
real account). Everything in M3 can be built and proved on staging, ending at
`awaiting_approval`, before publishing is cleared.

**First end-to-end milestone (about week 6):** one internal client, Instagram
and Facebook, images and carousels, three posts a week, one approval click
each, published automatically.

## 5. External and ops tracks (start now)

| Item | Owner | Lead time |
|---|---|---|
| Meta Business verification, then app review for `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish` and `instagram_manage_insights` | Alex | 2–6 weeks |
| A test Facebook Page and IG business account for staging | Alex / ops | 1 day |
| Resend: verified sending domain, `RESEND_API_KEY` on Railway | Alex | 1 day |
| Higgsfield API credentials and model choice | Alex | — |
| TikTok developer app and Content Posting API audit (M6) | Alex | 2–4 weeks |
| Leaked-password protection on in Supabase Auth (audit gap 3) | Alex | 5 minutes |

## 6. Gates

| Gate | Needed before | Who |
|---|---|---|
| Plan CLEAR | Starting M0 | Alex via Chief of Staff |
| Sec APPROVE on the 11c live-publish note | Merging M2.3 and M2.4 | Sec |
| Production migration apply (136 onwards) | Each milestone's release | Alex |
| `PUBLISH_ENABLED=true` on Railway | First live post | Alex |
| Enabling the engine for each client | Each client | Alex and the client |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Meta app review is slow or rejected | Start week 1. Build and prove everything up to `awaiting_approval` on staging. A manual "post now" fallback can use `record_publication`. |
| The approver becomes a bottleneck | Weekly batch approval, reminders, and auto re-planning of missed slots. Only QA-passed content is shown. |
| Generic content at volume | Slot-level pillar and format targeting, novelty against the archive, proof-backed claims, the learning loop. |
| Runaway spend | Monthly cap for each client enforced in `dispatchJob`, a cap on jobs in flight, and job deadlines (already enforced). |
| Double posting | A row lock and status in `enqueue_due_publications`, plus idempotency on the adapter side (check `external_id` before retrying). |
| Token expiry stops posting silently | Daily token health check (M1.2) with notifications. |
| A brand or claims mistake goes out | The QA agent, the proof requirement for claims, and the human approval itself. |

## 8. Decisions needed

1. **Approval mode default:** each post, or weekly batch? The proposal is each
   post at first, with weekly batch available once QA has a track record.
2. **Policy approvals:** can every client turn on auto-approve for ideas and
   briefs, or only admins?
3. **Client approvers:** can a client user be the approver, or does AA approve
   on the client's behalf?
4. **First client** for the end-to-end milestone: AA itself or Harbour Dental?
5. **Platform order after Meta:** LinkedIn or TikTok?
