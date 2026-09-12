# Phase 12 release evidence

Release remains **BLOCKED**. No production writes, history repair, migration rename,
new migration, deployment, credentials, or connectors are authorized by this report.

## Pinned inputs

- Main: `d6fc90b84e7c8fd74c30d4be77e72f5f915c8943`.
- Implementation reviewed: `ce9c061c8182098af47b26196d46f73b4efc96a6`, draft PR #17.
- Deferred migration 77 and PR #16 are excluded.
- Work performed in `/private/tmp/AA-Console-phase12`; original checkout untouched.

## Production history: CASE E

The existing local link identifies project `bancbdztffokwiifzoiv`. This is a local
configuration observation, not proof of a successful remote connection.
Both installed CLI entry points returned exit 1 without usable history results.
Raw diagnostics were suppressed to avoid credential disclosure. No version or
remote schema-effect claim can be made from these failed requests.

| Migration file | Version | Distinct effects to verify | Remote version recorded? | Remote effects? | Conclusion |
| --- | --- | --- | --- | --- | --- |
| `20260909020000_72_campaign_execution.sql` | `20260909020000` | `public.client_campaigns`, `campaign_artifacts`, their indexes/FKs/checks/RLS policies; `campaign_readiness`, `provision_campaign`, `launch_campaign` RPCs with authenticated/service_role execute and PUBLIC/anon revoked; `campaign_plan` agent registration | Unknown | Unknown | CASE E |
| `20260909020000_72_mcp_cos_orchestration.sql` | `20260909020000` | Task assignee/completed_at columns; internal task receipt table with FORCE RLS; internal/public workflow and campaign functions, their service-role grants; revised delivery task reads | Unknown | Unknown | CASE E |

`supabase/verification/phase12-migration-history-readonly.sql` provides an explicit
read-only metadata probe. It returns version counts, object existence, RLS,
policy/index names and effective RPC execution privileges, never stored migration
statements or application/credential values. Object presence alone is not proof
that every definition matches: inspect any ambiguous effects separately before
classifying A–D or designing reconciliation. Later migrations legitimately replace
some functions, particularly migration 78's workflow function.

## Reconciliation decision

No reconciliation is selected or implemented while CASE E applies. Once evidence
is available, compare both sets of effects against the intended schema:

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
- No disposable dev/staging target has been identified as approved for this task.
- Isolated Supabase reset previously stopped before migration execution because
  the Docker daemon was unavailable. No duplicate error has been reproduced.
- Approval or an existing approved environment is requested before installing
  infrastructure or using another database. PGlite results below are not full
  Supabase/PostgreSQL-history replay evidence.

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
- Full clean PostgreSQL replay and clean bootstrap: **BLOCKED**, not simulated PASS.
- Existing Vitest development dependency advisory remains outside this test-only change.

Human CLEAR still requires remote history/effects evidence and actual clean replay,
followed by any explicitly approved reconciliation/bootstrap work and its tests.
