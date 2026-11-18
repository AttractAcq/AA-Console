# Client delivery live read-only checkpoint — 18 November 2026

**Operator:** Codex through the signed-in Alexander - Personal Chrome window. **Scope:** production AA Console and the in-house Attract Acquisition client `e4b4b001-81f6-4997-8429-ff21f4ee1fbe`. The browser-extension host was unavailable; native Chrome accessibility exposed the signed-in pages. The Admin snapshot displayed 18 November 2026, 23:21:00; its display timezone was not independently verified. The parity export is stamped `2026-11-18T22:21:44.698Z`. This was read-only apart from downloading the report. No client record, switch, approval, provider action, migration or deployment was changed.

## Release identity and parity

| Evidence | Live observation |
| --- | --- |
| Browser | `61b2166ca562070c00f00dd3984fe71c49d1a7c1` |
| Runtime and fresh worker build | `1429143c2148518a1813a11939770ee9ea03d2e1`; fresh heartbeat at 23:20:52, queued 0, active 0 |
| Gateway | `70c012f0f7205ee3d98a171aaf9c354841edcfc3` |
| Production database | Project `bancbdztffokwiifzoiv`; migration head `20261124034600`, 568 tracked entries |
| Live parity report | `drift`, 21 findings; generated public/GraphQL schema body matched the checked-in types of the audited runtime source |

The read-only [parity JSON](/Users/alex/.aa-console-evidence/live-readonly-2026-11-18/schema-parity.json) has SHA-256 `93a84ec396e931468579a050b27b0a8a947034278216606f6e1e8fc1e8ebd139`. It records 568 production and 569 staging history rows at the same head. Its 21 findings include eight unresolved history entries (the alternate 259/260 lineage among them), two aggregated unavailable SQL-payload findings, seven catalog-definition mismatches and four recorded-SQL mismatches. The audit source digest is `df15e77ee8e5a07861c76eb610c1937794fac822f5e5e363bfa2e85afdc5b32b`; the runtime reports an unknown working-tree state and unknown migration inputs. This report compares the two hosted environments under that audited source. It does **not** prove either hosted schema matches draft PR #363 or resolve the eight historical findings. A lower finding count than a prior report is not itself evidence of a repair because the audited source and classifications differ.

Production System Readiness showed database Engine Off; client Engine, publishing, proof publishing, campaign actions, lead magnet delivery and outbound messaging Off; runtime proof publishing, campaign actions, lead magnet delivery and outbound messaging Off. The runtime inventory marked its Resend credential Missing, and recorded Meta/Facebook identities did not include live scope or action-capability verification. The 22 production cron entries matched the released schedule registry as catalog records; cron execution receipts were still unknown in this UI.

## Client journey prerequisites

Market Opportunities listed eight agent-proposed opportunities, all `Discovered` and marked `Hypothesis`. Offer Studio explicitly said “No currently approved opportunity”; its new-secondary and compile-secondary controls were disabled. The visible offers had no signed-off versions. Campaign Factory listed legacy campaigns, including `AA Organic Launch — 14 Day` in Planning with `Awaiting plan`; the list provided no prepared organic and paid package for acceptance. These observations block a read-only claim that the Phase 4 approved opportunity → offer → coordinated campaign journey exists for this client. They do not authorize creating or approving a production fixture.

The agency Approval Inbox loaded normally and showed one pending service-offer request for this client. Its coverage panel reported **1 of 34** planned classes marked operational and 33 blocked. The exact offer decision controls were disabled because this signed-in session had not completed MFA/AAL2. This verifies that this agency read path loaded in the inspected session; it does not establish complete client Inbox coverage or an approval decision.

## Next evidence

Keep Phases 8 and 9 unaccepted. Complete CI and hosted review for draft PR #363, reconcile the eight history findings and definition/SQL mismatches without rewriting history, and recheck deployed component and schema identity after an authorized release. A safe, expressly designated fixture and reviewer identity are needed for an approved opportunity and offer, organic/paid package preparation, exact AAL2 decisions, provider preflight, outward receipts and route-to-cash checks. The in-house client was not designated disposable in this inspection.
