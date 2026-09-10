import { z } from "zod";
import { resultSchema, type Tool } from "../shared/types.js";
const domains: Record<string, string> = {
  delivery:
    "list_clients get_client get_status get_plan get_blockers get_next_action create_task get_client_health",
  campaign: "list get create update get_status request_approval",
  content:
    "list_ideas generate_ideas get_idea select_idea generate_brief get_brief assign_production get_production_status submit_asset request_revision request_approval approve_asset create_repurpose_plan queue_distribution record_publication get_performance",
  conversion:
    "list_pages get_page create_page generate_structure generate_copy request_approval get_performance",
  sales_agents:
    "generate_config list get create update_knowledge update_qualification_rules test deploy get_conversations",
  pipeline:
    "list_leads get_lead get_stalled_leads update_stage create_followup get_pipeline_summary record_sale",
  proof: "search get create attach_asset get_for_avatar get_for_claim",
  attribution:
    "get_campaign_performance get_content_performance get_revenue_attribution get_conversion_funnel generate_report",
  economics:
    "get_client_economics get_campaign_economics get_costs get_revenue get_roi",
  workflow:
    "create_task assign_task get_task list_tasks complete_task create_approval get_pending_approvals record_decision get_activity",
  engineering:
    "create_issue get_issue get_release_status get_deployment_status",
  security:
    "get_system_status get_open_findings create_finding get_incident_status",
};
export const orchestrationTools = new Set([
  "workflow.list_tasks",
  "workflow.get_task",
  "workflow.create_task",
  "workflow.assign_task",
  "workflow.complete_task",
  "campaign.list",
  "campaign.get",
  "campaign.get_status",
  "attribution.get_campaign_performance",
]);
const id = z.string().uuid();
const text = z.string().min(1).max(4000);
const leadStage = z.enum([
  "lead",
  "conversation",
  "qualified_conversation",
  "appointment",
  "qualified_appointment",
  "shown",
  "sale",
  "cash",
  "lost",
]);
const salesAgentRole = z.enum([
  "inbound_qualifier",
  "appointment_setter",
  "nurture",
  "reactivation",
  "closer_assist",
]);
const qualificationStep = z
  .object({
    question: z.string().trim().min(1).max(300),
    why: z.string().trim().min(1).max(300).optional(),
    good_answer: z.string().trim().min(1).max(300).optional(),
    disqualifier: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
const objection = z
  .object({
    objection: z.string().trim().min(1).max(300),
    response: z.string().trim().min(1).max(2000),
  })
  .strict();
const transcriptTurn = z
  .object({
    role: z.enum(["lead", "agent"]),
    text: z.string().trim().min(1).max(2000),
  })
  .strict();
export const registry: Tool[] = Object.entries(domains).flatMap(
  ([domain, actions]) =>
    actions.split(" ").map((action) => {
      const name = `${domain}.${action}`;
      const read = /^(get|list|search)/.test(action);
      const approval = [
        // Sec Phase 9b/10: content.approve_asset and content.queue_distribution
        // moved off this gateway-level reviewer gate when they went real, to
        // match their sibling Bot content writes (MEDIUM risk, AA-RPC-only
        // authorization). See each phase's design note Sec question before
        // restoring either here.
        "deploy",
        "record_sale",
        "record_decision",
      ].includes(action);
      const fields: Record<string, z.ZodType> = { client_id: id };
      if (!read) fields.idempotency_key = z.string().min(8).max(128);
      if (read) {
        fields.limit = z.number().int().min(1).max(100).default(25);
      }
      // Stable business identifiers; opaque arbitrary payloads are deliberately absent.
      const resource: Record<string, string> = {
        delivery: "client",
        campaign: "campaign",
        content: action.includes("idea")
          ? "idea"
          : action.includes("brief")
            ? "brief"
            : "asset",
        conversion: "page",
        sales_agents: "sales_agent",
        pipeline: "lead",
        proof: "proof",
        workflow: "task",
        engineering: "issue",
        security: "finding",
        attribution: "campaign",
        economics: "campaign",
      };
      if (
        domain !== "delivery" &&
        ![
          "list",
          "list_clients",
          "get_pending_approvals",
          "get_activity",
        ].includes(action)
      )
        fields[`${resource[domain]}_id`] = id.optional();
      if (!read) {
        fields.summary = text.optional();
        fields.title = z.string().min(1).max(200).optional();
      }
      if (domain === "delivery") {
        delete fields.limit;
        if (action === "list_clients") {
          delete fields.client_id;
          fields.limit = z.number().int().min(1).max(100).default(25);
          fields.after = id.optional();
        }
        if (action === "create_task") {
          fields.title = z.string().trim().min(1).max(200);
          fields.due_date = z.iso.date().optional();
          fields.brief_id = id.optional();
        }
      }
      if (name === "content.generate_brief") {
        delete fields.brief_id;
        fields.idea_id = id;
      }
      if (name === "content.list_ideas") {
        delete fields.idea_id;
        fields.status = z
          .enum(["draft", "approved", "rejected", "briefed"])
          .optional();
      }
      if (name === "content.get_idea") {
        fields.idea_id = id;
        delete fields.limit;
      }
      if (name === "content.get_brief") {
        delete fields.limit;
        fields.idea_id = id.optional();
      }
      if (name === "content.get_production_status") {
        delete fields.limit;
        fields.idea_id = id.optional();
        fields.brief_id = id.optional();
      }
      if (name === "content.request_revision") {
        fields.summary = text;
        fields.idea_id = id.optional();
        fields.brief_id = id.optional();
        delete fields.title;
      }
      if (name === "content.request_approval") {
        fields.idea_id = id.optional();
        fields.brief_id = id.optional();
        delete fields.title;
      }
      if (name === "content.select_idea") {
        fields.idea_id = id;
        delete fields.title;
        delete fields.summary;
      }
      if (name === "content.approve_asset") {
        fields.asset_id = id;
        fields.decision = z.enum(["approved", "rejected"]);
        delete fields.title;
      }
      if (name === "content.queue_distribution") {
        fields.asset_id = id;
        fields.scheduled_for = z.iso.date();
        fields.channel = z.enum(["organic", "paid"]).optional();
        delete fields.title;
        delete fields.summary;
      }
      if (name === "content.record_publication") {
        delete fields.asset_id;
        fields.schedule_id = id;
        fields.status = z.enum(["published", "failed"]);
        fields.external_id = z.string().min(1).max(200).optional();
        fields.failure_reason = z.string().min(1).max(4000).optional();
        delete fields.title;
        delete fields.summary;
      }
      if (name === "content.create_repurpose_plan") {
        fields.asset_id = id;
        fields.approval_execution_id = z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
          .optional();
        fields.formats = z
          .array(
            z.enum([
              "reel",
              "short",
              "carousel",
              "quote_graphic",
              "text_post",
              "email",
              "ad_variation",
              "story_clips",
            ]),
          )
          .min(1)
          .max(6);
        delete fields.title;
        delete fields.summary;
      }
      // Phase 11: exact field shapes for the six Sales Ops tools realized this
      // phase. pipeline.record_sale and the sales_agents write/deploy/test
      // actions deliberately get no override here — they stay on the generic
      // shape below and remain stub (Alex CLEAR #5 / SEC_BAR #2).
      if (name === "pipeline.list_leads") {
        delete fields.lead_id;
        fields.stage = leadStage.optional();
      }
      if (name === "pipeline.get_lead") {
        fields.lead_id = id;
        delete fields.limit;
      }
      if (name === "pipeline.get_stalled_leads") {
        delete fields.lead_id;
        fields.days = z.number().int().min(1).max(365).optional();
      }
      if (name === "pipeline.get_pipeline_summary") {
        delete fields.lead_id;
        delete fields.limit;
      }
      if (name === "pipeline.update_stage") {
        fields.lead_id = id;
        // sale/cash excluded: money-adjacent, deferred to pipeline.record_sale
        // (see registry/tools.ts realPipeline comment and the migration 76
        // RPC's hard-coded invalid_stage guard).
        fields.stage = leadStage.exclude(["sale", "cash"]);
        fields.note = text.optional();
        delete fields.summary;
        delete fields.title;
      }
      if (name === "pipeline.create_followup") {
        fields.lead_id = id;
        fields.next_action = z.string().trim().min(1).max(500);
        fields.next_action_due = z.iso.date().optional();
        delete fields.summary;
        delete fields.title;
      }
      if (name === "sales_agents.list") {
        delete fields.sales_agent_id;
      }
      if (name === "sales_agents.get") {
        fields.sales_agent_id = id;
        delete fields.limit;
      }
      if (name === "sales_agents.get_conversations") {
        fields.sales_agent_id = id.optional();
      }
      // Phase 11b: factory writes realized this phase (SEC_BAR #3). deploy
      // deliberately gets no override here -- it stays on the generic shape
      // below and remains stub (Alex CLEAR #5 / SEC_BAR #4).
      if (name === "sales_agents.generate_config") {
        delete fields.sales_agent_id;
        delete fields.summary;
        delete fields.title;
        fields.role = salesAgentRole;
      }
      if (name === "sales_agents.create") {
        delete fields.sales_agent_id;
        delete fields.summary;
        delete fields.title;
        fields.role = salesAgentRole;
        fields.name = z.string().trim().min(1).max(200);
        fields.purpose = z.string().trim().min(1).max(4000);
      }
      if (name === "sales_agents.update_knowledge") {
        fields.sales_agent_id = id;
        delete fields.summary;
        delete fields.title;
        fields.objections = z.array(objection).min(1).max(30).optional();
        fields.guardrails = z.string().trim().min(1).max(4000).optional();
        fields.greeting = z.string().trim().min(1).max(2000).optional();
      }
      if (name === "sales_agents.update_qualification_rules") {
        fields.sales_agent_id = id;
        delete fields.summary;
        delete fields.title;
        fields.qualification = z.array(qualificationStep).min(1).max(20);
      }
      if (name === "sales_agents.test") {
        fields.sales_agent_id = id;
        delete fields.summary;
        delete fields.title;
        fields.transcript = z.array(transcriptTurn).min(1).max(60);
      }
      if (name === "workflow.create_approval") {
        fields.summary = text;
      }
      if (name === "workflow.record_decision") {
        fields.approval_id = id;
        fields.decision = z.enum(["approved", "rejected"]);
      }
      const orchestration = orchestrationTools.has(name);
      if (orchestration) {
        for (const key of Object.keys(fields)) delete fields[key];
        fields.client_id = id;
        if (!read) fields.idempotency_key = z.string().min(8).max(128);
        if (["list", "list_tasks"].includes(action)) {
          fields.limit = z.number().int().min(1).max(100).default(25);
          fields.after = id.optional();
        } else if (action !== "create_task")
          fields[domain === "workflow" ? "task_id" : "campaign_id"] = id;
        if (action === "create_task") {
          fields.title = z.string().trim().min(1).max(200);
          fields.summary = text.optional();
        }
        if (action === "assign_task")
          fields.assignee = z
            .string()
            .regex(/^(bot_[a-z0-9_]{1,60}|member:[0-9a-fA-F-]{36})$/);
        if (domain === "attribution") {
          fields.start_date = z.iso.date().optional();
          fields.end_date = z.iso.date().optional();
        }
      }
      const realContent = new Set([
        // Sec Phase 5 #6: isolation tests must stay green before adding a name.
        "content.list_ideas",
        "content.get_idea",
        "content.generate_brief",
        "content.get_brief",
        "content.request_revision",
        "content.get_production_status",
        "content.create_repurpose_plan",
        "content.request_approval",
        // Sec Phase 9b: bot_production only, enforced by allowed() below, not
        // by this set (bot_marketing's content.* wildcard also matches these
        // names; the hard per-tool gate in permissions.ts is the real control).
        "content.select_idea",
        "content.approve_asset",
        // Sec Phase 10: bot_distribution only, enforced by allowed() below,
        // not by this set (bot_production's content.* wildcard also matches
        // these names; the hard per-tool gate in permissions.ts is the real
        // control).
        "content.queue_distribution",
        "content.record_publication",
      ]);
      // Sec Phase 11 #7: isolation tests must stay green before adding a
      // name. record_sale stays out of realPipeline (Alex CLEAR #5 / SEC_BAR
      // #2) — it remains stub.
      const realPipeline = new Set([
        "pipeline.list_leads",
        "pipeline.get_lead",
        "pipeline.get_stalled_leads",
        "pipeline.get_pipeline_summary",
        "pipeline.update_stage",
        "pipeline.create_followup",
      ]);
      // Sec Phase 11b #7: isolation tests (Phase 11b block) must stay green
      // before adding a name. sales_agents.deploy stays out of this set
      // (Alex CLEAR #5 / SEC_BAR #4) — it remains stub, CRITICAL, approval.
      const realSalesAgents = new Set([
        "sales_agents.list",
        "sales_agents.get",
        "sales_agents.get_conversations",
        "sales_agents.generate_config",
        "sales_agents.create",
        "sales_agents.update_knowledge",
        "sales_agents.update_qualification_rules",
        "sales_agents.test",
      ]);
      const implementation =
        orchestration ||
        domain === "delivery" ||
        realContent.has(name) ||
        realPipeline.has(name) ||
        realSalesAgents.has(name) ||
        [
          "workflow.get_pending_approvals",
          "workflow.get_activity",
          "workflow.create_approval",
        ].includes(name)
          ? "real"
          : "stub";
      return {
        name,
        domain,
        description: `${action.replaceAll("_", " ")} in AA ${domain.replaceAll("_", " ")}. ${implementation === "stub" ? "Contract only; AA adapter not implemented." : ""}`,
        input: z.object(fields).strict(),
        output: resultSchema,
        risk:
          action === "deploy"
            ? "CRITICAL"
            : approval
              ? "HIGH"
              : read || action === "generate_brief"
                ? "LOW"
                : "MEDIUM",
        permissions: [name],
        approval,
        action: read ? "read" : "write",
        reversible: ![
          "deploy",
          "queue_distribution",
          "record_sale",
          "approve_asset",
          "record_publication",
        ].includes(action),
        audit: "required",
        implementation,
        dependency: orchestration
          ? "Scoped AA orchestration business API"
          : domain === "delivery"
            ? "Scoped AA delivery business API"
            : realContent.has(name)
              ? "Scoped AA content business API"
              : realPipeline.has(name)
                ? "Scoped AA pipeline business API"
                : realSalesAgents.has(name)
                  ? "Scoped AA sales_agents business API"
                  : implementation === "real"
                    ? "Gateway control store"
                    : `Scoped AA ${domain} business API`,
      } satisfies Tool;
    }),
);
