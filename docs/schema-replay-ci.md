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
   `src/types/database.ts` after normalizing only the CLI's extra terminal blank line.
   The diff and generated file are uploaded with the
   CI evidence; update the committed type file only after reviewing the schema
   change.

`supabase/verification/released-migration-version.txt` is the lower bound of
the upgrade test. It currently names migration 259, the last version confirmed
as applied to production when this gate was added. Advance it only after a
release has been applied and verified, never merely because a migration was
merged. If a PR adds no migration beyond that version, the upgrade path still
proves the released schema can reset and matches a clean replay; the first
subsequent migration exercises the incremental apply.

## Raw-source Auth replay

The B004 review branch corrects migration 11's `change-me` fallback and
existing-account Auth rewrite in the tracked source. The schema harness now
copies every tracked migration byte-for-byte; the temporary synthetic seed
injection was removed after the first raw-source full replay passed in
[CI run 40963048537](https://github.com/AttractAcq/AA-Console/actions/runs/40963048537).
The replay script always compares the source and disposable migration 11 bytes
before starting the database. CI explicitly sets
`AA_SCHEMA_REPLAY_RAW_SOURCE=1`; the raw path is also the local default, and
disabling it fails closed. The manifest records `authSourceReplay: true` and
`fixture: false`. The PGlite Auth tests exercise migration 11 directly with
test-only pgcrypto stubs and cover missing settings, pre-registered and repeat
accounts, forged metadata, and unsafe configured secrets. Full schema replay
of this fixture-removal commit remains the required release evidence.

The corrected source still seeds named accounts. B004's controlled Auth Admin
provisioning, first-admin recovery, password rotation, TOTP at decision paths,
and production account provenance remain separate acceptance gates.

This check covers schema replay and a stable set of security assertions. The
B005 replay-only `b005-definer-grant-contract.sql` now refuses any anonymous
`SECURITY DEFINER` execution in `public` or `mcp_internal`, checks the
service-only lead predicate and sequence sweep, and preserves signed-in access
to the two scoped sales RLS predicates. Its PGlite tests deliberately add an
unsafe grant and remove a required grant to prove the gate fails. This is a
catalog grant regression check; the complete cross-client identity and
`SECURITY DEFINER` behavior matrix still needs live/staging role testing.
The `Schema replay (clean, upgrade, catalog, types)` status must also be marked
required in GitHub branch protection; the workflow file alone cannot change
that repository setting. On 29 October 2026 after PRs #238 and #235 merged,
`main` branch protection was set to strict up-to-date mode and admin
enforcement, with force pushes and deletion disabled. Four GitHub Actions
checks are required and pinned to app ID 15368: `Schema replay (clean,
upgrade, catalog, types)`, `Frontend (lint, typecheck, test, build)`, `Agent
runtime (typecheck, test, build)`, and `MCP gateway (typecheck, test, build)`.
Temporary ready PR #244 at `ae3fd544176ff1cb191d3a702b00bc8ef2b5fa8d`
deliberately added an out-of-order migration. Its schema job failed at the
order guard and GitHub reported `mergeable_state=blocked`; the PR was closed
unmerged and its fixture branch deleted. Keep all four required checks as new
migrations land. The Pages release gate across components is B009.
