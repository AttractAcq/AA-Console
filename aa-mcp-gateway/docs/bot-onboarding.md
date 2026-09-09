# Bot Onboarding Contract

Activate one bot at a time. Reference: `../src/onboarding/chief-of-staff.ts`.
Second reference bot (Phase 9): `../src/onboarding/marketing-director.ts`, an
intentional allowlist rather than a wildcard grant — see
`phase-9-marketing-director.md`. Configuration is a testable declaration, not
authority to issue credentials or grants.

1. Create or verify the bot identity using the Phase 3–4 auth runbook.
2. Issue a bot-specific bearer only if missing; retain it in the approved secret store.
3. Define explicit tool patterns and client UUID grants; CoS reference exactly matches its existing matrix.
4. Validate discovery against config reads/writes; stubs hidden and record_decision absent.
5. Validate allowed reads using Harbour and each other explicitly granted client; paginate all lists.
6. Validate writes on an approved tracking fixture: create/replay, assign/replay, list/get, complete/replay; changed key payload conflicts.
7. Validate other-client, other-client resource, revoked grant, suspended bot denial. Local SQL suite also denies anon/authenticated execution.
8. Validate forbidden domains absent and calls denied before AA, including record_decision.
9. Configure Harbour with stdio mcp-remote and a private header file, using the reference args. Header material must use the same locally validated format/version as Production/CDM. Never paste tokens into chat or CLI arguments.
10. Run steps 4–9 through the connector, record sanitized counts, client IDs, tool results, versions and timestamp. Local config/route isolation tests support these steps but do not replace live connector evidence.
11. Remove temporary secret material; keep the connector's required persistent header file only in the approved secret location with mode 0600. Do not remove a file still required by a live connector.
12. Mark rollout ACTIVE only after Sec/release approval and successful live evidence. Database identity status alone is not Gate closure.

## CoS readiness / next bot

CoS token and Harbour grant are unverified locally; Alex/CoS owns inspection and any
missing issuance after review. Follow `phase-3-4-bot-auth-rls.md` administration steps.
Do not rotate Production/CDM. Production migration and Railway deployment are release
steps for Alex via CoS. No coding-agent production SQL is part of this contract.

Marketing Director (Phase 9) instantiates its own locked 15-read/8-write allowlist,
fixtures and forbidden cases (including a hard deny on `content.approve_asset` and
withholding `delivery.list_clients`), then runs the same steps via Gate 9
(`npm run smoke:marketing`, `scripts/marketing-onboarding-smoke.ts`). Do not provision
other bots upfront. `campaign.*` writes and other FUTURE-listed tools remain hidden
stubs; subsequent capability implementations require their own isolation review.
Escalation pings go through Alex's Grok CoS chat; MCP adds no email/SMS/Slack sender.

## Executable Harbour suite (steps 4–10)

Run `npm run smoke:onboarding -- /private/path/fixtures.json /private/path/headers`
from aa-mcp-gateway after Alex's release. The header file must be private and the
installed mcp-remote version must support the established --header-file pattern.
The suite uses stdio, checks discovery, reads every granted client, creates/assigns/
completes one tracking fixture per client, verifies replay and isolation, and prints
only sanitized PASS/FAIL evidence. It does not issue/revoke tokens or alter grants.
Local SQL tests supply suspended/revoked identity and execute-privilege coverage;
never suspend a live bot just to run this smoke.

Nonsecret fixture JSON shape:

```json
{
  "clients": [{"client_id": "<Harbour UUID>", "campaign_id": "<Harbour campaign UUID>"}],
  "denied_client_id": "<ungranted client UUID>",
  "denied_task_id": "<task owned by that ungranted client>",
  "denied_campaign_id": "<campaign owned by that ungranted client>",
  "assignee": "bot_client_delivery"
}
```

Include every granted client, with an existing campaign. Missing fixtures fail the
Gate; do not create fake campaigns or fabricate metrics. After an interrupted suite,
reconcile its `Gate 8 onboarding fixture` tasks using workflow.list_tasks and complete
them. Operator evidence must also record temporary-secret cleanup (11) and the human
release/activation decision (12).

Marketing (Gate 9) runs its own suite (`npm run smoke:marketing -- fixtures.json
headers`, `scripts/marketing-onboarding-smoke.ts`) because it smokes real writes
(`content.generate_brief`, `content.request_revision`, `content.request_approval`,
`content.create_repurpose_plan`, workflow task actions, `workflow.create_approval`)
against disposable fixtures, not just tracking tasks, and asserts exact discovery
set equality plus forbidden-domain denial of `content.approve_asset` and
`delivery.list_clients`. Its nonsecret fixture shape is documented in
`phase-9-marketing-director.md`.
