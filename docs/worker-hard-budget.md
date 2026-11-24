# Opt-in monthly worker budget

This control applies to AA Console agent jobs. Enrollment requires a reviewed database change after deploying compatible workers. The migration enrolls zero clients. PR 448 has its own release approval.

## Enrollment and release

1. Identify the intended Console tenant and UTC budget month. Verify its authorized maximum and its existing Account budget. Enroll before the first worker attempt in the month. Check any non-queue AI surfaces separately before claiming an account-wide limit. The QA exercise uses the agent queue only.
2. Apply the reviewed migration, release the compatible worker and verify the Railway revision and heartbeat through the existing release process. A fresh claim carries the database's enrollment decision. The database refuses an older worker's transition to running for an enrolled client without an attempt reservation.
3. A database administrator inserts the exact client UUID, first day of the month and approved USD ceiling into `agent_budget_private.caps`. The effective cap is the lower of this ceiling and the existing `client_engine_budgets` amount. An enrolled client with a missing month or Account cap is held. The pilot's authorized ceiling is USD 10 in November 2026.
4. Verify `client_budget_state` as an authorized operator. Posted spend includes settled provider turns across all attempts. Remaining funds also deduct outstanding reservations. Review the next agent's reservation before submitting any job. Check existing job IDs before retrying.

## Provider coverage

The priced path is the standard global Anthropic Messages API using `claude-opus-5`. The reviewed agents are Market, ICP, Offer Strategy, Opportunity Discovery, Evaluation and Strategy, Offer Compile and Campaign Plan. Other runners and model IDs hold for opted-in clients. Revalidate model pricing, tool charges and sampling limits before activation or changing provider configuration.

Each text-only call reserves USD 7.3536. This covers 1,048,576 input tokens at up to the default five-minute cache-write rate and 32,000 output tokens. The request does not opt into one-hour caching. The reservation is conservative and independent of prompt size. [Opus 5 limits and prices](https://platform.claude.com/docs/en/models/opus-5/overview)

Market's 15-search configuration reserves USD 113.0076 per request. The bound allows ten server sampling iterations, a full context at the higher cache-write rate and maximum output on each iteration, plus the search charge. A single HTTP request can incur token charges while the server continues searching. At USD 10 available this configuration must hold, with a reservation shortfall of USD 103.0076. These amounts are upper bounds. [Server sampling limit](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) · [Search billing](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

## Receipts and recovery

Turn zero reserves before worker dispatch. Turn one atomically replaces it immediately before the first provider request. Each subsequent turn and queue retry reserves independently against the same locked monthly allowance. SDK retries and redirects are disabled for enrolled jobs. Standard global inference is explicit. Incomplete usage, a lost provider response or an unconfirmed settlement retains the full sent reservation. Confirmed usage settles in microdollars, rounded upward, using the upper cache-write tariff for unsplit usage.

Insufficient funds hold the job until the required reservation fits. An unpriced request or uncertain receipt requires operator reconciliation. Read the private receipt by client, job, attempt and turn. Review the provider's authoritative usage before releasing any uncertain funds. A process crash or expired lease alone gives no evidence of a zero-cost request. Preserve receipts across worker rollback. Keep the affected client held and verify the production identity before resuming.
