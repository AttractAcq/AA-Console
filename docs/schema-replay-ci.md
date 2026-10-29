# Schema replay CI gate (B003)

The `Schema replay (clean, upgrade, catalog, types)` CI job runs the tracked
Supabase migrations against an isolated local Supabase stack. It does not use a
linked project, a production database URL, or a hosted access token. The job
requires Docker, Node 22, `psql`, and Supabase CLI 2.101.0. On GitHub Actions
these are installed by the workflow.

Before the database starts, `scripts/schema-migration-order.mjs` checks every
post-259 logical migration label in timestamp order. The next expected label
is 260. The branch containing migrations 261 and 262 fails this guard until
the Google Ads migration 260 is present with an earlier timestamp and a
`google_ads` name. The Pages
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

## Temporary seed fixture and raw-source proof

The B004 review branch corrects migration 11's `change-me` fallback and
existing-account Auth rewrite in the tracked source. The old disposable
fixture remains available by default while full clean and upgrade replay of
the corrected source is verified. Set `AA_SCHEMA_REPLAY_RAW_SOURCE=1` to copy
the exact tracked migration 11 bytes into the disposable project. CI sets this
flag for the complete schema replay, upgrade equivalence, catalog, and type
gate. Its manifest records `authSourceReplay: true` and `fixture: false`.
After that gate passes with the required migration 260 ancestor, remove the
fixture path in a follow-up commit. The PGlite Auth tests exercise migration
11 directly with test-only pgcrypto stubs and cover missing settings,
pre-registered and repeat accounts, forged metadata, and unsafe configured
secrets. Full schema
replay remains the required release evidence.

The corrected source still seeds named accounts. B004's controlled Auth Admin
provisioning, first-admin recovery, password rotation, TOTP at decision paths,
and production account provenance remain separate acceptance gates.

This check covers schema replay and a stable set of security assertions. B005
adds the complete cross-client identity and `SECURITY DEFINER` test matrix.
The `Schema replay (clean, upgrade, catalog, types)` status must also be marked
required in GitHub branch protection; the workflow file alone cannot change
that repository setting. The Pages release gate across components is B009.
