# Phase 7: Client Delivery Manager v1

Design before implementation. Release requires Sec review; Alex via CoS owns migration application and deployment.

## Classification

| Action | Classification | Boundary |
| --- | --- | --- |
| List granted clients; read delivery projections and production handoff | Autonomous | Active bot and current client grant |
| Create delivery task | Autonomous | Durable internal task; no assignment, dispatch or worker enqueue |
| Create gateway approval ticket; read gateway activity/pending tickets | Autonomous | Existing gateway control plane semantics |
| Asset approval, delivery commitments, external communication, employee assignment | Human-required | No new Bot API for these actions |
| workflow.record_decision, asset decision/review_media_asset writes | Forbidden | Existing hard deny unchanged |
| Finance, security, deployment, distribution, CoS orchestration | Forbidden | No new permission patterns or token expansion |

## Data map and honest projections

| Tool | AA RPC / source |
| --- | --- |
| delivery.list_clients | mcp_delivery_list_clients: mcp_bot_clients joined to clients, ordered UUID cursor pagination |
| delivery.get_client | mcp_delivery_read(get_client): clients allowlisted identity fields |
| delivery.get_status | mcp_delivery_read(get_status): onboarding, job_assignments, client_assignments, agent_jobs, delivery task ledger |
| delivery.get_blockers | mcp_delivery_read(get_blockers): overdue open tasks/assignments and failed jobs |
| delivery.get_next_action | mcp_delivery_read(get_next_action): first blocker, otherwise outstanding onboarding or open work |
| delivery.get_plan | mcp_delivery_read(get_plan): outstanding onboarding, open assignments, task deadlines |
| delivery.get_client_health | mcp_delivery_read(get_client_health): attention_required when blockers exist; otherwise unknown (absence of blockers is not proof of health) |
| delivery.create_task | mcp_delivery_create_task: mcp_internal.mcp_delivery_tasks; optional brief ownership checked |

Onboarding is an outstanding checklist, not a claim that the client owes each item. There is no onboarding deadline in the source schema. Null dates remain null. Outputs label projections and cap the combined work projection at 50, with an explicit truncation flag. Production deliverables and handoff remain available through existing content.get_production_status using a brief/idea/asset ID. No compensation, private team information, raw job payloads, or finance fields are returned.

A separate delivery ledger is required because job_assignments requires member_id and participates in employee authorization. Creating an unassigned tracking task must not grant employee access or enqueue an agent. Tasks are durable and returned by delivery reads; completion and assignment APIs are outside this version. Same bot/execution replays identical payload; different payload/client conflicts. Authorization is rechecked before replay.

## Authorization

Every new entry point uses require_active_bot and require_bot_client_grant (FOR SHARE), never can_access_client. Grant precedes client/resource lookup; optional brief must match client_id. List enumerates only that bot's mcp_bot_clients rows and locks each grant before reading its client. Empty grants return an empty list. All grant-touching functions are VOLATILE. Thin public wrappers enforce service role; all new functions revoke PUBLIC/anon/authenticated execution and grant only service_role. Ledger has forced RLS and no Bot table access.

Gateway denies client scope before AA. List has no caller-selected client scope; AA independently enumerates grants and gateway validates returned IDs against authenticated identity. BOT_AUTH_MODE=db and refusal of nonempty BOT_CREDENTIALS_JSON remain unchanged. CDM delivery.* and existing content.get_production_status/workflow grants are reused. CoS prohibitions unchanged.

## Token readiness (Alex / CoS)

Live token/grant presence is not established by repository seeds or local tests. In the authorized operations environment, inspect the bot registry status and token metadata (never plaintext) for bot_client_delivery, and mcp_bot_clients for the exact Harbour client UUID. Use the existing Phase 3–4 token issue/rotation runbook in phase-3-4-bot-auth-rls.md if missing, store the issued secret only in the approved secret manager, and grant only the confirmed Harbour UUID. Do not issue or expand other Bots' tokens. Keep BOT_AUTH_MODE=db and BOT_CREDENTIALS_JSON empty. No secrets belong in git, PRs, or smoke output.

## Isolation and Gate 7 smoke

Before registry tools become real, run gateway deny-before-AA, runtime HTTP validation, and database isolation tests: same client, other client, other client's brief, revoked grant (including replay), suspended bot, and anon/authenticated execution denial. Check volatility and function ACLs. Retain production/workflow regressions.

After Sec review and Alex/CoS-controlled staging/production migration and deployment:

1. Authenticate with CDM token; discovery shows eight delivery tools and existing granted real content/workflow tools; stubs hidden.
2. List clients without client_id; follow cursor; verify only granted Harbour/fixture IDs. Other-client calls fail.
3. Read client/status/plan/blockers/next action/health. Confirm source checklist, deadlines and honest unknown health.
4. Create task with stable idempotency key, title and optional due_date/brief_id; retry same input, verify same task ID. Change payload with same key: conflict. Verify task appears in plan/status.
5. Read content.get_production_status for a Harbour brief; verify handoff and human approval boundary.
6. Create gateway approval ticket, list pending approvals and activity. record_decision remains denied.
7. On fixture only, revoke grant and suspend bot: reads/writes/replays denied, list excludes revoked clients. Restore through authorized ops.

Sec review questions: accept unassigned ledger semantics and projection thresholds; confirm scoped output fields and list locking. Ping Sec on draft PR before merge. Live Gate 7 is pending the operations smoke, even if local tests pass.

## Local validation

Gateway: 67 tests. Runtime: 343 tests, including 13 Phase 7 HTTP-to-PGlite tests applying migration 71 with RLS enabled. Both TypeScript checks and development builds pass. These fixtures do not establish production token/grant readiness or replace Harbour smoke.
