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
| `106_remake_rejected_asset_fix` | not applied | applied | in no branch — but moot, see 1.1 |
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

### 1.1 Hotfixes that exist only in a database

Two migrations were applied straight to an environment and never committed.
Neither is the hazard it first looked like, because **Supabase stores the SQL
it ran**: `supabase_migrations.schema_migrations.statements` holds the full text
of both, so nothing is unrecoverable and no rebuild can lose them.

- **`127_fix_team_category_text_compare`** (production only) — recovered and
  read. It is more interesting than its name: see 3.2. Captured by new
  migration 138.
- **`106_remake_rejected_asset_fix`** (staging only) — recovered and read, then
  **found to be moot.** It patched `remake_rejected_asset`, which migration 108
  then dropped outright in favour of `regenerate_asset`:

  ```sql
  drop function if exists remake_rejected_asset(uuid, text, text);
  ```

  The function exists in neither database today (0 rows in `pg_proc` on both),
  and the repo's own 106 already carries the corrected body. It is a dead
  intermediate, not a divergence. **Nothing needs recovering before staging can
  be rebuilt.**

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

#### The hotfix tried to fix both, and silently fixed one

Reading the stored SQL of `127_fix_team_category_text_compare` shows it was
aimed at **both** functions — two `DO` blocks, one per function. It worked on
`dispatch_brief_to_members` and did not take on `assign_production`, and
nothing checked.

The mechanism is why. Rather than restating the function, each block read the
live definition and string-replaced inside it:

```sql
def := pg_get_functiondef(reg);
def := replace(def, 'v_need_cat text;', 'v_need_cat team_category;');
def := replace(def, $s$...case v_role
      when 'avatar' then 'avatars'$s$, $s$...::team_category$s$);
EXECUTE def;
```

`replace()` that matches nothing is not an error — it returns the input
unchanged. So a pattern that misses by one space, or by an indentation level,
produces a migration that succeeds, records itself as applied, and changes
nothing. The first block hedged against exactly this by trying both the
one-space and two-space spellings of the declaration; the second block tried
only one. Whatever the precise miss, the shape of the technique is the fault:
it cannot fail loudly.

It also picked its target with `SELECT ... LIMIT 1` and no `ORDER BY`. There
is only one overload today, so that did not bite — but it is the same class of
silence.

**Trap worth keeping:** do not patch a function by string-replacing
`pg_get_functiondef` output. State the whole body, so a mismatch is a syntax
error rather than a no-op. Both new migrations here restate the body in full,
and both end in a verification query rather than an assumption.

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
currently safe:** staging never received migration 95 (or 89, 90, 91), so an
apply there proves nothing about production. Migration 138 would also create a
second five-argument overload of `dispatch_brief_to_members` beside staging's
stale four-argument one, rather than replacing it.

Nor can git be replayed onto an empty database to reproduce production: git is
missing the production hotfix, which migration 138 now supplies but which has
never been executed anywhere in that form.

What has changed since I started: **nothing is unrecoverable.** Both
uncommitted hotfixes were read out of
`supabase_migrations.schema_migrations.statements`, and the staging-only one
turned out to be moot. So staging can be rebuilt without losing anything, and
that is the recommendation.

**A. Rebuild staging from git, then forward-apply.** Reset staging and replay
the full history from git. This proves the fresh-replay path, which would have
caught the migration 95 fault on its own, and gives a genuine rehearsal
surface. Then apply 126–131, 133, 138, 139 on top and compare against
production object by object. Expect the replay itself to surface problems —
five duplicated migration numbers, migration 11's plaintext passwords (trap 2
in `gap-audit.md`), and the `rls_auto_enable()` event trigger. Those are worth
finding on staging.

**B. A throwaway Supabase branch as the replay target.** Leaves staging alone,
costs money, needs a cost confirmation. Same work, narrower blast radius.

**C. Apply straight to production with no rehearsal.** Not recommended: seven
migrations including four RLS helper functions, an `ALTER TYPE ADD VALUE`, and
foreign-key swaps on `sales_agent_conversations` and
`mcp_internal.mcp_pipeline_requests`.

