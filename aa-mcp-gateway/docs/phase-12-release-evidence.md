# Phase 12 release evidence

Release remains **BLOCKED** pending final production history-repair approval. No
production writes, history repair, deployment, credentials, or connectors occurred.

## Pinned inputs

- Main: `83324f7d2168cdb8aabd0264728c91491507a67d`.
- Implementation reviewed: rebased Phase 12 branch from `4773e175e2072446c0095202fd23271c2f3cd797`, draft PR #17.
- Deferred migration 77 and PR #16 are excluded.
- Work performed in `/private/tmp/AA-Console-phase12`; original checkout untouched.

## Production history: CASE A

The existing authenticated link identifies project `bancbdztffokwiifzoiv`.
Supabase CLI 2.101.0 read-only history and catalog queries succeeded. Version
`20260909020000` has exactly one row named `72_campaign_execution`; both Campaign
and CoS durable effects exist remotely. CoS is missing only its distinct normalized
history version `20260909020100`. Production also records the equivalent Campaign
history marker at `20260909105749`, and migration 79 at `20260911205529`.

| Migration file | Version | Distinct effects to verify | Remote version recorded? | Remote effects? | Conclusion |
| --- | --- | --- | --- | --- | --- |
| `20260909020000_72_campaign_execution.sql` | `20260909020000` | Campaign tables, indexes/FKs/checks/RLS policies and RPCs | Yes, exactly once | Yes, matching | CASE A |
| `20260909020100_72_mcp_cos_orchestration.sql` | `20260909020100` | CoS task ledger, task columns, RPCs, RLS/FORCE RLS and service-role grants | No distinct row | Yes, matching | History-only repair candidate |

`supabase/verification/phase12-migration-history-readonly.sql` provides an explicit
read-only metadata probe. It returns version counts, object existence, RLS,
policy/index names and effective RPC execution privileges, never stored migration
statements or application/credential values. Object presence alone is not proof
that every definition matches: inspect any ambiguous effects separately before
classifying A–D or designing reconciliation. Later migrations legitimately replace
some functions, particularly migration 78's workflow function.

## Reconciliation decision

Repository normalization is implemented in the isolated branch only:

- migration 67 filename aligned to `20260908192515`;
- CoS migration assigned `20260909020100`;
- no-op marker added for `20260909105749`;
- migration 79 restored at `20260911205529`;
- Phase 12 moved to `20260911210000`;
- migration 75 changed only to `ADD COLUMN IF NOT EXISTS external_id`.

The remaining production action is one metadata-only repair, pending explicit
approval:

`supabase migration repair --linked --status applied 20260909020100`

This does not execute CoS SQL or change production schema. Migration 78 remains
intentionally unapplied in production.

- A: preserve the recorded production version and both existing effects; determine
  whether an assertions-only forward migration is useful.
- B/C: propose a fresh version after 78 that creates only the missing effects and
  validates existing definitions, dependencies, and grants.
- D: propose applying both missing effect sets under a fresh version after 78,
  after checking later migrations' dependencies and actual upgrade ordering.

These are conditional options, not approval to execute. In particular, if 78
needs missing CoS objects, a reconciliation dated after 78 cannot simply be
appended and expected to rescue that upgrade: the upgrade sequencing needs an
explicit reviewed plan. Never rename applied history or issue repair commands.
Whether history repair is needed remains unknown and requires human approval.

Supabase tracks timestamp versions in its history table. A later migration alone
cannot cure a duplicate-version failure that occurs earlier during fresh replay.
The real CLI behavior must be captured before selecting a bootstrap mechanism.
A separately documented, automated empty-database compatibility path may be
appropriate, but must preserve historical files and production upgrade truth;
no speculative bootstrap bypass is included here.

## Disposable PostgreSQL availability

- `/Applications/Docker.app` is an empty directory, with no executable to start.
- No Docker, Podman, Colima, Lima, Orb, or PostgreSQL server was found in the
  inspected installed tools. Homebrew libpq supplies clients, not the server.
- `pg_isready` received no response on local ports 5432 and 54322.
- Colima 0.10.3 on aarch64/VZ and Docker 29.8.0 client / 29.5.2 server are healthy.
- Normalized replay from zero completed through migration `20260911210000`.
- The only warning was migration 75 skipping the already-existing `external_id`.
- Vector service startup has a Colima socket-mount limitation; database replay and
  database tests completed with Vector excluded.

## Regression evidence

The shared workflow matrix executes the same expectations against the original
migration-72 function and the migration-78 replacement, separately for Production,
CDM, CoS, Marketing, Distribution and Sales Ops. It covers create/assign/get/list/
complete, receipts, completed-task behavior, invalid assignees, active members
without client assignments, active bots without client grants, compatible errors,
ungranted clients, and foreign task IDs. A normalized SQL comparison proves the
only shared-function addition is the Admin assignment guard. All six currently
have the five workflow permissions; gateway tests also assert denial when those
permissions are removed. Existing legacy replay-before-assignee-validation behavior
is preserved deliberately; this is not a new permission expansion.

Admin assignee tests explicitly cover same/wrong-client bots, suspended/unknown/
malformed bots, same/wrong-client members, ended assignments, inactive/unknown/
malformed members, and replay after bot grant removal, bot suspension or ended
member assignment. All pass.

Gateway matrix covers all six bots in env/dual/db modes, positive cache TTL,
revocation after TTL, outage fallback behavior, identity/client/permission mismatch,
DB misses, workflow grants and Admin/decision denials. All 30 non-Admin matrix
checks were additionally run against the authenticator extracted from pinned main
in a disposable directory: 30/30 pass. Admin tests cover hosted env deny, exact
localhost/127.0.0.1 HTTP fixtures, valid dual/db authorization, immediate revocation,
suspension, client/permission removal, resolver outage, and identity mismatch.
Dual removal mismatches fail closed; DB removal returns reduced authorization.
No auth redesign or production code change was needed.

## Validation

- Gateway: **163/163**, check/build/docs pass.
- Runtime: **511/511**, typecheck/build pass.
- Explicit isolation: **104/104**, including 27 added release checks.
- Admin discovery remains exactly 15; no registry or grants changed.
- Full clean PostgreSQL replay through Phase 12: **PASS**.
- Local normalized history: exactly one row each for 67, Campaign 72, CoS 72,
  migration 75, compatibility marker, 76, 79 and Phase 12.
- Existing Vitest development dependency advisory remains outside this test-only change.

Human CLEAR still requires remote history/effects evidence and actual clean replay,
followed by any explicitly approved reconciliation/bootstrap work and its tests.
