# Migration reconciliation — 2 October 2026

Working record for P0.3. Every line was checked against the live databases or
the git tree today; the check is stated so it can be re-run.

**Headline: there are three different schemas — production, staging and git —
and no two of them agree. There is currently no trustworthy environment to
rehearse a production apply against.** That has to be fixed before migrations
126–131 and 133 go anywhere.

---

## 1. The three-way divergence

| | Production | Staging | Git (`origin/main`) |
|---|---|---|---|
| Recorded migrations | **140** | **137** | **144 files** |
| `95_video_dual_briefs` | applied | **never applied** | present |
| `89_delete_recruitment_ad` | applied | **never applied** | present |
| `90_recruitment_page_type` | applied | **never applied** | present |
| `91_page_reference_asset` | applied | **never applied** | present |
| `106_remake_rejected_asset_fix` | **not applied** | applied | **in no branch** |
| `127_fix_team_category_text_compare` | applied | not applied | **in no branch** |
| `fix_assign_production_ai_render_columns` | applied | not applied | only on PR #108 |
| `104_campaign_pillars` | 1 row | **split into 2 rows** | 1 file |
| `72_campaign_execution` | **recorded twice** | 2 distinct names | 2 files |
| `126`–`131`, `133` | not applied | not applied | present |

Checked by `select name from supabase_migrations.schema_migrations` on both
projects, diffed, then each difference confirmed against a schema object rather
than trusted from the name.

Staging's missing 95 is not cosmetic. `client_briefs.avatar_brief` does not
exist there, and `dispatch_brief_to_members` is still the four-argument
migration-40 version with no `p_brief_role`. So the September audit's
"staging matches production count for count" is no longer true in either
direction.

### Two hotfixes exist only in a database

Neither is in any branch. Both were applied straight to an environment and
never committed, so a replay of git silently loses them:

- **`127_fix_team_category_text_compare`** (production only) — captured by new
  migration 138, below.
- **`106_remake_rejected_asset_fix`** (staging only) — **not yet captured.**
  Its content is unknown from git and must be read out of staging before
  staging is rebuilt, or it is lost.

---

## 2. What is genuinely unapplied

Probed object by object, because the history table's names and versions can no
longer be trusted.

| Migration | Applied in prod? | Evidence |
|---|---|---|
| 126 `manual_campaign_ideas` | **No** | `client_ideas_campaign_position_pair` still reads `campaign_position BETWEEN 1 AND 30` |
| 127 `retired_team_access` | **No** | `sync_team_member_profile_name` absent; no `tm.active` in the four access functions |
| 128 `lead_stage_enum` | **No** | `profile_visit`, `follower`, `qualified` absent from the enum |
| 129 `lead_pipeline_archive` | **No** | `archived_leads`, `lead_identities` absent |
| 130 `lead_reporting_bot_stages` | **No** | `acquisition_funnel` body references none of the new stages |
| 131 `bot_lead_stages` | **No** | `mcp_internal.update_lead_stage` allow-list has none of the new stages |
| 132 `campaign_plan_without_ideas` | **Yes** | `ideate_on_plan` present; `save_campaign_plan_only(uuid,uuid,uuid,jsonb)` signature matches exactly. Applied in production as two rows, `128_client_campaigns_ideate_on_plan` and `132_save_campaign_plan_only_repair` |
| 133 `recruitment_meta_distribution` | **No** | tables, `request_recruitment_meta_build` and the `recruitment_meta_build` agent row all absent |

So **seven of the eight are unapplied**, not six. 130 and 131 were ambiguous in
yesterday's audit and are now settled: both unapplied. Earlier evidence that
`lead_stage_rank` and `client_economics_by_channel` exist was a false positive —
migrations 79 and 85 also define them.

### Apply order

128 is an `ALTER TYPE ... ADD VALUE` and must commit before anything that uses
the new values; 129, 130 and 131 all do. The existing numbering already
respects that, so the order is simply:

```
126 → 127 → 128 (alone, must commit) → 129 → 130 → 131 → 133 → 138 → 139
```

---

## 3. Two faults found while reconciling

### 3.1 Retired team members keep access — latent

