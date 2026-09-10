# Phase 11b — Sales Agent Factory (Codex / Claude Code brief)

**Repo:** `AttractAcq/AA-Console`  
**Branch from:** current `main` (post Phase 11 / Gate 11 PASS / mig **76**)  
**Executor:** Claude Code or Codex on Alex Mac — **not** Cursor cloud agents  
**Bring results back to:** AA Chief of Staff  
**Status:** DRAFT for Alex review — **do not implement until Alex CLEAR**  
**bot_id (primary):** `bot_sales_ops` (control / supervise factory — already live from Phase 11)  
**Related (secondary, optional Gate slice):** Eng Ops deploy/infra pieces — **only if** Eng bot already exists; otherwise Console/Admin human path + **document Eng allowlist for later**

---

## Locked architecture (Alex 2026-09-10) — do not reinterpret

| Layer | Role | Phase |
| --- | --- | --- |
| **Sales Ops** | Control layer — pipeline CRM loop (lead → stage → follow-up → visibility) | **Phase 11 DONE** (mig 76 / Gate 11 PASS). **Do NOT re-build pipeline ops in 11b.** |
| **Sales Agents** | **Per-client** execution surfaces: inbound qualifier, appointment setter, nurture, reactivation, closer-assist. **NOT** one global AA sales bot. | 11b+ |
| **Sales Agent Factory** | Generates **CLIENT SALES AGENT CONFIG** from Market / Avatar / Offer / Brand / Campaign intel + qualification rules + sales process + objection library + Sales RAG; persists config; deploys to channels (live connect may defer). Lives on **Admin → client → Sales page**. Sales Ops + Eng must be able to build agents. | **This phase (11b)** |

Roadmap position: **after Phase 11 (done), before Phase 12 Admin continuum.**

Architecture bar (unchanged):  
`Bot → Skill → AA MCP tool → Workflow/Policy Engine → External MCP/API`

---

## Goal / Gate 11b success criteria

Ship the **minimum viable Sales Agent Factory** slice:

**intel + rules → generate CLIENT SALES AGENT CONFIG → persist → list/get/update on Admin client Sales page → (optional) sandbox test**

Prove factory **config generation + durable AA state + Console Sales hooks**, supervised by Sales Ops — **not** a new global bot, **not** a second pipeline CRM, **not** mandatory live Meta/WhatsApp OAuth in this gate.

Gate **11b** success (Harbour Dental smoke):

1. Exact discovery set equality (`actual === expected`) for `bot_sales_ops` **after** additive factory grants (Phase 11 set + Gate 11b additions)
2. Allowed **factory reads** succeed on Harbour (`sales_agents.list` / `get` / `get_conversations` — already Gate 11)
3. Allowed **factory writes** succeed with durable AA state + audit/activity:
   - `sales_agents.generate_config` (or equivalent — see proposal)
   - `sales_agents.create`
   - `sales_agents.update_knowledge`
   - `sales_agents.update_qualification_rules`
   - `sales_agents.test` (sandbox / dry-run — no live channel send)
4. Admin **client Sales page** can list / create / update agent config for Harbour (UI hooks wired to same AA tables/RPCs)
5. Cross-client / ungranted client → DENY; agent rows never leak across clients
6. Forbidden domains absent + DENY if called (finance/security/deploy/bank, pipeline rebuild nonsense, content decide/distribution, campaign writes, `workflow.record_decision`, `can_access_client`)
7. Isolation tests green **before** unstubbing any new RPCs
8. Design note first; **no** merge / prod mig / Railway / token / connector until **Sec APPROVE + Alex CLEAR**
9. Live channel OAuth / webhook / Meta / WhatsApp **deferred to Phase 11c** if hard — document gap honestly; Gate 11b must still PASS on config + Console + test-without-live-send
10. Other live bots’ grants unchanged except where 11b hard-denies overlap names; **pipeline.*** surface from Phase 11 unchanged in behavior

Reference:
- Bot Onboarding Contract: `aa-mcp-gateway/docs/bot-onboarding.md`
- Phase 11 design / onboarding: `aa-mcp-gateway/docs/phase-11-sales-ops.md`, `src/onboarding/sales-ops.ts`
- Registry names (Phase 11 truth): `sales_agents.list|get|create|update_knowledge|update_qualification_rules|test|deploy|get_conversations`
- Admin UI: **client Sales page** (admin view) is where agents live and (later) connect to channels

---

## Current AA truth (do not invent around this)

