import { z } from "zod";
import { resultSchema, type Tool } from "../shared/types.js";
const domains: Record<string, string> = {
  admin: "list_events get_event create_event update_event",
  delivery:
    "list_clients get_client get_status get_plan get_blockers get_next_action create_task get_client_health",
  campaign: "list get create update get_status request_approval plan provision launch get_readiness",
  content:
    "list_ideas generate_ideas get_idea select_idea generate_brief get_brief assign_production get_production_status submit_asset request_revision request_approval approve_asset create_repurpose_plan queue_distribution record_publication get_performance",
  conversion:
    "list_pages get_page create_page generate_structure generate_copy request_approval get_performance audit_page revise_page revert_page",
  sales_agents:
    "generate_config list get create update_knowledge update_qualification_rules test deploy attach_to_page set_deployment_enabled build get_conversations",
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
  brand: "get_profile",
  sites: "provision publish_page",
};
export const adminTools = new Set([
  "admin.list_events",
  "admin.get_event",
  "admin.create_event",
  "admin.update_event",
]);
export const financeReadTools = new Set([
  "economics.get_client_economics",
  "economics.get_campaign_economics",
  "economics.get_costs",
  "economics.get_revenue",
  "economics.get_roi",
  "attribution.get_revenue_attribution",
]);
export const engineeringTools = new Set([
  "engineering.create_issue",
  "engineering.get_issue",
  "engineering.get_release_status",
  "engineering.get_deployment_status",
]);
export const securityTools = new Set([
  "security.get_system_status",
  "security.get_open_findings",
  "security.create_finding",
  "security.get_incident_status",
]);
export const conversionTools = new Set([
  "conversion.list_pages",
  "conversion.get_page",
  "conversion.create_page",
  "conversion.generate_structure",
  "conversion.generate_copy",
  "conversion.request_approval",
  "conversion.get_performance",
  "conversion.audit_page",
  "conversion.revise_page",
  "conversion.revert_page",
]);
export const campaignExecutionTools = new Set([
  "campaign.create",
  "campaign.update",
  "campaign.request_approval",
  "campaign.plan",
  "campaign.provision",
  "campaign.launch",
  "campaign.get_readiness",
]);
export const attributionReportingTools = new Set([
  "attribution.get_conversion_funnel",
  "attribution.get_content_performance",
]);
export const brandTools = new Set(["brand.get_profile"]);
export const sitesTools = new Set(["sites.provision", "sites.publish_page"]);
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
      const approval =
        [
          // Sec Phase 9b/10: content.approve_asset and content.queue_distribution
          // moved off this gateway-level reviewer gate when they went real, to
          // match their sibling Bot content writes (MEDIUM risk, AA-RPC-only
          // authorization). See each phase's design note Sec question before
          // restoring either here.
          "deploy",
          "record_sale",
          "record_decision",
        ].includes(action) ||
        // Phase 16c: GitHub Pages provision/publish are irreversible public
        // writes. Use the tool name so campaign.provision stays ungated.
        name === "sites.provision" ||
        name === "sites.publish_page";
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
        brand: "brand",
        sites: "page",
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
      // Phase 16b: page attach / kill-switch / enqueue. deploy stays generic
      // + stub (Alex CLEAR: no live Meta/WhatsApp).
      if (name === "sales_agents.attach_to_page") {
        fields.sales_agent_id = id;
        fields.page_id = id;
        delete fields.summary;
        delete fields.title;
      }
      if (name === "sales_agents.set_deployment_enabled") {
        delete fields.sales_agent_id;
        fields.deployment_id = id;
        fields.enabled = z.boolean();
        delete fields.summary;
        delete fields.title;
      }
      if (name === "sales_agents.build") {
        fields.sales_agent_id = id;
        delete fields.summary;
        delete fields.title;
      }
      if (name === "proof.search") {
        delete fields.proof_id;
        fields.q = z.string().trim().min(1).max(400).optional();
        fields.media_type = z.enum(["image", "video", "text"]).optional();
        fields.proof_type = z
          .enum([
            "customer_result",
            "testimonial",
            "review",
            "case_study",
            "before_after",
            "stat",
            "credential",
            "award",
            "press",
            "process",
            "team_expertise",
            "customer_story",
          ])
          .optional();
      }
      if (name === "proof.get") {
        fields.proof_id = id;
        delete fields.limit;
      }
      if (name === "proof.get_for_avatar") {
        delete fields.proof_id;
        fields.avatar = z.string().trim().min(1).max(300);
        fields.limit = z.number().int().min(1).max(50).default(10);
      }
      if (name === "proof.get_for_claim") {
        delete fields.proof_id;
        fields.claim = z.string().trim().min(1).max(400);
        fields.limit = z.number().int().min(1).max(50).default(10);
      }
      if (name === "proof.create") {
        delete fields.proof_id;
        delete fields.summary;
        delete fields.title;
        fields.media_type = z.enum(["image", "video", "text"]);
        fields.title = z.string().trim().min(1).max(200).optional();
        fields.body = z.string().trim().min(1).max(8000).optional();
        fields.source = z.string().trim().min(1).max(500).optional();
        fields.storage_path = z.string().trim().min(1).max(500).optional();
        fields.claim = z.string().trim().min(1).max(400).optional();
        fields.evidence = z.string().trim().min(1).max(4000).optional();
        fields.avatar_relevance = z.string().trim().min(1).max(300).optional();
        fields.proof_type = z
          .enum([
            "customer_result",
            "testimonial",
            "review",
            "case_study",
            "before_after",
            "stat",
            "credential",
            "award",
            "press",
            "process",
            "team_expertise",
            "customer_story",
          ])
          .optional();
        fields.strength = z.enum(["high", "medium", "low"]).optional();
      }
      if (name === "proof.attach_asset") {
        fields.proof_id = id;
        fields.storage_path = z.string().trim().min(1).max(500);
        fields.brief_id = id.optional();
        delete fields.summary;
        delete fields.title;
      }
      if (name === "content.assign_production") {
        delete fields.asset_id;
        fields.brief_id = id;
        fields.route = z.enum(["ai", "human"]);
        fields.member_ids = z.array(id).min(1).max(20).optional();
        fields.due_date = z.iso.date().optional();
        fields.compensation = z.number().nonnegative().max(1_000_000).optional();
        fields.quality = z.enum(["low", "medium", "high"]).optional();
        fields.size = z.enum(["1024x1536", "1024x1024", "1536x1024"]).optional();
        delete fields.title;
        delete fields.summary;
      }
      if (name === "content.submit_asset") {
        delete fields.asset_id;
        fields.storage_path = z.string().trim().min(1).max(500);
        fields.media_type = z.enum(["image", "video", "text"]);
        fields.brief_id = id.optional();
        fields.assignment_id = id.optional();
        fields.title = z.string().trim().min(1).max(200).optional();
        delete fields.summary;
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
      if (domain === "economics" || name === "attribution.get_revenue_attribution") {
        for (const key of Object.keys(fields)) delete fields[key];
        fields.client_id = id;
        fields.start_date = z.iso.date().optional();
        fields.end_date = z.iso.date().optional();
        if (
          action === "get_campaign_economics" ||
          name === "attribution.get_revenue_attribution"
        ) {
          fields.campaign_id = id.optional();
          fields.limit = z.number().int().min(1).max(100).default(25);
        }
      }
      if (domain === "admin") {
        for (const key of Object.keys(fields)) delete fields[key];
        fields.client_id = id;
        if (!read) fields.idempotency_key = z.string().min(8).max(128);
        if (action === "list_events") {
          fields.limit = z.number().int().min(1).max(100).default(25);
          fields.after = id.optional();
          fields.status = z
            .enum(["scheduled", "completed", "cancelled"])
            .optional();
          fields.due_before = z.iso.datetime({ offset: true }).optional();
        } else if (action !== "create_event") fields.event_id = id;
        if (!read) {
          // Complete replacement of editable fields; no ambiguous JSON patch/null semantics.
          fields.title = z.string().trim().min(1).max(200);
          fields.notes = z.string().max(2000).nullable();
          fields.starts_at = z.iso.datetime({ offset: true });
          fields.ends_at = z.iso.datetime({ offset: true }).nullable();
          if (action === "create_event")
            fields.event_type = z.enum(["meeting", "reminder", "admin"]);
          else {
            fields.status = z.enum(["scheduled", "completed", "cancelled"]);
            fields.expected_version = z.number().int().min(1).max(2147483646);
          }
        }
      }
      if (domain === "engineering") {
        for (const key of Object.keys(fields)) delete fields[key];
        fields.client_id = id;
        if (action === "create_issue") {
          fields.idempotency_key = z.string().min(8).max(128);
          fields.title = z.string().trim().min(1).max(200);
          fields.notes = z.string().max(2000).nullable();
        } else if (action === "get_issue") {
          fields.issue_id = id;
        } else if (action === "get_release_status") {
          fields.limit = z.number().int().min(1).max(100).default(25);
          fields.after = id.optional();
          fields.page_id = id.optional();
        } else if (action === "get_deployment_status") {
          fields.limit = z.number().int().min(1).max(100).default(25);
          fields.after = id.optional();
          fields.job_id = id.optional();
        }
      }
      if (domain === "security") {
        for (const key of Object.keys(fields)) delete fields[key];
        fields.client_id = id;
        if (action === "create_finding") {
          fields.idempotency_key = z.string().min(8).max(128);
          fields.title = z.string().trim().min(1).max(200);
          fields.notes = z.string().max(2000).nullable();
          fields.severity = z.enum(["low", "medium", "high", "critical"]);
          fields.kind = z.enum(["finding", "incident"]).default("finding");
        } else if (action === "get_open_findings") {
          fields.limit = z.number().int().min(1).max(100).default(25);
          fields.after = id.optional();
          fields.finding_id = id.optional();
        } else if (action === "get_incident_status") {
          fields.limit = z.number().int().min(1).max(100).default(25);
          fields.after = id.optional();
          fields.incident_id = id.optional();
        }
      }
      // Phase 16: Page Builder verbs match Console PageBuilderPanel / polish.
      if (name === "conversion.list_pages") {
        delete fields.page_id;
        fields.after = id.optional();
        fields.page_type = z.enum(["landing", "offer"]).optional();
      }
      if (name === "conversion.get_page" || name === "conversion.get_performance") {
        fields.page_id = id;
        delete fields.limit;
      }
      if (name === "conversion.create_page") {
        delete fields.page_id;
        delete fields.summary;
        fields.title = z.string().trim().min(1).max(200);
        fields.brief = text;
        fields.page_type = z.enum(["landing", "offer"]).optional();
        fields.campaign_id = id.optional();
      }
      if (
        name === "conversion.generate_structure" ||
        name === "conversion.generate_copy" ||
        name === "conversion.audit_page"
      ) {
        fields.page_id = id;
        delete fields.title;
        delete fields.summary;
      }
      if (name === "conversion.request_approval") {
        fields.page_id = id;
        delete fields.title;
      }
      if (name === "conversion.revise_page") {
        fields.page_id = id;
        fields.finding_ids = z.array(id).min(1).max(50);
        delete fields.title;
        delete fields.summary;
      }
      if (name === "conversion.revert_page") {
        fields.page_id = id;
        fields.revision_number = z.number().int().min(1).max(2147483646);
        delete fields.title;
        delete fields.summary;
      }
      // Phase 16: Campaign Execution OS (client_campaigns). list/get/get_status
      // keep the orchestration shape below.
      if (name === "campaign.create") {
        delete fields.campaign_id;
        delete fields.summary;
        delete fields.title;
        fields.name = z.string().trim().min(1).max(200);
        fields.brief = text;
      }
      if (name === "campaign.update") {
        fields.campaign_id = id;
        delete fields.title;
        delete fields.summary;
        fields.name = z.string().trim().min(1).max(200).optional();
        fields.brief = text.optional();
        fields.status = z.enum(["complete", "cancelled"]).optional();
      }
      if (name === "campaign.request_approval") {
        fields.campaign_id = id;
        delete fields.title;
      }
      if (name === "campaign.plan" || name === "campaign.launch") {
        // launch marks client_campaigns.status=live only; no ad spend / paid channels.
        fields.campaign_id = id;
        delete fields.title;
        delete fields.summary;
      }
      if (name === "campaign.provision") {
        fields.campaign_id = id;
        fields.kind = z.enum(["landing_page", "sales_agent"]).optional();
        delete fields.title;
        delete fields.summary;
      }
      if (name === "campaign.get_readiness") {
        fields.campaign_id = id;
        delete fields.limit;
      }
      if (name === "attribution.get_conversion_funnel") {
        for (const key of Object.keys(fields)) delete fields[key];
        fields.client_id = id;
        fields.days = z.number().int().min(1).max(3650).default(30);
      }
      if (name === "attribution.get_content_performance") {
        for (const key of Object.keys(fields)) delete fields[key];
        fields.client_id = id;
        fields.limit = z.number().int().min(1).max(100).default(10);
      }
      if (domain === "brand") {
        for (const key of Object.keys(fields)) delete fields[key];
        fields.client_id = id;
      }
      if (domain === "sites") {
        for (const key of Object.keys(fields)) delete fields[key];
        fields.client_id = id;
        fields.idempotency_key = z.string().min(8).max(128);
        if (action === "provision") {
          fields.repo = z
            .string()
            .trim()
            .min(1)
            .max(80)
            .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
            .refine((value) => !value.includes("--"));
        } else {
          fields.page_id = id;
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
        // Sec Phase 16b: bot_production only (PRODUCTION_ONLY_TOOLS + RPC).
        "content.assign_production",
        "content.submit_asset",
      ]);
      // Sec Phase 16b: isolation tests must stay green before adding a name.
      // Bots never set usage_rights clearance — create forces not_cleared.
      const realProof = new Set([
        "proof.search",
        "proof.get",
        "proof.create",
        "proof.attach_asset",
        "proof.get_for_avatar",
        "proof.get_for_claim",
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
        "sales_agents.attach_to_page",
        "sales_agents.set_deployment_enabled",
        "sales_agents.build",
      ]);
      // Sec Phase 13: isolation tests must stay green before adding a name.
      // Money writes (pipeline.record_sale, payments, bank/Stripe/Xero) stay
      // out of this set and are not granted to bot_finance.
      const realEconomics = new Set([
        "economics.get_client_economics",
        "economics.get_campaign_economics",
        "economics.get_costs",
        "economics.get_revenue",
        "economics.get_roi",
      ]);
      const realAttributionRevenue = name === "attribution.get_revenue_attribution";
      const realAttributionReporting = attributionReportingTools.has(name);
      // Sec Phase 14: isolation tests must stay green before adding a name.
      // Railway writes, secret rotation and unrestricted deploy stay out.
      const realEngineering = new Set([
        "engineering.create_issue",
        "engineering.get_issue",
        "engineering.get_release_status",
        "engineering.get_deployment_status",
      ]);
      // Sec Phase 15: isolation tests must stay green before adding a name.
      // Secret dumps, destroy, Railway writes and unrestricted deploy stay out.
      const realSecurity = new Set([
        "security.get_system_status",
        "security.get_open_findings",
        "security.create_finding",
        "security.get_incident_status",
      ]);
      // Sec Phase 16: isolation tests must stay green before adding a name.
      // Production is not granted conversion. Sites are Phase 16c (Marketing/Sales Ops).
      const realConversion = conversionTools;
      const realCampaignExecution = campaignExecutionTools;
      const implementation =
        adminTools.has(name) ||
        orchestration ||
        domain === "delivery" ||
        realContent.has(name) ||
        realPipeline.has(name) ||
        realSalesAgents.has(name) ||
        realProof.has(name) ||
        realEconomics.has(name) ||
        realAttributionRevenue ||
        realAttributionReporting ||
        brandTools.has(name) ||
        sitesTools.has(name) ||
        realEngineering.has(name) ||
        realSecurity.has(name) ||
        realConversion.has(name) ||
        realCampaignExecution.has(name) ||
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
        ].includes(action) &&
        name !== "sites.provision" &&
        name !== "sites.publish_page",
        audit: "required",
        implementation,
        dependency:
          domain === "admin"
            ? "Scoped AA administrative events API"
            : orchestration
              ? "Scoped AA orchestration business API"
              : domain === "delivery"
                ? "Scoped AA delivery business API"
                : realContent.has(name)
                  ? "Scoped AA content business API"
                  : realPipeline.has(name)
                    ? "Scoped AA pipeline business API"
                    : realSalesAgents.has(name)
                      ? "Scoped AA sales_agents business API"
                      : realProof.has(name)
                        ? "Scoped AA proof business API"
                      : realEconomics.has(name)
                        ? "Scoped AA economics business API"
                        : realAttributionRevenue
                          ? "Scoped AA attribution business API"
                          : realAttributionReporting
                            ? "Scoped AA attribution business API"
                            : brandTools.has(name)
                              ? "Scoped AA brand business API"
                              : sitesTools.has(name)
                                ? "Scoped AA sites business API"
                          : realEngineering.has(name)
                            ? "Scoped AA engineering business API"
                          : realSecurity.has(name)
                            ? "Scoped AA security business API"
                            : realConversion.has(name)
                              ? "Scoped AA conversion business API"
                              : realCampaignExecution.has(name)
                                ? "Scoped AA campaign execution API"
                              : implementation === "real"
                                ? "Gateway control store"
                                : `Scoped AA ${domain} business API`,
      } satisfies Tool;
    }),
);
