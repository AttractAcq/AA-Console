# Completion plan — 1 October 2026

What is built, what is built-but-never-run, what is broken in production right
now, and the order to close it in. Every claim below was checked against the
running system or the code today, and the check is stated so it can be re-run
rather than trusted.

Read alongside `gap-audit.md` (7 September), which this supersedes where the
two disagree. The September audit is accurate for its date and stale in three
places: agent spend, the `SECURITY DEFINER` count, and "schema in git".

---

## 0. First thing to know: this checkout is not the repo

| | Commit | Note |
|---|---|---|
| This working tree | `d4bc7c2` | **5 commits behind** |
| `origin/main` | `1839cf8` | The real head |
| Deployed runtime | `1839cf89cca4` | Matches `origin/main`, 2 workers, healthy |
| Deployed console | 200 at `console.attractacq.com` | CI and Deploy green on `1839cf8` |

All three builds live at or past `origin/main`, so anything read from this
checkout is missing PRs #114–#118 — the whole of Build A. Fast-forward before
doing any work.

There is also a stale worktree at `/Users/alex/Projects/aa-console-delete-entities`
sitting on `eng/console-delete-entities`, a branch merged as #94.

---

## 1. The three builds

### Build A — Higgsfield content production (reels)

**Merged and deployed. Never run once.**

