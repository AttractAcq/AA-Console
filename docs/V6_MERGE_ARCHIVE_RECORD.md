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
| #254 | `codex/b006-public-perimeter` | `B006: forward Meta webhook through signed ingress`, plus a readiness-evidence clarification | The ingress files are in the stack; these two refinements on top are not. Needs its own review. |
| #257 | `codex/b002-staging-reconciliation` | 12 commits, data-preserving staging 259–279 reconciliation | Modifies a workflow file, which `verify-github-release-candidate` rejects a pull request for touching. Needs a decision on that guard. |
| #267 | `codex/b009-fresh-release-probe` | 6 commits, authenticated uncached release probe | Same workflow-file guard as #257. |
| #298 | `codex/b008-app-head-check` | `scripts/publish-approved-production-release-check.mjs`, `scripts/production-release-head-check-contract.mjs` | Neither file exists in the stack. It is a different design from #288's staged check, not a superset of it. |
| #314 | `codex/b013-capability-evaluator-20261030` | `provider-capability.ts` | Not in the stack at all. |

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

## Still to clean up in v6.2

Per Alex's direction on 31 October: Rights, Placements, Opt-ins and Motion
Design are to be archived and documented now, and properly removed in v6.2
once v6.1 is live. Archiving without a record is the habit this file exists to
break — anything archived for v6.1 belongs in a table here too.