| Surface | State |
| --- | --- |
| Sales Ops / pipeline | **Shipped** Phase 11 — leave alone except additive factory grants on `bot_sales_ops` |
| `sales_agents.*` reads on Sales Ops | `list`, `get`, `get_conversations` already in Gate 11 discovery |
| `sales_agents.*` writes / deploy / test | Registry may exist; Phase 11 kept **FUTURE/stub / non-discoverable** — **11b realizes factory subset** |
| `sales_agents.deploy` | Approval-class in gateway (`tools.ts`) — default **out of Gate 11b discovery** unless Alex CLEARs Eng path |
| `pipeline.record_sale` | Still FUTURE — **not** 11b |
| AA tables | Prefer existing sales_agents / client config tables (mig ~67 era). **Discover real vs stub** in design note; add only what Gate 11b needs |
| Admin Sales page | Target home for agent list/create/update + channel connect UI; channel OAuth may be shell-only in 11b |
| Auth bars | `require_active_bot` + `require_bot_client_grant` FOR SHARE; never `can_access_client`; no Bot SQL; client isolation |

Phase 11b must **realize durable Bot-safe factory config generate + persist + Console hooks**. Do **not** pretend live Meta/WhatsApp messaging exists if it does not. If deploy / channel connect are not safe yet, keep them **stub/11c** and document the gap.

---

## Capability classes (proposed after Phase 11b)

### A. Autonomous reads (Sales Ops — already Gate 11; keep)

- `sales_agents.list`, `sales_agents.get`, `sales_agents.get_conversations`
- Pipeline + workflow suite from Phase 11 — **unchanged**

### B. Factory writes (Sales Ops supervise — Gate 11b realize)

Prefer **existing registry names**; add **one** explicit factory tool only if create cannot express generate-from-intel cleanly.

1. **`sales_agents.generate_config`** — **NEW (recommended)** — server-side compose CLIENT SALES AGENT CONFIG from Market/Avatar/Offer/Brand/Campaign intel + qualification defaults + sales process + objection library + Sales RAG for **granted client only**. Returns draft config; does **not** require granting Sales Ops `campaign.*` / marketing write surfaces (intel join stays inside AA RPC).
2. **`sales_agents.create`** — persist new per-client agent config row (role/type: inbound_qualifier | appointment_setter | nurture | reactivation | closer_assist; bind `client_id`).
3. **`sales_agents.update_knowledge`** — update knowledge / RAG / objection library slice for that agent (client-scoped).
4. **`sales_agents.update_qualification_rules`** — update qualification rules for that agent (client-scoped).
5. **`sales_agents.test`** — sandbox / dry-run conversation or rule check; **no** live channel send; append-only audit.

Optional if Console needs a general field patch without knowledge/rules split:

- **`sales_agents.update`** — only if existing schema needs it; else fold into create + knowledge + rules tools and document.

### C. Eng / deploy (propose split — CLEAR)

| Tool | Proposed owner | Gate 11b |
| --- | --- | --- |
| `sales_agents.deploy` | **Eng Ops** (infra / channel bind) when Eng bot exists; else Admin human + stub | **Defer / non-discoverable** on Sales Ops by default |
| Channel OAuth / webhook / Meta / WhatsApp live send | Eng + Admin continuum / **11c** | **Out of Gate 11b** |

Sales Ops may **create + configure + test**; Eng (or human Admin) **deploys / connects channels**. If Alex wants Sales Ops to call deploy under approval-class, that is an explicit CLEAR — default **no**.

### D. Console / Admin (human)

- **Admin → client → Sales page:** list agents, create agent, edit config (knowledge, qualification, process, objections), show deploy/channel status (read-only or stub if 11c).
- Same AA RPCs / tables as Bot tools — no parallel shadow store.
- Sales Ops + Eng (and Admin humans) must be able to build agents; **never** widen via `can_access_client`.

### E. Stubs / FUTURE / 11c

- `sales_agents.deploy` (unless CLEAR)
- Live Meta / WhatsApp / SMS OAuth, webhooks, inbound message workers
- Runtime agent reply loops on live channels
- `pipeline.record_sale`
- New global `bot_sales` / single AA closer bot
- Broad marketing grant widen for factory intel (use server-side generate instead)

### F. Forbidden / hard-deny

See **Hard denies** below.

---

## Exact discovery set proposal (numbered) — for Alex CLEAR

Gate **must** use exact set equality, not approximate counts. **PROPOSAL — not locked until Alex CLEAR.**

**Baseline = Phase 11 Sales Ops discovery (17) + Gate 11b factory additions (5) = 22.**