Five PRs (#114–#118) landed between 30 September and 1 October:

| Piece | Where | State |
|---|---|---|
| Shot plan on a brief | `agents/brief/shots.ts` | Built. F6 (mechanism explainer) and F7 (problem cold-open), generated-only |
| Approve & Build → reel route | `ApproveAndBuildModal.tsx` → `build_brief_with_ai` | Built. Queues `video_build` + opening stills on `creative_build` |
| Opening stills | `creative_build/openingStills.ts` | Built. An OpenAI image build, one `client_media_frames` row per shot |
| Motion gate | `video_build/motion.ts` | Built. Pauses before any request if the Higgsfield env is incomplete |
| Higgsfield DoP client | `video_build/higgsfield.ts` | Built. `submitI2V`, `pollStatus`, `listMotions`, retry classification |
| Clip persistence | `video_build/clip.ts` | Built. Copies a finished clip into `client-media`, sets `clip_path` |
| Motion catalog | `video_build/motions.ts` | **One hardcoded id.** Zoom In, `fbcbec5b-30f8-4b17-ba6e-8e8d5b265562` |
| **Assembly** | `video_build/assembly.ts` | **Stub.** `{ via: "brief_dispatch", status: "not_started" }` |
| Shot review UI | `ReelShotsPanel`, `ReelShotGrid`, nav leaf `reel-shots` | Built |
| Schema | migrations 134–137 | Applied in production |
| Agent row + runner | `video_build` | Both present |

Counted on production today:

| | Count |
|---|---|
| Reel briefs (`content_format = 'reel'`) | **0** |
| F6/F7 briefs | **0** |
| Reel shot rows (`shot_source_kind` set) | **0** |
| Shots submitted to Higgsfield (`provider_job_id`) | **0** |
| Clips on file (`clip_path`) | **0** |
| `video_build` jobs, ever | **0** |
| Stills on file (carousel and story frames) | 103 |

Three things block the first run, in the order they bite:

1. **OpenAI credits are exhausted.** The last nine `creative_build` jobs, on
   25 September, all failed with *"You have no credits remaining."* Opening
   stills are an OpenAI image build, so step one of Build A fails today before
   Higgsfield is reached at all. Each failure burned 3 attempts.
2. **The four `HIGGSFIELD_*` variables are set nowhere** — not in
   `agent-runtime/.env`, and not even listed in `.env.example`. `decideMotion`
   therefore pauses every run before a request is sent. (Railway's variables
   could not be read from here; assume unset until checked.)
3. **The catalog has one confirmed id.** `listMotions` exists but `video_build`
   never calls it, and no catalog dump is checked in. Any motion other than
   Zoom In or `pending` stays unresolved and pauses rather than being invented.

And even with clips, there is no reel: assembly is a stub that hands off to a
human editor by email.

### Build B — AI video editing

**A spike on an unmerged draft PR. No model has ever been called.**

PR #120, branch `claude/ai-video-edits-h77eow`, four commits on top of
`origin/main`. 12 files, ~2,023 lines, all under
`agent-runtime/src/agents/video_edit/`, plus `docs/ai-video-edit.md`.

| Module | What it does |
|---|---|
| `edl.ts` | Edit-decision-list types, strict tool schema, `parseEdl`, `validateEdl` (clip bounds, flash frames, length, captions, read time, brand-banned phrases, figures absent from the brief, crossfades over proof footage) |
| `render.ts` | EDL → ffmpeg argv. Nothing executed. 1080×1920 at 30fps, cuts or crossfades, captions via `textfile=` so text never enters the filtergraph |
| `media.ts` | ffprobe/ffmpeg through `execFile`, no shell |
| `plan.ts` | One Claude call, structured output, model is a parameter |
| `handoff.ts` | The join to `video_build`; readiness gate — a reel is edited whole or not yet |
| `spike.ts` | Local CLI; `--edl` renders with no API spend, `--model` plans and prints cost |

What is proved: a local render of three synthetic clips (10.6s, 1080×1920,
H.264+AAC, ~5s wall time) and a full-chain test from a stored shot plan through
parsing, readiness, validation and an ffmpeg render. 44 tests, CI green.

What is not: **no model call, no real clip to cut, no agent registration, no
migration, no ffmpeg in the Dockerfile, and the worker never imports it.** The
three ffmpeg tests skip where ffmpeg is absent, so they probably never execute
in CI.

The architectural point in the doc is worth keeping: the model decides, ffmpeg
renders. GPT-6 Astra's route needs a desktop session per edit and does not fit
a headless Railway worker.

**Build B is not a separate build. It is Build A's step 5.** Sequencing them as
parallel tracks is the error the doc itself corrects: the editor is the last
link of a chain whose earlier links have never carried anything.

### Build C — cron and automatic AI runs

**One cron job exists. It has produced zero work since the day it was created.**

What is built:

| Piece | State |
|---|---|
| `pg_cron` extension | Installed |
| `metrics-ingest-daily` | Active, `15 3 * * *`, calls `enqueue_metrics_ingest_jobs(7)` |
| `metrics_ingest` agent + runner | Both present |
| Master run (`start_master_run`) | Built. `requires_input` excludes the three agents that need a chosen row; 11 agents queued |
| Worker claim/lease loop | Built. Per-job deadline, lease-renewal cap, claim filtered to implemented runners |

What is missing:

- `client_integrations` holds **0 rows** and `metrics_daily` **0 rows**, so the
  nightly cron has fired for roughly 26 days and inserted nothing.
  `metrics_ingest` has **0 jobs, ever**. The one automatic workflow in the
  system has never produced a single job.
- `reporting`: 1 job ever, failed — *"No metrics have been ingested for this
  client in this period."*
- `meta_build`: 2 jobs, both failed — one *"This client has no Meta
  integration."*
- **There is no other cron.** No publishing tick, no engine tick, no token
  health check, no planner.
- **Publishing does not exist.** `record_publication` marks a row; the 2 posts
  reading `published` were recorded by hand.
- The engine that would make runs automatic — slots, planner, policy
  approvals, copywriter, QA, approval inbox, publisher — is a **proposal**:
  `docs/content-engine-build-plan.md` on `claude/content-engine-build-plan`,
  PR #119, draft, explicitly "not yet cleared", needing a Sec review for the
  publish milestone and an Alex CLEAR before work starts.

So Build C is roughly 10% built: the queue, the lease protocol, the deadline
and one dormant cron. The automatic part does not exist yet.

---

## 2. The thing that needs fixing before anything else

**Production schema and the repo have diverged, and two deployed panels are
broken because of it.**

Checked object by object against production rather than by migration name:

| Repo migration | In production? | How that was checked |
|---|---|---|
| 126 `manual_campaign_ideas` | **No** | `client_ideas_campaign_position_pair` still reads `campaign_position BETWEEN 1 AND 30` |
| 127 `retired_team_access` | **No** | `sync_team_member_profile_name` does not exist |
| 128 `lead_stage_enum` | **No** | `profile_visit`, `follower`, `qualified` are absent from the `lead_stage` enum |
| 129 `lead_pipeline_archive` | **No** | `archived_leads` and `lead_identities` do not exist |
| 130 `lead_reporting_bot_stages` | Ambiguous | `client_economics_by_channel` exists, but migrations 79 and 85 also define it |
| 131 `bot_lead_stages` | Unverified | `mcp_internal.update_lead_stage` not probed |
| 132 `campaign_plan_without_ideas` | **Yes**, via a production hotfix | `ideate_on_plan` and `save_campaign_plan_only` are present |
| 133 `recruitment_meta_distribution` | **No** | `recruitment_meta_campaigns` and `request_recruitment_meta_build` do not exist; no `recruitment_meta_build` agent row |

And production carries two migrations with no counterpart on `main`:

- `fix_assign_production_ai_render_columns` — lives **only on open PR #108**,
  where it is numbered `126`, colliding with the repo's own 126.
- `127_fix_team_category_text_compare` — **exists in no branch at all.** An
  untracked production schema change.

Separately, migration filenames no longer match the versions production
recorded, because migrations are being applied through the Supabase MCP
`apply_migration` rather than `supabase db push`. The repo's
`20261001120000_136` is production's `20261001071233`. `supabase migration list`
can never agree again, so a replay onto staging is now the only way to prove
the schema.

### What that breaks, live, today

| Symptom | Cause |
|---|---|
| Prospects & Leads archive fails for every operator | `ProspectsLeadsPanel.tsx:64` selects from `archived_leads`, which does not exist |
| Recruitment Distribution is non-functional | `RecruitmentDistributionPanel.tsx:64,108,121` read `recruitment_meta_campaigns` and call `create_recruitment_meta_campaign` / `request_recruitment_meta_build`, none of which exist |
| A manual idea past position 30 is rejected | The old `CHECK` that migration 126 was written to remove |
| `src/types/database.ts` is partly fiction | It types `archived_leads`, `lead_identities`, `recruitment_meta_campaigns` and two RPCs that production does not have |

PRs #112 and #113 were merged and their frontends deployed; their migrations
were never applied. The September audit's "54 migrations, replaying onto a
fresh database, staging matches production count for count" is no longer true.

---

## 3. Everything else, in one place

### Providers and spend

| | State |
|---|---|
| OpenAI | **Exhausted** as of 25 September. Blocks every image, carousel, story and reel-still build |
| Anthropic | Hit *"credit balance too low"* on 19 September (11 `campaign_plan` failures); later topped up — a `brief` job completed 1 October |
| Agent spend to date | **$81.99** (was $5.26 on 7 September). $54.64 in the last 14 days |
| Job outcomes, all time | 267 completed, 47 failed, 22 cancelled |

A credits failure is currently retried three times. It should be classified
non-retryable on sight.

### Environment variables

| Variable | Read by | Documented? | Set? |
|---|---|---|---|
| `HIGGSFIELD_API_KEY` / `_API_SECRET` / `_MODEL_DRAFT` / `_MODEL_FINAL` | `video_build/motion.ts` | **No** — absent from `.env.example` | **No**, locally. Railway unchecked |
| `AA_MCP_SERVICE_SECRET` | `mcp/` routes; absent means every MCP request is denied | Yes | Not in local `.env` |
| `ANTHROPIC_API_KEY_<AGENT>` | `config.ts`, 11 agent suffixes | Partly | Only `_COMPETITOR` appears in code |
| `RESEND_API_KEY` | `brief_dispatch` | Yes | Set locally; the September audit says not on Railway |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_*` | required | Yes | Set |

No email has ever been sent (`email_status = 'sent'` is 0 rows). That is
deliberate — the first send reaches a real inbox and needs a verified Resend
domain plus an explicit decision.

### Tests

| Suite | Count | State |
|---|---|---|
| Frontend | 760 in 68 files | Green in CI. **5 fail on this machine** |
| Agent runtime | 1,315 (1,305 pass, 10 skipped) in 85 files | Green in CI. 1 file fails on this machine |
| `video_edit` spike | 44 | Green, but its 3 ffmpeg tests skip where ffmpeg is absent |
| MCP gateway | in CI | Not run here |

The local failures are not code defects. CI pins Node 22; this machine runs
**Node 25.9.0**, where Node's own native `localStorage` shadows jsdom's and has
no `.clear()` — which is exactly the five `AdCopyModal` failures
(`localStorage.clear is not a function`, `AdCopyModal.test.tsx:22`). The
runtime failure is a PGlite `beforeAll` timing out at 10s locally.
`agent-runtime/` pins Node 22 with `.nvmrc` and `.node-version`; **the
repository root pins nothing.**

### Security

| Finding | State |
|---|---|
| Leaked-password protection | **Still off.** Open since the 7 September audit. A dashboard toggle |
| `SECURITY DEFINER` callable by `authenticated` | **52** — double the 26 reviewed in September. Each is an intended RPC carrying its own guard, but nothing enforces that a new one does |
| RLS enabled with no policy | 20 tables — 18 in `mcp_internal`, plus `public.mcp_bot_clients` and `public.mcp_brief_requests`. Deny-all, probably intended; assert it deliberately |
| Mutable `search_path` | `mcp_internal.clip_text`, `public.lead_stage_rank` |
| On-disk credential residue | `.cutover-backups/` (252K, gitignored) holds `BOT_SALES_OPS_TOKEN_ID.txt` and two `issue_cdm_token*.py` scripts |

`SEC_BAR.md` still locks live Meta publish out to Phase 11c. The 2026-09-15
Alex CLEAR authorised code merge only — no production migration apply, no
Railway deploy, no token rotation.

### Branch and PR debt

Four open PRs:

| PR | Age | Note |
|---|---|---|
| #120 AI video edit spike | 1 Oct, draft | Build B |
| #119 Content engine build plan | 1 Oct, draft | Build C's plan, needs CLEAR |
| #108 Lock `assign_production` AI render columns | **open since 24 Sept** | Captures a production hotfix as a forward migration. Migration number collides with repo 126 |
| #107 `content.create_upload_url` | **open since 24 Sept** | Gateway/Production upload path |

Thirteen remote branches. These are merged and dead:
`cursor/phase-5-production-manager-2182` (161 behind, 0 ahead),
`cursor/video-build-phase1-fbd0`, `cursor/reel-video-build-enqueue-be4e`,
`cursor/reel-opening-stills-higgsfield-adapter-0d4c`,
`cursor/video-motion-residuals-8a29`, `cursor/fix-distribution-board-query-ba3c`,
`eng/console-delete-entities` (#94), `eng/video-dual-briefs` (#64),
`codex/module-pdf-exports` (#109), `claude/campaign-instructions-limit-rwp1a7`
(#106). The last four were squash-merged, so their "commits ahead" is an
artifact, not work.

### Still open from the September audit

- Landing and offer page reporting has no data source — needs a GA4 or
  Plausible connector behind the same `MetricsSource` interface.
- `metrics_period_summary()` computes no prior window, so the commentary agent
  can never describe a trend.
- Brand `custom_css` is stored and unused; nothing renders a page as HTML.
- No backfill UI for `enqueue_metrics_ingest_jobs(p_days)`.
- `react-router-dom` 6.30.6 carries two moderate advisories; neither is
  reachable, and the fix is a semver-major move to 7.x.
- `SectionCard` is dead code.

---

## 4. The completion plan

Six phases. P0 is not optional and nothing else should start before it. P1–P3
finish Builds A and B as one chain. P4–P5 are Build C. P6 closes the repo.

Per `AGENTS.md`: prepare code, tests and reviewable PRs; no merge, no
production migration apply and no Railway deploy without Alex via Chief of
Staff.

### P0 — Make the repo, this machine and production agree

Nothing below here is a feature. It is the reason features are not landing.

| # | Task | Done when |
|---|---|---|
| P0.1 | Fast-forward `main` to `origin/main`. Remove the stale worktree at `/Users/alex/Projects/aa-console-delete-entities`. Delete the ten dead branches listed above | `git worktree list` shows one tree; `git branch -a` shows only live work |
| P0.2 | Pin Node at the repository root — `.nvmrc`, `.node-version` and `engines` — to 22, matching CI | `npm test` passes on this machine with no `localStorage` failures |
| P0.3 | **Reconcile the migration drift.** For each of 126–133, decide apply-or-retire. Capture `127_fix_team_category_text_compare` as a forward migration in git (it exists in no branch). Land PR #108 with its number collision resolved | A single ordered migration set, replayed onto `AA-Console-Staging` from git, matches production count-for-count: tables, policies, functions, enums, agents |
| P0.4 | Apply the reconciled set to production **or** hide the two panels that call missing objects. Prospects & Leads and Recruitment Distribution are live and broken either way | Both panels work against production, or neither is reachable |
| P0.5 | Decide the migration workflow. `apply_migration` through MCP has made the history table unreconcilable with filenames. Pick one path — `supabase db push` from git, or MCP plus a recorded repair migration — and write it down | `supabase migration list` agrees, or a documented procedure says why it cannot and what replaces it |
| P0.6 | Document the four `HIGGSFIELD_*` variables in `agent-runtime/.env.example`, with the pause behaviour stated | A reader can see what motion needs without reading `motion.ts` |
| P0.7 | Top up OpenAI. Classify a credits failure as non-retryable so it fails once, not three times, and surfaces as a configuration problem rather than a provider fault | A test proves a credits error is not retried |

### P1 — Prove the chain Build A already merged (steps 1–3)

Cheapest possible test of the most code. Image credits only; no Higgsfield key
needed.

| # | Task | Done when |
|---|---|---|
| P1.1 | Brief one F6 or F7 reel on the AA house client. Press Approve & Build on the AI route | A `video_build` job exists — the first ever — and opening stills are queued on `creative_build` |
| P1.2 | Confirm stills land | `client_media_frames` has one row per shot with a `storage_path`, and `ReelShotsPanel` shows them |
| P1.3 | Fix what that exposes, as its own PR each | Green CI, and the same reel re-runs clean |
| P1.4 | Dump the Higgsfield motions catalog with `listMotions` and check the result in | More than one usable motion id exists in git, with its provenance recorded |

### P2 — Turn motion on (Build A step 4)

| # | Task | Done when |
|---|---|---|
| P2.1 | Set the four `HIGGSFIELD_*` variables on Railway. Alex's step; it is a production credential | `decideMotion` returns `ready` |
| P2.2 | Re-run the P1 reel | A `provider_job_id` on each shot, then a `clip_path` — the first real clip |
| P2.3 | Check the job deadline actually covers a Higgsfield render. Polling happens inside the job, and `AGENT_RUNTIME_MAX_JOB_SECONDS` is 1800 | A render that outlasts the deadline fails with a clear message rather than leaving a paid-for clip unclaimed |
| P2.4 | Record real cost per reel | A figure to compare the editor against |

### P3 — Assembly, which is where Build B lands (Build A step 5)

Build B stops being a separate project here. It replaces `assemblyHandoff()`.

| # | Task | Done when |
|---|---|---|
| P3.1 | Compare editing models on 3–5 real clips from P2 — Opus 5.5 against Fable 5.1 — scored on approval rate and cost. `spike.ts --model` already does this. Needs sign-off on roughly $20–40 | A chosen model and a measured cost per reel |
| P3.2 | Wire it: register a `video_edit` agent (separate from `video_build`, so retries and spend stay isolated), a migration for `edit_plan jsonb` and `render_path`, and `ffmpeg` in the runtime image — or a separate render worker if the main worker's memory is tight | A reel brief produces a publishable 1080×1920 MP4 with a cover frame |
| P3.3 | Make the ffmpeg tests run in CI rather than skip. Install ffmpeg in the CI job | 44 tests, none skipped for a missing binary |
| P3.4 | Keep the `brief_dispatch` fallback. Anything failing validation or review twice goes to a human editor with the EDL attached | A deliberately-broken EDL ends up with an editor, not in the void |
| P3.5 | Console preview of the cut next to the shot review | A reviewer can watch the reel before approving it |

### P4 — Make one automatic workflow actually work (Build C foundation)

One step here un-inerts more of the system than anything else in this document.

| # | Task | Done when |
|---|---|---|
| P4.1 | Connect Meta for one client — the internal AA account first. Account → Integrations → Add, one row per surface (`meta` with `act_<id>`, `instagram` with the IG user id), then Daily sync on | `client_integrations` has rows |
| P4.2 | Let the 03:15 cron run once unaided | `metrics_ingest` has its first job ever, and `metrics_daily` has rows. This closes the largest gap in the September audit |
| P4.3 | Re-run `reporting` and `meta_build`, which have only ever failed for want of this | Both complete |
| P4.4 | Add the prior-window block to `metrics_period_summary()` | The commentary agent can say "up" or "down" |
| P4.5 | Enforce a monthly spend cap per client in `dispatchJob` — refuse before any provider call, as a classified non-retryable failure, not an agent pause | A test shows a capped client's job refused before a provider is touched. Given $54.64 in 14 days with nothing running automatically, this comes before the engine, not after it |
| P4.6 | Resend: verified sending domain and `RESEND_API_KEY` on Railway. The first real send is an explicit decision | One notification reaches an internal address |
| P4.7 | A daily token-health cron (`debug_token`), setting `expiring`/`error` and notifying | An expiring token is visible before it stops posting |

### P5 — The engine (Build C proper)

`docs/content-engine-build-plan.md` is a good plan and should be the basis.
Two changes to it:

- **Its M0.3 spend cap and M0.4 notifications move to P4 above.** They are
  prerequisites for running anything automatically, not engine features.
- **Its M5 video milestone is already P1–P3.** Delete it from the engine plan
  so the same work is not tracked twice.

| # | Task | Gate |
|---|---|---|
| P5.1 | Get PR #119 CLEARed, or supersede it with a plan amended as above | Alex via Chief of Staff |
| P5.2 | M0 foundations — post time and timezone, per-platform `post_copy` | Normal review |
| P5.3 | M1 Meta sign-in flow and token storage in Vault | Normal review. Meta Business verification and app review have a 2–6 week lead time: **start the external track now, in parallel with P0** |
| P5.4 | M3 the engine — `client_engine_settings` (off by default), `content_slots` and a state machine with `advance_slot` as the only writer, a deterministic planner, an hourly `engine_tick`, slot-driven ideation, auto-select, policy approvals that never touch `human_approved_at` | Normal review. Provable end-to-end on staging up to `awaiting_approval` with no publishing cleared |
| P5.5 | M3.8–M3.9 copywriter and QA agents, with automatic regenerate below threshold | Normal review |
| P5.6 | M4 approval inbox — the one human commit — plus reject-means-regenerate and reminders | Normal review |
| P5.7 | M2 publisher: adapter interface, Facebook Page and Instagram adapters, `publish` agent, `enqueue_due_publications()` with row locking, a 5-minute cron, and three kill switches | **Sec APPROVE on a Phase 11c live-publish note, then Alex. `PUBLISH_ENABLED` defaults false** |
| P5.8 | M4.4–M4.5 per-post insights and the learning loop | Normal review |

The critical path runs through Meta app review to the first live publish.
Everything in P5.4–P5.6 can be built and proved on staging before that clears.

### P6 — Close out the repo

| # | Task | Done when |
|---|---|---|
| P6.1 | Resolve PR #107 (`content.create_upload_url`) — merge or close. Open since 24 September | No PR older than a week is open |
| P6.2 | Turn leaked-password protection on in Supabase Auth. Five minutes, and open since 7 September | The security advisor stops listing it |
| P6.3 | Review the 52 `SECURITY DEFINER` functions as a set, and add a test that a new one must carry a guard. The advisor cannot tell a guarded RPC from an unguarded one, so the guard needs its own check | A function added without `is_admin()`, `can_access_client()` or an actor check fails a test |
| P6.4 | Set `search_path` on `mcp_internal.clip_text` and `public.lead_stage_rank` | Two fewer warnings |
| P6.5 | Assert the 20 RLS-enabled-no-policy tables are deliberate, in a comment and a test | A reader knows deny-all is the intent |
| P6.6 | Move `react-router-dom` to 7.x as its own migration | Both advisories cleared |
| P6.7 | Delete `SectionCard`. Clear the credential-adjacent files out of `.cutover-backups/` | Dead code and stray token scripts gone |
| P6.8 | Add a GA4 or Plausible connector behind `MetricsSource`, so landing and offer reporting has a source | Those two tabs show data |
| P6.9 | Rewrite `gap-audit.md` from the current system, or mark it superseded and point at this document | One current reference, not two |

---

## 5. Sequence

```
Weeks:        1    2    3    4    5    6    7    8    9   10   11   12
P0 agree      ████
P1 chain        ██
P2 motion        ███
P3 assembly        ███████
P4 automatic   ██████
P5 engine           ████████████████████████████████
P5 Meta ext   ░░░░░░░░░░░░░░░░░░░░  verification + app review
P6 close out                                      ████████████
```

P0 gates everything. P1 and P4 can run in the same week — one needs OpenAI
credits, the other needs a Meta connection, and neither touches the other.
Start the Meta external track in week 1 regardless, because it is the only
item on the list that cannot be hurried later.

## 6. What could not be checked from here

- **Railway's variables.** Whether `RESEND_API_KEY` or any `HIGGSFIELD_*` is
  set in production is unknown; the September audit says Resend was not.
- **OpenAI's current balance.** Only that a job failed for want of credits on
  25 September, and nothing has tried since.
- **Migrations 130 and 131.** Their objects exist but earlier migrations also
  define them, so application status is genuinely ambiguous. The staging
  replay in P0.3 settles it.
- **Whether the MCP gateway is deployed and running.** It is in CI and has
  sixteen phase documents; its runtime state was not probed.

## 7. How to re-run the checks in this document

- **Repo vs deployed:** `git rev-parse origin/main` against
  `select version from agent_runtime_heartbeats order by reported_at desc limit 1`.
- **Migration drift:** probe objects, not names — the history table's versions
  no longer match filenames. For each migration, pick the one table, column,
  constraint or function it alone creates and ask production for it.
- **Reel chain progress:** `select count(*) filter (where clip_path is not null),
  count(*) filter (where provider_job_id is not null),
  count(*) filter (where shot_source_kind is not null), count(*)
  from client_media_frames`.
- **Whether any automatic work has happened:**
  `select count(*) from agent_jobs where agent_key = 'metrics_ingest'`. Zero
  means the cron is still inert, whatever `cron.job.active` says.
- **Cron inventory:** `select jobname, schedule, active from cron.job`.
- **Local vs CI:** `node -v` against `node-version` in
  `.github/workflows/ci.yml`. A mismatch is the first thing to suspect when a
  suite fails locally and passes in CI.
- **Agents without runners:** the `agents` table against `RUNNERS` in
  `agent-runtime/src/orchestration/dispatch.ts`. `recruitment_meta_build` has a
  runner and no row, which is the safe direction; the reverse strands jobs.
- **Spend:** `select round(sum(cost_usd)::numeric, 2) from agent_jobs`.
