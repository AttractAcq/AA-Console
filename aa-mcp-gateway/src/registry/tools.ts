import { z } from "zod";
import { resultSchema, type Tool } from "../shared/types.js";
const domains: Record<string, string> = {
  delivery:
    "list_clients get_client get_status get_plan get_blockers get_next_action create_task get_client_health",
  campaign: "list get create update get_status request_approval",
  content:
    "list_ideas generate_ideas get_idea select_idea generate_brief get_brief assign_production get_production_status submit_asset request_revision request_approval approve_asset create_repurpose_plan queue_distribution get_performance",
  conversion:
    "list_pages get_page create_page generate_structure generate_copy request_approval get_performance",
  sales_agents:
    "list get create update_knowledge update_qualification_rules test deploy get_conversations",
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
const id = z.string().uuid();
const text = z.string().min(1).max(4000);
export const registry: Tool[] = Object.entries(domains).flatMap(
  ([domain, actions]) =>
    actions.split(" ").map((action) => {
      const name = `${domain}.${action}`;
      const read = /^(get|list|search)/.test(action);
      const approval = [
        "approve_asset",
        "queue_distribution",
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
      if (name === "content.create_repurpose_plan") {
        fields.asset_id = id;
        fields.approval_execution_id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional();
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
      if (name === "workflow.create_approval") {
        fields.summary = text;
      }
      if (name === "workflow.record_decision") {
        fields.approval_id = id;
        fields.decision = z.enum(["approved", "rejected"]);
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
      ]);
      const implementation =
        realContent.has(name) ||
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
        ].includes(action),
        audit: "required",
        implementation,
        dependency:
          realContent.has(name)
            ? "Scoped AA content business API"
            : implementation === "real"
              ? "Gateway control store"
              : `Scoped AA ${domain} business API`,
      } satisfies Tool;
    }),
);