```
# --- Phase 11 (unchanged) ---
1.  pipeline.list_leads
2.  pipeline.get_lead
3.  pipeline.get_stalled_leads
4.  pipeline.get_pipeline_summary
5.  pipeline.update_stage
6.  pipeline.create_followup
7.  sales_agents.list
8.  sales_agents.get
9.  sales_agents.get_conversations
10. workflow.get_pending_approvals
11. workflow.get_activity
12. workflow.list_tasks
13. workflow.get_task
14. workflow.create_task
15. workflow.assign_task
16. workflow.complete_task
17. workflow.create_approval
# --- Phase 11b factory additions ---
18. sales_agents.generate_config
19. sales_agents.create
20. sales_agents.update_knowledge
21. sales_agents.update_qualification_rules
22. sales_agents.test
```

**Proposed discovery tool count: 22** (Phase 11 = 17 + factory = 5)

Fail if any expected tool missing **or** any unexpected tool appears.  
Absent by design: `sales_agents.deploy`, `pipeline.record_sale`, `proof.*`, content decide/distribution, campaign writes, finance/security/deploy/bank, Eng-only infra, `workflow.record_decision`.

If Alex rejects `generate_config` as a separate name: fold generate-from-intel into `sales_agents.create` (flag/mode) and discovery count becomes **21** — document in design note.

---

## Bot surface allowlist (proposal)

| Bot | Factory-related tools | Notes |
| --- | --- | --- |
| **`bot_sales_ops`** | Phase 11 set + `generate_config`, `create`, `update_knowledge`, `update_qualification_rules`, `test` | Supervise factory; client-granted only |
| **`bot_engineering` / Eng Ops** (if present) | `sales_agents.deploy` (+ future channel infra) | **Not** Gate 11b discovery on Sales Ops; document for Eng onboarding |
| Production / CDM / CoS / Marketing / Distribution | **No** new `sales_agents.*` writes | Unchanged |
| Any bot | **No** bank / finance / `can_access_client` | Forever |

---

## Alex CLEAR defaults (checkbox — confirm or edit before implement)

- [ ] **Harbour-only** first for any new factory write smoke / grants (same as prior phases)
- [ ] **Config generate + persist + Console Sales page hooks** (list/create/update agent config) **before** live Meta/WhatsApp connect
- [ ] **Sales Ops** gets factory reads/writes that supervise (`generate_config` + `create` + knowledge + rules + `test`); **exact allowlist** additive on `bot_sales_ops` only
- [ ] **Eng Ops** gets deploy/infra pieces (or human Admin stub) — **`sales_agents.deploy` not** on Sales Ops discovery by default
- [ ] Additive migration next free after 76 → **77**
- [ ] **Defer live channel OAuth/webhook** to **Phase 11c**; Gate 11b documents gap
- [ ] Design note **first**; isolation green **before** unstub
- [ ] **No merge / Railway / prod mig apply / token / connector** until Sec APPROVE + Alex CLEAR
- [ ] No bank; client isolation; **never** `can_access_client` on new RPCs
- [ ] Do **not** rebuild pipeline ops; do **not** invent a global AA sales bot

---

## Hard denies

Absent from discovery **and** denied if called:

- `finance.*`, `economics.*`, bank transfers / payment settlement, unrestricted money movement
- `security.*`, `deploy.*`, `infra.*`, `secrets.*`, `admin.*` (except intentional Eng deploy tool name if separately granted later)
- `workflow.record_decision` (forever hard-deny for all Bots)
- Content decide / distribution tools; Marketing campaign **writes**
- `pipeline.record_sale` until explicit CLEAR
- `sales_agents.deploy` on Sales Ops until explicit CLEAR (default Eng/11c)
- Re-implementing / widening pipeline wildcards; inventing `bot_sales` global closer
- Cross-client agent read/write; SQL from Bots; **never** `can_access_client` on new RPCs
- No accidental `*.` widen for other bots; gateway deny-before-AA
- Live channel send from `sales_agents.test`

---

## Auth / Sec bar checklist (9 items)

1. New factory write RPCs callable only by intended bot(s) — hard-coded bot check where appropriate (`bot_sales_ops` for generate/create/knowledge/rules/test; Eng-only for deploy if realized)
2. `require_active_bot` + `require_bot_client_grant` FOR SHARE; resource `client_id` + agent ownership match
3. All agent rows scoped to granted client; reject cross-client `agent_id` / intel bleed
4. `generate_config` pulls intel **server-side** for that client only — no Marketing write grants required
5. Append-only audit on generate/create/knowledge/rules/test (`who/when/client/agent/decision`)
6. Isolation tests green **before** unstub: same-client / other-client id / other-client resource / suspended / revoked / anon+auth denied
7. Gateway deny-before-AA; exact discovery set; no wildcard widen for other bots; Phase 11 pipeline behavior preserved
8. `sales_agents.test` cannot trigger live channel egress; deploy/OAuth out of band / 11c
9. No merge / Railway / token / connector until **Sec APPROVE + Alex CLEAR**

