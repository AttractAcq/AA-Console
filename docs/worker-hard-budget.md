# Monthly agent budget

The AA Console ceiling is USD 100 per enrolled client per UTC calendar month. The first rollout is the November 2026 QA client. Migration 20261124061800 creates the controls and enrolls zero clients.

## Release and enrollment

1. Obtain release approval for the Discovery repair and the spending control. Check the Console Supabase ref and Railway environment before each change. Apply the migration before rolling the worker. Verify the actual worker revision on every replica and confirm the frontend's release identity.
2. Verify the intended client, month and Account budget. Enroll before its first paid action that month. Check for active or historical worker attempts, direct client chat or draft calls, public sales traffic and outstanding provider work. Quiesce those routes during enrollment. If a previous call has an unresolved cost, hold enrollment for reconciliation.
3. Insert the verified client UUID and the first day of the month into `agent_budget_private.caps`. The private ceiling defaults to USD 100. A lower Account cap or private ceiling takes precedence. For QA Market research, set `market_model` to `claude-sonnet-4-6` on that monthly row. The selection applies only to Market for that tenant and month. A missing month or Account budget holds enrolled work.
4. Verify `client_budget_state` with the operator's credentials and check the matching private receipts. The remaining balance equals the effective cap less settled usage and open reservations. Verify the active scope, current worker, available balance and any existing job before submitting or retrying. Expand enrollment only after QA passes.

## Discovery prerequisites and reservations

Console's Discovery enqueue checks for completed Market and ICP jobs for the selected client. A saved section supplies content. A source review cannot produce the required job receipt. The supported Market agent researches public sources. The QA model selection preserves its prompt, structured submission and 15-search limit.

| Request | Model | Maximum reservation per provider call |
|---|---|---:|
| Market with web search | Opus 5 | USD 113.0076 |
| Market with web search, QA configuration | Sonnet 4.6 | USD 67.86456 |
| Text-only workflow with the default model | Opus 5 | USD 7.3536 |

The research bound allows ten server sampling iterations, each with a full 1,048,576-token input at the higher cache-write tariff and 32,000 output tokens, plus up to 15 paid searches. The standard text-only request uses one iteration and the five-minute write tariff. Each new Messages request requires another reservation. [Opus 5 pricing](https://platform.claude.com/docs/en/models/opus-5/overview) · [Sonnet 4.6 pricing](https://platform.claude.com/docs/en/models/sonnet-4-6/overview) · [Server iteration limit](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) · [Search billing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

## Coverage and recovery

Market, ICP, Offer Strategy, Opportunity Discovery, Evaluation, Opportunity Strategy, Offer Compile and Campaign Plan use the shared reservation protocol. Other queue agents hold before dispatch. Client-scoped direct draft routes, Master chat and the public sales widget check enrollment before provider use and hold enrolled clients. A failed policy lookup holds the request. Revalidate model prices, tool charges and limits before enabling a new configuration.

Turn zero reserves before dispatch. The first provider turn atomically replaces it. Every subsequent turn and retry competes for the same client-month balance. The enrolled worker disables SDK retries and redirects and requests standard global inference. An older worker cannot enter running for an enrolled job without the matching dispatch reservation.

A confirmed provider receipt settles token usage by model and cache TTL, plus search charges, rounded upward to a microdollar. Lost responses, incomplete usage and ambiguous settlements retain the sent reservation. Inspect receipts by client, job, attempt and turn before retrying. Reconcile against provider records before releasing any uncertain charge. Preserve the private ledger on rollback and hold the client until production identity and enforcement are verified.

## One reviewed GPT-Image-2 attempt

Migration 20261124062200 creates an empty private permit table. After a specific cost exception and release approval, the operator can insert one permit for the exact enrolled client, UTC month and brief. Bind it to the reviewed SHA-256 of the UTF-8 PostgreSQL JSON array text for Argument, Script and Visual direction. Keep the row as the permanent record of the decision. A repeated queue action returns its existing job.

The worker transfers the dispatch reservation to the single Images API call and sends only Visual direction. The private receipt records the provider request ID and reported text input and image output tokens. Console prices those counters at the standard direct API tariff. A charge above the reservation is recorded in full and reduces the shared balance. Check the provider billing record for account-specific adjustments. Missing usage or an ambiguous outcome keeps the reservation open for reconciliation. Inspect the provider receipt, render storage path and filed draft before recovery.
