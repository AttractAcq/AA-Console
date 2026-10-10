# Migration history repair — 8 October 2026

What this records: production's `supabase_migrations.schema_migrations` had
diverged from the repo badly enough that `supabase db push` could not run, and
the repair that fixed it. Written down because the state it describes took
four queries to establish and would take four more to re-establish.

## How it got that way

From 16 September, migrations reached production through the Supabase MCP or
the dashboard rather than `supabase db push`. Both stamp the history row with
the **time of application**, not the version in the filename. So the same
piece of work ended up recorded under a version string that no local file
has.

The result, before the repair:

- **62 local files showed as pending** while their objects plainly existed —
  `scheduled_posts.platform`, `distribution_due`, `client_media_frames` and
  the rest.
- **65 remote versions had no local file.** All 65 were applied by
  `alex@attractacq.com`.
- **17 local files were genuinely unapplied** — 150–155 and 157–167.

A plain `db push` would have tried to apply roughly eighty files, most of them
already applied in substance, and aborted at the first non-idempotent
statement: `147_content_slots` opens with `create type slot_stage as enum`,
which fails "type already exists" and takes its transaction with it.

## The repair, in order

1. **`migration repair --linked --status applied`** on the 62 local versions
   whose objects existed. The rule that made this mechanical rather than a
   guess: every migration numbered **≤149, plus 156**, was already applied;
   150–155 and 157–167 were not. Verified object by object before running it.
2. **`migration repair --linked --status reverted`** on the 65 remote-only
   versions. `db push` requires the remote history to contain nothing absent
   from the local directory, so these had to go. This touches only the history
   table — no schema, no data.
3. **`db push --linked`**, which then applied exactly the 17.

## Why step 2 lost nothing

63 of the 65 carry a migration number matching a local file, so they were
duplicate records of work now recorded under the correct version. The two
that did not were checked individually:

| Remote version | Name | Reproduced in the repo by |
|---|---|---|
| `20260922163439` | `delete_client_campaign_and_idea` | `20260921120000_109_delete_campaign_and_idea.sql` — defines `delete_client_idea` and `delete_client_campaign` |
| `20260924114357` | `fix_assign_production_ai_render_columns` | superseded by `20261002090100_139_assign_production_columns_and_category.sql`, the latest of six local files defining `mcp_internal.assign_production` |

Both were hand-applied fixes later committed as files. Nothing in the 65 is
the sole record of a schema change.

## Two filename faults fixed on the way

- **`20260921120000` was used twice** — by `109_delete_campaign_and_idea` and
  `120_archive_excludes_recruitment`. Version is the primary key of the
  history table, so only one of the two could ever be recorded: a push would
  mark the version done and skip the other forever. `120` moved to
  `20260921123000`.
- **`20261006240000` is not a time.** Hour 24 does not exist, and the CLI
  listed it with a raw string where every other row shows a parsed date. `160`
  moved to `20261006235000`, keeping its position between 159 and 161.

Two older files share that invalid hour — `69` at `20260908240000` and `107`
at `20260920240000`. Left alone: both are applied, both sort correctly where
it matters, and renaming historical migrations to fix a cosmetic parse has no
upside.

## How to not need this again

Apply production migrations with `supabase db push`, from the repo. Every
dashboard or MCP apply puts one more row in the history that no local file
can match, and the cost is not visible until the next person tries to push.

If a hand-apply is genuinely necessary, follow it with
`supabase migration repair --linked --status applied <the local version>` so
the two records agree.
