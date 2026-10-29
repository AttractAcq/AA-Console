# Schema replay CI gate (B003)

The `Schema replay (clean, upgrade, catalog, types)` CI job runs the tracked
Supabase migrations against an isolated local Supabase stack. It does not use a
linked project, a production database URL, or a hosted access token. The job
requires Docker, Node 22, `psql`, and Supabase CLI 2.101.0. On GitHub Actions
these are installed by the workflow.

Before the database starts, `scripts/schema-migration-order.mjs` checks every
post-259 logical migration label in timestamp order. The next expected label
is 260. The branch containing migrations 261 and 262 fails this guard until
the reviewed `20261025235000_260_building_the_google_campaign.sql` migration
is present with its exact version and filename. The Pages
deployment workflow runs the same guard before building or publishing, because
it is triggered independently of CI. The guard also rejects duplicate
Supabase timestamps and unnumbered new migrations. Historical labels such as
`09b` remain accepted before the released baseline.

Run it locally from the repository root with a running Docker daemon:

```bash
AA_SCHEMA_EVIDENCE_DIR="$(mktemp -d)" bash scripts/schema-replay-ci.sh
```

The script prints the evidence directory. `AA_SCHEMA_PORT_BASE` defaults to
`55320`; choose another free block if those local ports are occupied. The
script creates a unique local project ID and copies only `supabase/config.toml`
and `supabase/migrations/*.sql` into a temporary directory. It never copies
`supabase/.temp`, which may hold a linked project ref. Every Supabase database
command passes `--local`. The copied project and its containers are removed at
exit; the evidence directory is retained.

CLI 2.101.0 has a [known `db reset --version` flag collision](https://github.com/supabase/cli/issues/5350): it can exit successfully while leaving every later migration applied. After the full startup replay, this harness temporarily moves post-release migrations **out of the disposable copy only**, resets that copy to the released schema, verifies its migration history, restores the pending files and applies them with `migration up --local`. The source checkout is never changed. A subsequent full reset checks the clean path again. This makes the upgrade assertion meaningful even on the pinned CLI version.

Supabase startup can print local API keys, so raw CLI output is kept only in
the temporary directory and deleted at exit. CI uploads the migration filename
trace, pass/fail stage markers, migration history, catalog fingerprints,
generated types and diffs. Catalog expressions and cron commands are hashed
before they enter the artifact; no user rows are exported. If startup or
replay fails, the job names the last migration reached and the raw error can
be reproduced locally with the disposable project.

## What fails the check

1. Fresh startup cannot apply all tracked migrations, or the resulting
   migration history differs from the files.
2. Reset to the last released version cannot replay, applying the remaining
   migrations fails, or the final history differs from the files.
3. A second full reset fails, or the clean and upgraded catalogs differ in
   relations, columns, constraints, indexes, functions and grants, RLS policies, views,
   enums, triggers, schema/default privileges, extensions, or cron jobs. The
   fingerprint covers `public`, `mcp_internal`, `storage`, `auth`, `vault`,
   `graphql_public`, and `cron`; it includes forced RLS and column privileges.
   Function, view, policy, constraint and cron SQL is hashed in the artifact.
4. The assertions in
   `supabase/verification/schema-replay-contract.sql` fail: key relations,
   RLS (including bot and storage tables), internal schema access, functions,
   service-only grants, a tenant key, enums and scheduled jobs
   must exist, and no local seeded user may have migration 11's known fallback
   password.
5. `supabase gen types --local --schema public,graphql_public` differs from
   `src/types/database.ts`. The diff and generated file are uploaded with the
   CI evidence; update the committed type file only after reviewing the schema
   change.

`supabase/verification/released-migration-version.txt` is the lower bound of
the upgrade test. It currently names migration 259, the last version confirmed
as applied to production when this gate was added. Advance it only after a
release has been applied and verified, never merely because a migration was
merged. If a PR adds no migration beyond that version, the upgrade path still
proves the released schema can reset and matches a clean replay; the first
subsequent migration exercises the incremental apply.

## Temporary seed fixture and scope

Migration 11 still creates five named users and falls back to `change-me`.
Until B004 removes that behavior from the source migration, the replay harness
adds three `set_config` calls after `pgcrypto` is created **in the disposable
copy only**. Postgres generates fresh synthetic passwords for this local run;
the values are never put in a file or log. The contract checks that no local
account has the fallback password. This fixture is a bridge for B003, not a
fix to the underlying seed migration; B004 must remove its password-reset
side effect and move account fixtures to a dedicated nonproduction seeder.

This check covers schema replay and a stable set of security assertions. B005
adds the complete cross-client identity and `SECURITY DEFINER` test matrix.
The `Schema replay (clean, upgrade, catalog, types)` status must also be marked
required in GitHub branch protection; the workflow file alone cannot change
that repository setting. The Pages release gate across components is B009.
