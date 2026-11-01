# v6 merge: what was closed, what stayed open, and why

Written 31 October 2026, when the held v6 work was integrated onto `main` so
that `main` could be the clean baseline for the v6.1 build.

This file exists because closing drafts is a quiet way to lose work. Anyone
asking "where did that branch go?" should be able to answer it from here
without reading 21 pull request threads.

## How "absorbed" was decided

Not by comparing migration counts. A branch was treated as absorbed only when
its tip is a **strict ancestor** of #297's head:

```
git merge-base --is-ancestor <branch> codex/b005-current-employee-role-298
```

That distinction mattered. An earlier pass counted migrations and concluded 17
drafts were absorbed. The ancestry check put it at 15, and the two it rescued
(#254 and #298) both carry commits the stack never took. Closing them would
have discarded real work.

## Closed as absorbed by #297 (15)

All 15 merged into `main` as part of `37fb770`. Every branch is left in place
on the remote; closing a pull request does not delete it.

| PR | Branch | Landed as |
|---|---|---|
| #261 | `codex/b004-retire-password-route-main` | migration 286 |
| #264 | `codex/b004-controlled-invitations-main` | migrations 287–289 |
| #271 | `codex/b011-organic-db-route` | migration 290 |
| #272 | `codex/b012-meta-v6-claim-guard` | no migration; content contained |
| #273 | `codex/b008-release-inbox` | migration 291 |
| #277 | `codex/b012-meta-v6-atomic-binding` | migration 292 |
| #278 | `codex/b010-meta-producer-containment-290` | migration 293 |
| #281 | `codex/b014-integration-status-291` | migration 294 |
| #283 | `codex/b011-exact-organic-publication-292` | migration 295 |
| #285 | `codex/b008-release-decision-293` | migration 296 |
| #288 | `codex/b008-trusted-release-check` | staged trusted release check |
| #289 | `codex/b005-proof-submissions-294` | migration 297 |
| #291 | `codex/b008-approved-reattest-295` | migration 298 |
| #294 | `codex/b005-current-client-role-296` | migration 299 |
| #295 | `codex/b008-trusted-merge-297` | migration 300 |

The stack's labels 280–298 were renumbered 283–301, because 280, 281 and 282
merged separately while the stack waited.

## Left open deliberately (5)

These are **not** absorbed. Each holds content that is not in `main`.

| PR | Branch | What is unique to it | Why it is still open |
|---|---|---|---|
| #254 | `codex/b006-public-perimeter` | `B006: forward Meta webhook through signed ingress` (`bba8486`), plus a readiness-evidence clarification (`f487c34`) | The ingress files are in the stack; these two refinements on top are not. **Must not be merged as-is** — see the collision warning below. |
| #257 | `codex/b002-staging-reconciliation` | 12 commits, data-preserving staging 259–279 reconciliation | Modifies a workflow file, which `verify-github-release-candidate` rejects a pull request for touching. Needs a decision on that guard. |
| #267 | `codex/b009-fresh-release-probe` | 6 commits, authenticated uncached release probe | Same workflow-file guard as #257. |
| #298 | `codex/b008-app-head-check` | `scripts/publish-approved-production-release-check.mjs`, `scripts/production-release-head-check-contract.mjs`, and that file's test (`a687dbc`, `042d4a7`, `002d3a7`) | Neither file exists in the stack. A different design from #288's staged check, not a superset of it. **Must not be merged as-is** — see the collision warning below. |
| #314 | `codex/b013-capability-evaluator-20261030` | `provider-capability.ts` | Not in the stack at all. |

## Why #254 and #298 must never be merged as-is

The renumber changed **labels**, not the 14-digit **versions**. The version is
the primary key. Both of these branches still carry the pre-renumber filenames,
so every migration on them collides with the same version already on `main`:

| version | on `main` | on those branches |
|---|---|---|
| `20261101000000` | `..._283_public_route_quota.sql` | `..._280_public_route_quota.sql` |
| `20261101140000` | `..._300_production_release_merge_lease.sql` | `..._297_production_release_merge_lease.sql` |

Merging leaves **two files per version** — three such collisions on #254,
eighteen on #298. That makes the history ambiguous, breaks
`scripts/schema-migration-order.mjs`, and breaks the recovery preflight's
318-migration pin. Every one of those migrations is already applied to
production under its renumbered name.

#298 additionally resurrects `src/pages/account/IntegrationsPanel.test.tsx`,
which `main` deleted in favour of two more specific files, and reverts newer
`main` work: `SystemReadinessPanel.tsx` is 6 commits ahead there,
`UnifiedApprovalInboxPanel.tsx` 4, `src/types/database.ts` 4,
`IntegrationsPanel.tsx` 3, `readiness/collect.ts` 5.

**So both are cherry-pick jobs, not merges.** Take the unique commits named in
the table above onto current `main` as small pull requests. For #254's
`f487c34`, re-apply its change to `main`'s `SystemReadinessPanel.tsx` rather
than taking the file wholesale — it is six commits newer there, and taking a
file wholesale from the older side is exactly what cost a round on #297.

#257 and #267 carry no migrations and so have no collision; they are blocked
only on the workflow-file guard.

#314 was checked against this and is clean: five files, no migrations, and no
commit on `main` has touched any of them since its base. It is the one of the
five that can simply be merged.

## Conflict resolution rule, and its one exception

Eleven files conflicted. The rule applied was **main wins**, because main was
the newer side nearly everywhere: its `IntegrationsPanel`, readiness collector
and inbox panels had moved past the stack's, and the stack's copies still
carried fields B016 deliberately removed.

The exception is `agent-runtime/src/readiness/route.test.ts`, where the stack
is newer. Resolving that one to main's side silently removed three security
assertions, because main's `route.ts` has no `requestProxy` at all — that is
B006 work the stack brings. Implementation and test have to come from the same
side. The stack's version was restored verbatim.

The lesson, recorded so it is not relearned: *"main wins every conflict" is
wrong wherever main is the older side*, and the way it bites is a file and its
test resolving to opposite sides.

## The two conditional prototypes inside 283–301

Migrations **299** and **301** open with:

> `B005 / Q022 CONDITIONAL PROTOTYPE. Do not release until Alex selects the identity rule.`

They rewrite `is_client_user` and `accessible_client_ids` so that a
`client_users` or `team_members` row is an entitlement only while that
account's current `profiles.role` matches.

Checked against production on 31 October, before applying:

| check | affected rows |
|---|---|
| `client_users` rows whose account role is not `client` | 0 |
| active `client_assignments` whose account role is not `employee` | 0 |
| open `job_assignments` whose account role is not `employee` | 0 |

Zero on all three. The stricter rule revokes nobody's access as things stand;
it only prevents future drift. That is why they were not held back from the
merge.

## Stale migration numbers left by the renumber (v6.1 doc sweep)

The renumber from 280–298 to 283–301 updated every **filename** reference in
tests and docs. It did not update prose that names a migration by bare number,
because those do not match a filename pattern. So documents written while the
stack used its original numbering now cite numbers that mean something else in
`main` — the clearest case being `agent-runtime/RAILWAY.md`, which described
migrations 280, 281 and 282 as the public-route quota, the paid-widget budget
reserve and the admin status view. Those are 283, 284 and 285 now; in `main`,
280–282 are the rule-six support flags, the booking and nurture config, and the
engine config.

`RAILWAY.md` was corrected first because it gates a runtime deploy decision and an operator follows it directly.

**The rest of the sweep was done on 1 November 2026.** Ten documents had their references corrected (stack label + 3) with every anchor verified to match exactly once, never as a blanket sweep, because 280, 281 and 282 also exist for real and mean something else entirely. Each now carries a footnote saying the numbers are released labels.

`production-recovery-preflight.md` needed repinning rather than renumbering, as predicted: it described a 296-migration baseline through `20261030160000`, which predates 280 entirely. It now states the 318-migration, 301 baseline the script asserts.

`AA_CONSOLE_100_BUILD_BLUEPRINT.md` is **deliberately not renumbered**. Its 30 October section is a dated snapshot that was accurate when written; a snapshot quietly edited stops being evidence of anything. It is marked superseded and points here instead.

`agent-runtime/ingress/README.md` is the one file left, held back on purpose: it sits under `agent-runtime/`, which the release gate's component-pin check treats as a runtime change regardless of the change being prose, so correcting it costs a Railway redeploy and a repin. It should ride along with the next change that touches that directory for real.

The files swept:

```
agent-runtime/ingress/README.md
docs/AA_CONSOLE_100_BUILD_BLUEPRINT.md
docs/B004_CONTROLLED_INVITATIONS_INTEGRATION.md
docs/B008_APPROVAL_SOURCE_INVENTORY.md
docs/b008-github-release-candidate-verifier.md
docs/b008-production-release-gate.md
docs/b012-meta-v6-claim-guard.md
docs/production-recovery-preflight.md
docs/security/B005-Q022-client-role-entitlement.md
docs/security/B005-Q022-employee-role-entitlement.md
docs/security/B005-proof-submission-read-boundary.md
docs/security/B005-sales-entitlement-boundary.md
docs/security/organic-publication-authority.md
```

Two caveats for whoever does it. `AA_CONSOLE_100_BUILD_BLUEPRINT.md` holds a
**dated snapshot** (30 October) whose numbers were correct when written; that
section is a historical record and should be left as it reads, or marked as of
its date, rather than renumbered. And `production-recovery-preflight.md` still
describes a 296-migration baseline through `20261030160000`, which predates 280
entirely — it needs repinning to the 301 baseline at 318 migrations, not just a
number swap.

A future renumber should grep for `migration \d{3}` in prose as well as
filenames.

## Also open after the v6 merge

- `.github/workflows/production-release-approval.yml` arrived with #297 and runs
  on every pull request to `main`, but only passes for a non-draft pull request
  whose body carries exactly one `AA-Release-Request: <uuid>` line, against an
  approval row in Supabase, with `AA_RELEASE_SUPABASE_SERVICE_ROLE_KEY` set —
  which it is not. It performs no merge or deployment, so a red result blocks
  nothing, but every ordinary pull request will show a failing check until the
  job is scoped with an `if:` guard. Alex's decision on 31 October was to do
  that in v6.1, folded into the same pass as the `verify-github-release-candidate`
  workflow-file guard that blocks #257 and #267.
- Leaked-password protection is disabled in Supabase Auth. Migration 286 retired
  browser password creation, so the exposure is small, but enabling it is free.

## Still to clean up in v6.2

Per Alex's direction on 31 October: Rights, Placements, Opt-ins and Motion
Design are to be archived and documented now, and properly removed in v6.2
once v6.1 is live. Archiving without a record is the habit this file exists to
break — anything archived for v6.1 belongs in a table here too.