Migration 127 adds `tm.active` to `accessible_client_ids`,
`can_access_client`, `is_member` and `current_member_id`, and tightens two
`team_members` policies. Production's copies ignore `active` entirely.

The deployed console's retire button confirms:

> *"Retire {name}? They will leave the active roster and lose team access."*

It sets `active = false` and they keep access to every client they were
assigned to, through both `client_assignments` and `job_assignments`.

**Not exploited.** 3 team members, all active, 0 retired — so nothing has
leaked. It is a trap armed and waiting: the first retirement fails silently.
Checked by `select count(*) from team_members where not active` and by reading
the four live function definitions.

### 3.2 `team_category` compared against `text` — live

Migration 95 declared `v_need_cat text` and then compared it against
`team_members.category`, a `team_category` enum. Postgres has no such
operator. Proved on staging rather than assumed:

```sql
select 'editors'::team_category is distinct from 'editors'::text;
-- ERROR 42883: operator does not exist: team_category = text
```

Two functions carry the fault. Only one was ever fixed:

| Function | Production state | Consequence |
|---|---|---|
| `public.dispatch_brief_to_members` | **Fixed**, by the untracked hotfix | Works — but git still holds the broken version, so any replay reintroduces it |
| `mcp_internal.assign_production` | **Still broken.** `v_need_cat text`, zero `::team_category` casts | `content.assign_production` route=human has never worked for an avatar or editor role. The `full` role escapes it because `v_need_cat` stays null and the guard short-circuits |

This is why PR #108 must not merge as written: it reproduces the broken
declaration verbatim.

---

## 4. What this branch adds

| File | Purpose |
|---|---|
| `20261002090000_138_dispatch_brief_team_category.sql` | Captures the untracked production hotfix so a replay cannot reintroduce the broken comparison. `CREATE OR REPLACE`, so it is a no-op against production and a repair everywhere else |
| `20261002090100_139_assign_production_columns_and_category.sql` | PR #108's AI-route column-list lock **plus** the enum fix it was missing. Supersedes #108; close that PR in favour of this |

Neither has been applied anywhere. They are unverified until there is an
environment worth verifying against — see section 5.

### A correction to yesterday's audit

PR #108's "migration number collision at 126" is **cosmetic, not functional.**
Supabase orders by the filename timestamp, not the number, and #108's
`20260924120000` sits correctly between 125 and 126. The numbers are already
decorative: git has five duplicated numbers (72 ×3, 89, 90, 91, 109 ×2) and
five places where the number sequence runs backwards against the timestamps.
Renumbering #108's content to 139 is worth doing for legibility and because the
enum fix changes it anyway — not because it would have misapplied.

---

## 5. The blocker, and the decision it needs

The plan was to rehearse the production apply on staging. **That is not
currently safe:** staging is missing migration 95 and three others, so an
apply there proves nothing about production, and migration 138 would create a
second overload of `dispatch_brief_to_members` beside the stale four-argument
one rather than replacing it.

Nor can git simply be replayed onto a fresh database to produce production:
git is missing both untracked hotfixes, and the `106` one is still only
recoverable from staging.

Three options, in the order I would take them:

**A. Rebuild staging from git, then forward-apply.** Read
`106_remake_rejected_asset_fix` out of staging and commit it first — it is the
only copy. Then reset staging and replay the full history from git, which also
proves the fresh-replay path and would have caught the 95 fault on its own.
Then apply 126–131, 133, 138, 139 on top and compare against production object
by object. Slowest, and the only one that leaves all three in agreement.

**B. A throwaway Supabase branch as the replay target.** Leaves staging alone;
costs money and needs a cost confirmation. Still needs the `106` hotfix
recovered first.

**C. Apply straight to production with no rehearsal.** Fastest, and I do not
recommend it for seven migrations that include RLS helper functions, an enum
addition and foreign-key swaps on `sales_agent_conversations` and
`mcp_internal.mcp_pipeline_requests`.

Recovering the `106` hotfix out of staging is required by all three and is the
next step regardless.

### Gates

Per `AGENTS.md`, the production apply is Alex's via Chief of Staff. Rebuilding
staging is not a production action, but it destroys the only copy of one
untracked hotfix, so it should not happen before that hotfix is committed.
