# B004 migration 272: onboarding step integrity

## Defect and scope

Migration 07 created `cos_client_update` with a client-scoped `USING` clause but `WITH CHECK (true)`. A client user who could see an existing checklist row could update `client_id`, `step_key`, `title`, `display_order` or completion attribution through the table API. With membership in two clients, the row could be moved between them. The row's `(client_id, step_key)` identity is referenced by onboarding logic and client-visible progress; moving it changes another client's record rather than recording a completion.

The existing UI reads the checklist in `ClientAccountView` and `OnboardingPanel`. The `OnboardingPanel` admin action updates `onboarding_call` status; the original policy comment says the client-side write is for its own `onboarding_form`. Migration 272 preserves that boundary: admin maintenance can still edit labels/order/call status; a client can only change its own form status. Service role can maintain status. No rows are rewritten by the migration.

## Database change

- `cos_client_update` now requires membership in the old and resulting client and restricts the client path to `onboarding_form`.
- A BEFORE UPDATE trigger compares OLD and NEW and rejects changes to `id`, `client_id`, `step_key`, or `created_at` for every writer, including an administrator and service role. A legitimate move must create a separately reviewed row, not mutate lineage.
- For non-admin authenticated callers, title/order and direct completion-field edits are rejected. On a status transition to `complete`, the trigger stamps `completed_by=auth.uid()` and `completed_at=now()`; on reopening, it clears them. This prevents an arbitrary browser timestamp or another user's ID from becoming the audit attribution.
- The trigger function has no browser EXECUTE grant; the existing definer lockdown runs at the end. The schema replay contract checks the active trigger and scoped policy `WITH CHECK`.

## Test evidence

`agent-runtime/src/onboarding-step-integrity.pg.test.ts` creates the original migration-07 policy and first proves a two-client member can move a row and change its display fields. It then applies migration 272 and tests cross-client reparent denial for both one-client and two-client users, valid form completion/reopen, denial for a call step or another client's form, protected-field denial, and administrator/service maintenance. Five tests passed on the local PGlite fixture. The adjacent 271 profileless suite (six tests), runtime typecheck, migration-order suite (eight tests), and `git diff --check` also passed.

The fixture uses SQL RLS and triggers, not a mocked frontend permission check. Hosted schema replay and a production read-only catalog preflight are still required before applying the migration. Migration 272 must follow B005 264–269 and B004 270–271 in order.