---

## Implementation order

1. **Design note first:** `aa-mcp-gateway/docs/phase-11b-sales-agent-factory.md`  
   (factory vs Sales Ops split, config schema, intel sources, Admin Sales page mapping, stub honesty for deploy/channels → 11c, isolation plan, Gate 11b plan)
2. Extend onboarding config `aa-mcp-gateway/src/onboarding/sales-ops.ts` (additive exact grants; keep Phase 11 forbiddens)
3. Additive migration (**77**): Bot-safe factory RPCs + permission rows for `bot_sales_ops` only (+ Eng deploy grant **only if** CLEAR and Eng bot exists)
4. Admin **client Sales page** hooks: list / create / update agent config against same AA store
5. Make proposed factory tools **real** (or document already-real); isolation green before unstub
6. Gateway policy/registry/docs/tests + `smoke:sales-agent-factory` / Gate 11b script (Harbour)
7. Draft PR — **no merge/deploy**; note **11c** for live channels

---

## Gate 11b — live E2E (Harbour)

Happy path:

1. Sales Ops lists existing agents for Harbour (may be empty)
2. Calls `sales_agents.generate_config` for Harbour (draft from intel + defaults)
3. `sales_agents.create` persists per-client agent (pick one role, e.g. inbound_qualifier)
4. Updates knowledge + qualification rules (real writes)
5. Runs `sales_agents.test` sandbox (no live send)
6. Admin client Sales page shows the agent; human can edit config fields
7. CoS or Sales Ops reads activity via allowed tools

Negative tests:

| Case | Expect |
| --- | --- |
| Correct client (Harbour) | PASS |
| Wrong client / ungranted | DENY |
| Cross-client agent_id | DENY |
| `sales_agents.deploy` / live channel send | DENY / absent (unless CLEAR) |
| `pipeline.record_sale` / finance / bank | DENY / absent |
| Content decide / distribution / campaign writes | DENY / absent |
| `workflow.record_decision` | absent / DENY |
| `can_access_client` path | never used |
| Exact discovery set equality (22) | PASS |
| Audit attributes `bot_sales_ops` | PASS |

---

## Out of scope

- Rebuilding Sales Ops pipeline CRM (Phase 11)
- Live Meta / WhatsApp / SMS OAuth, webhooks, inbound workers (**→ 11c**)
- Making `sales_agents.deploy` real on Sales Ops without CLEAR
- `pipeline.record_sale` / payments / bank
- Global single AA sales bot
- Expanding Marketing / Production / Distribution / CoS / CDM grants
- Full Admin continuum (Phase 12), Finance / Sec bot onboarding
- External CRM sync (HubSpot/Salesforce) or dialer integrations
- Unblocking unrelated deferred smokes from other phases

---

## Deliver back to CoS (report-back format)

1. **PR URL** + **SHA**
2. Design note path + onboarding config path (`sales-ops.ts` delta)
3. **Migration #** (expect **77**)
4. **Exact discovery tool list** (final, post-CLEAR) + count
5. Admin Sales page paths / screens touched
6. Test counts (unit + isolation + Gate 11b) + fixture assumptions (Harbour client / agent ids)
7. Whether channel connect is stub-only (**11c** note)
8. Sec questions / gaps (`generate_config` vs fold-into-create; deploy owner; Eng bot present?)
9. **Ready-for-Sec:** yes/no

---

## Alex review questions (answer before CLEAR)

1. Confirm discovery **22** (Phase 11 + 5 factory tools), or fold `generate_config` into `create` (**21**)?
2. Confirm **`sales_agents.deploy` deferred** (Eng / 11c) — or Sales Ops approval-class in 11b?
3. Agent role enum for Gate 11b: all five (inbound_qualifier, appointment_setter, nurture, reactivation, closer_assist) or **Harbour inbound_qualifier-only** first?
4. Harbour-only first grant/smoke (recommended) — also Attract Acquisition?
5. Is Admin client Sales page already scaffolded, or does 11b include greenfield UI for list/create/update?
6. Any rename away from registry `sales_agents.*`, or stick to existing names + one new `generate_config`?
