# Campaign action owned claim release

## Current default

`CAMPAIGN_ACTION_OWNED_CLAIM_ENABLED` defaults to false. While false, the registered campaign action worker stops before any action claim and reports a hold. `CAMPAIGN_ACTIONS_ENABLED`, a client switch, and an Approval Inbox yes do not independently release execution. The old unfiltered `claim_campaign_actions(integer)` RPC remains revoked from `service_role`.

## Owned path

Migration 325 adds `claim_campaign_actions_owned_v6`. In one transaction it checks a fresh runtime heartbeat, the complete deployed commit SHA, the exact handler map, locked registry support and attestation, the client switch, the current campaign manifest, the exact AAL2 Inbox decision, and the execution lifecycle. A supported action is claimed only by a worker that advertises its handler. The local integration fixture verifies a positive claim, disabled switch, unsupported handler, duplicate claim, retry, and terminal receipt.

Migration 328 records one row in `campaign_action_attempts_v6` for each new claim and outcome. It preserves a separately labelled inferred row only for an old in-flight attempt. Page deployment and budget changes cannot be marked executed without an external reference. The specialist queue displays each attempt, its failure, and any provider reference. Migration 329 permits the client switch to be enabled only by an AAL2 admin or active manager when a fresh runtime heartbeat and all four registered handlers match the deployed build. Turning the switch off remains available. Migration 330 adds a service-only prewrite check of the live lease, exact approval and Inbox decision, switch, heartbeat and handler registry. Each owned handler calls it immediately before its effect; source-specific byte, rights and budget checks still apply.

The runtime now has an opt-in owned-claim path. When the flag is true, it reports an unheld heartbeat only after checking the registry against its deployed SHA. It calls the owned RPC, dispatches only its registered handlers, and records each claimed action's success or failure. Each handler still runs its own last-moment source and provider checks. The runtime and Dashboard show the observed hold state rather than treating a requested switch as proof of execution. The rollback-only fixture proves that turning the client switch off after claim blocks the prewrite; this is a local database test, not a provider receipt.

Migrations 331–332 add a reasoned AAL2 revocation as an append-only source record and canonical Inbox event. The owning queue displays the withdrawal and the owned claim refuses it. Revoking an approval after an action executed blocks future use but cannot undo an external effect; a separate provider retraction and receipt are still required.

Migration 334 closes the direct service-role calls to proof release and lead enrolment. Their owned wrappers perform the claim, Inbox, switch and handler prewrite check in the same database transaction as the internal effect. The runtime calls only those wrappers. A serialization or deadlock failure may retry; an authorization or unknown failure is recorded for review.

## Release gate still open

The opt-in flag must remain false in deployed environments until the full Phase 2 gate is met: review the handler and SQL contract together, verify schema parity and a full deployed SHA, attest the four registry rows to that build, exercise concurrency and fail-closed cases in the target environment, and observe one approved external test action with an actual provider receipt. An approval receipt and an attempted execution are separate facts. A provider timeout with an unknown outcome requires reconciliation before another write.
