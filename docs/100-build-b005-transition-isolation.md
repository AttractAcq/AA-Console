# B005 transition isolation slice

Migration `20261029150000_264_low_level_transition_isolation.sql` closes two
direct signed-in RPC paths that could write state without the named human
decision. It follows migration 263 and must be released only after 260–263.

## Boundary enforced

- `advance_slot` and `advance_assignment` are executable by `service_role`,
  but no longer directly by `authenticated`, `anon`, or `PUBLIC`.
- `may_advance_slot` and `may_touch_assignment` are internal predicates, with
  the same grants. Named human wrappers such as `approve_slot`,
  `reject_slot`, `accept_assignment`, and `deliver_assignment` retain their
  existing grants and call the state machines as SECURITY DEFINER owners.
- An assignment may attach only an asset belonging to its client. A second
  trigger blocks changing an attached asset's `client_id` afterward. The
  migration refuses installation if it finds a pre-existing mismatch; such
  rows require a separate reviewed repair, not silent reassignment.
- `schema-replay-contract.sql` asserts grants and trigger presence on clean
  and upgrade replay.

## Local evidence

`agent-runtime/src/anon-lockdown.pg.test.ts` and
`agent-runtime/src/assignments.pg.test.ts` apply migration 264 to actual slot
and assignment state-machine functions respectively, with a matching stub
for the unrelated half of each partial fixture. Tests use `SET ROLE
authenticated` for direct-call denial and positive named-wrapper behavior;
they also verify catalog grants, same-client asset acceptance, foreign asset
rejection, unchanged state/event counts after refusal, and asset-reparenting
refusal. The fixtures are not a substitute for the full migration replay.

## Remaining B005 work

This slice does not change lead RPC entitlements, retired owner's storage
read policy, historical shared chat membership, or the full cross-identity
RLS/definer matrix. Those remain B005 acceptance work. It also does not
establish the later exact-version unified Approval Inbox contract in B008.
Production grants, existing asset relationships, and hosted identity
behavior have not been inspected by this local change.