### What I need from Alex

1. **Go-ahead on A or B** — which replay target. A destroys nothing of value
   now that the hotfixes are recovered.
2. **The production apply itself**, once a rehearsal has passed. That is the
   `AGENTS.md` gate, via Chief of Staff.

Independent of either, two things can proceed now: Codex guarding the two
broken panels and the retire button, and tests for both new migrations.

### Gates

Per `AGENTS.md`, the production apply is Alex's via Chief of Staff. Rebuilding
staging is not a production action and no longer destroys any unique artefact.

---

## 6. Rehearsal progress — 2 October

### 6.1 A landmine found on the way

`supabase/.temp/project-ref` reads **`bancbdztffokwiifzoiv`** — production. Any
`supabase db reset --linked` or `supabase db push` run in this repo aims at
production by default, not staging.

It is partly defused by accident: the CLI's logged-in account has no access to
the `xtrbqjmxehvggtgddrtf` organisation at all — `supabase projects list` does
not show AA-Console or AA-Console-Staging, and `supabase link
--project-ref <staging>` fails with *"Your account does not have the necessary
privileges"*. So platform API calls fail rather than doing damage.

That is not a safeguard worth relying on. `db reset` builds a direct database
connection from the project ref and a password; it does not go through the
platform API. If a database password is ever supplied in this working copy, the
stale ref points it at production.

**Two things to fix:** re-link deliberately to staging, and log the CLI into
the account that owns the org — currently nobody can drive either project from
the CLI, which is also why the rebuild had to go through the MCP instead.

### 6.2 Staging is now production-shaped

Rebuilding from git was not possible without CLI access, so staging was brought
**forward** to production's shape instead, through the MCP. Strictly less
destructive than a reset, free, and it preserves staging's data.

Applied to staging, in order:

| Migration | Result | Note |
|---|---|---|
| `89_delete_recruitment_ad` | applied | `client_briefs.purpose` confirmed present afterwards, so the body resolves |
| `91_page_reference_asset` | applied | `reference_asset_id` + partial index |
| `95_video_dual_briefs` | applied | Verbatim, broken function included — deliberately |
| `90_recruitment_page_type` | skipped | Already present. `client_pages.page_type` is the same `page_type` enum in both databases; only the history row was missing |
| `fix_assign_production_ai_render_columns` | skipped | Migration 139 supersedes it |

Staging went from 137 migration rows to **140, matching production**, and now
carries every object production has.

### 6.3 Why staging is now a better rehearsal surface than production

Migration 95 was applied verbatim rather than pre-fixed, so staging reproduces
both faults:

| | Production | Staging |
|---|---|---|
| `dispatch_brief_to_members` enum comparison | fixed by the hotfix | **broken** |
| `assign_production` enum comparison | **broken** | **broken** |
| `assign_production` AI column list | fixed by the hotfix | **broken** |

So on staging, migrations 138 and 139 are tested as genuine repairs of all
three. Against production, 138 and half of 139 would be no-ops and prove
nothing. The rehearsal is therefore stricter than the thing it rehearses.

### 6.4 Next

Apply to staging, in this order, then diff against production object by object:

```
126 → 127 → 128 (alone, must commit) → 129 → 130 → 131 → 133 → 138 → 139
```

Acceptance for the rehearsal:

1. All nine apply without error, 128 in its own transaction.
2. `archived_leads`, `lead_identities` and `recruitment_meta_campaigns` exist;
   `request_recruitment_meta_build` exists; the `recruitment_meta_build` agent
   row exists, taking staging to 25 agents.
3. `client_ideas_campaign_position_pair` no longer caps at 30.
4. The four client-access functions all carry `tm.active`.
5. Both `v_need_cat` declarations read `team_category`, and
   `select 'editors'::team_category is distinct from 'editors'::text` is no
   longer reachable from either function.
6. `assign_production` inserts the migration-93 column list.
7. A retired team member loses access — the test migration 127 exists for.
