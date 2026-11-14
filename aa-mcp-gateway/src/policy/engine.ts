import { createHash, randomUUID } from "node:crypto";
import type { Adapter, Identity, Result, Tool } from "../shared/types.js";
import { resultSchema } from "../shared/types.js";
import { allowed } from "./permissions.js";
import { Store } from "../audit/store.js";
import { WorkflowService } from "../domains/workflow/service.js";
import { ContentService } from "../domains/content/service.js";
import type { CanonicalApprovalBridge } from "../approvals/canonical-bridge.js";
const canonical = (v: any): string =>
  JSON.stringify(
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, JSON.parse(canonical(v[k]))]),
        )
      : v,
  );
/** Stub contracts stay in the registry; default discovery/call only expose executable tools. */
export function executable(tool: Tool, discoverStubs: boolean): boolean {
  return (
    tool.implementation === "real" ||
    tool.implementation === "partial" ||
    (discoverStubs && tool.implementation === "stub")
  );
}
export class ActionEngine {
  constructor(
    readonly store: Store,
    readonly tools: Tool[],
    private adapter: Adapter,
    readonly discoverStubs = false,
    readonly approvalBridge?: CanonicalApprovalBridge,
  ) {}
  discover(identity: Identity) {
    return this.tools.filter(
      (t) => allowed(identity, t) && executable(t, this.discoverStubs),
    );
  }
  async call(
    identity: Identity,
    name: string,
    raw: unknown,
    request_id: string = randomUUID(),
    approvedId?: string,
    approvalTokenId?: string,
  ): Promise<Result> {
    const tool = this.tools.find((t) => t.name === name);
    let input: Record<string, unknown> = {};
    let receiptKey: string | undefined;
    let executionId: string | undefined;
    const finish = (result: Result, authorization = "allowed"): Result => {
      const event = result.data?.event as { id?: unknown } | undefined;
      const eventId = typeof event?.id === "string" ? event.id : undefined;
      const issue = result.data?.issue as { id?: unknown } | undefined;
      const issueId = typeof issue?.id === "string" ? issue.id : undefined;
      const finding = result.data?.finding as { id?: unknown } | undefined;
      const findingId = typeof finding?.id === "string" ? finding.id : undefined;
      if (
        tool?.domain === "admin" &&
        [
          "client_forbidden",
          "bot_not_active",
          "bot_forbidden",
          "event_not_found",
        ].includes(result.error?.code ?? "")
      )
        authorization = "denied";
      if (
        tool?.domain === "engineering" &&
        [
          "client_forbidden",
          "bot_not_active",
          "bot_forbidden",
          "issue_not_found",
          "page_not_found",
          "job_not_found",
        ].includes(result.error?.code ?? "")
      )
        authorization = "denied";
      if (
        tool?.domain === "security" &&
        [
          "client_forbidden",
          "bot_not_active",
          "bot_forbidden",
          "finding_not_found",
          "incident_not_found",
        ].includes(result.error?.code ?? "")
      )
        authorization = "denied";
      if (
        (tool?.domain === "conversion" || tool?.domain === "campaign") &&
        [
          "client_forbidden",
          "bot_not_active",
          "bot_forbidden",
          "page_not_found",
          "campaign_not_found",
          "client_mismatch",
          "revision_not_found",
        ].includes(result.error?.code ?? "")
      )
        authorization = "denied";
      if (
        (tool?.domain === "brand" || tool?.domain === "sites") &&
        [
          "client_forbidden",
          "bot_not_active",
          "bot_forbidden",
          "page_not_found",
          "github_unconfigured",
        ].includes(result.error?.code ?? "")
      )
        authorization = "denied";
      this.store.transaction(() => {
        this.store.audit({
          request_id,
          bot: identity.bot,
          tool: name,
          input_summary: Object.keys(input).filter(
            (k) => k !== "idempotency_key",
          ),
          client_id: input.client_id,
          resource:
            input.event_id ??
            eventId ??
            input.idea_id ??
            input.asset_id ??
            input.task_id ??
            input.issue_id ??
            issueId ??
            input.page_id ??
            input.job_id ??
            input.finding_id ??
            findingId ??
            input.incident_id ??
            input.campaign_id,
          execution_id: executionId,
          authorization,
          approval_status: result.approval_id
            ? "pending"
            : approvedId
              ? "approved"
              : "not_required",
          execution_result: result.status,
          error:
            result.status === "failed"
              ? (result.error?.code ?? "adapter_failed")
              : undefined,
        });
        if (receiptKey)
          this.store.db
            .prepare("UPDATE receipts SET result=? WHERE key=?")
            .run(JSON.stringify(result), receiptKey);
      });
      return result;
    };
    if (
      !tool ||
      !allowed(identity, tool) ||
      !executable(tool, this.discoverStubs)
    )
      return finish(
        {
          status: "rejected",
          capability: name,
          request_id,
          message: "Tool unavailable or unauthorized.",
        },
        "denied",
      );
    // Sec Phase 5 #5: gateway permission + client-scope checks remain (db mode
    // uses identity.permissions from AA). workflow.record_decision is hard-denied
    // in allowed() regardless of grants.
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success)
      return finish({
        status: "rejected",
        capability: name,
        request_id,
        message: "Invalid tool input.",
      });
    input = parsed.data;
    if (
      name !== "delivery.list_clients" &&
      !identity.clients.includes(String(input.client_id))
    )
      return finish(
        {
          status: "rejected",
          capability: name,
          request_id,
          message: "Client scope denied.",
        },
        "denied",
      );
    if (tool.action === "write") {
      const key = canonical([
        identity.bot,
        name,
        input.client_id,
        input.idempotency_key,
        approvedId ?? "initial",
      ]);
      const fingerprint = createHash("sha256")
        .update(canonical(input))
        .digest("hex");
      const existing = this.store.db
        .prepare("SELECT * FROM receipts WHERE key=?")
        .get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          return finish({
            status: "rejected",
            capability: name,
            request_id,
            message: "Idempotency key conflicts with prior input.",
          });
        if (this.approvalBridge && !approvedId && existing.result) {
          const prior = JSON.parse(String(existing.result)) as Result;
          const held = prior.approval_id
            ? this.store.getApproval(prior.approval_id) : undefined;
          if (prior.status === "approval_required" && held?.status === "pending"
            && held.requested_by_bot === identity.bot && held.tool === name
            && held.request_token_id === approvalTokenId
            && canonical(held.structured_payload) === canonical(input)) {
            receiptKey = key;
            executionId = createHash("sha256").update(key).digest("hex");
            return finish({ ...prior, request_id });
          }
          if (prior.status === "indeterminate" && held?.status === "registration_pending"
            && held.requested_by_bot === identity.bot && held.tool === name
            && canonical(held.structured_payload) === canonical(input)) {
            receiptKey = key;
            executionId = createHash("sha256").update(key).digest("hex");
            if (!approvalTokenId || held.request_token_id !== approvalTokenId)
              return finish({ status: "rejected", capability: name, request_id,
                message: "Bot token changed; start a new approval request." });
            try {
              const registered = await this.approvalBridge.register({
                approval_id: held.approval_id, client_id: String(input.client_id),
                bot_id: identity.bot, token_id: approvalTokenId,
                tool: name, risk: held.risk_level, summary: String(held.summary),
                payload: input, expires_at: held.expires_at,
              });
              held.canonical_request_id = registered.canonical_request_id;
              held.canonical_payload_hash = registered.payload_hash;
              held.status = "pending";
              this.store.approval(held);
              return finish({ status: "approval_required", capability: name,
                request_id, approval_id: held.approval_id });
            } catch {
              return finish({ ...prior, request_id });
            }
          }
        }
        if (
          tool.domain !== "admin" &&
          tool.domain !== "engineering" &&
          tool.domain !== "security" &&
          tool.domain !== "sites" &&
          !(
            (identity.bot === "bot_admin" ||
              identity.bot === "bot_engineering" ||
              identity.bot === "bot_security_devops") &&
            [
              "workflow.create_task",
              "workflow.assign_task",
              "workflow.complete_task",
            ].includes(name)
          )
        )
          return finish(
            existing.result
              ? { ...JSON.parse(String(existing.result)), request_id }
              : {
                  status: "indeterminate",
                  capability: name,
                  request_id,
                  message: "Execution reserved; reconcile before retrying.",
                },
          );
      }
      executionId = createHash("sha256").update(key).digest("hex");
      if (!existing)
        this.store.transaction(() => {
          this.store.db
            .prepare("INSERT INTO receipts(key,fingerprint) VALUES (?,?)")
            .run(key, fingerprint);
          this.store.audit({
            request_id,
            bot: identity.bot,
            tool: name,
            client_id: input.client_id,
            authorization: "allowed",
            execution_result: "reserved",
            execution_id: executionId,
          });
        });
      receiptKey = key;
    }
    const needsApproval =
      tool.approval ||
      ["HIGH", "CRITICAL"].includes(tool.risk) ||
      name === "workflow.create_approval";
    if (needsApproval) {
      const approved = approvedId
        ? this.store.getApproval(approvedId)
        : undefined;
      if (
        approvedId &&
        (!approved ||
          approved.status !== "approved" ||
          approved.requested_by_bot !== identity.bot ||
          (approved.request_token_id ?? null) !== (approvalTokenId ?? null) ||
          approved.tool !== name ||
          approved.risk_level !== tool.risk ||
          canonical(approved.structured_payload) !== canonical(input) ||
          Date.parse(approved.expires_at) <= Date.now())
      )
        return finish({
          status: "rejected",
          capability: name,
          request_id,
          message: "Approval is invalid or expired.",
        });
      if (approvedId && this.approvalBridge) {
        try {
          if (!approved.canonical_request_id || !approvalTokenId
            || !approved.canonical_payload_hash
            || !await this.approvalBridge.attest(approvedId, approvalTokenId,
              approved.canonical_payload_hash, approved.canonical_request_id)) {
            return finish({ status: "rejected", capability: name, request_id,
              message: "Current canonical approval is required." });
          }
        } catch {
          return finish({ status: "indeterminate", capability: name, request_id,
            message: "Canonical approval could not be attested; no action executed." });
        }
      }
      if (!approved) {
        const approval_id = randomUUID();
        const approval = {
          approval_id,
          requested_by_bot: identity.bot,
          request_token_id: approvalTokenId ?? null,
          requested_action: name,
          tool: name,
          target:
            input.idea_id ?? input.asset_id ?? input.task_id ?? input.client_id,
          client_id: input.client_id,
          summary: input.summary ?? tool.description,
          structured_payload: input,
          risk_level: tool.risk,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          status: "pending",
          approved_by: null,
          approved_at: null,
          rejection_reason: null,
          execution_status: "not_started",
        };
        if (this.approvalBridge) {
          if (!approvalTokenId) return finish({ status: "rejected", capability: name, request_id,
            message: "A current AA bot token is required for canonical approval." });
          try {
            const canonical = await this.approvalBridge.register({
              approval_id, client_id: String(input.client_id), bot_id: identity.bot,
              token_id: approvalTokenId, tool: name, risk: tool.risk,
              summary: String(approval.summary), payload: input,
              expires_at: approval.expires_at,
            });
            Object.assign(approval, { canonical_request_id: canonical.canonical_request_id,
              canonical_payload_hash: canonical.payload_hash });
          } catch {
            approval.status = "registration_pending";
            this.store.approval(approval);
            return finish({ status: "indeterminate", capability: name, request_id,
              approval_id,
              message: "Canonical registration is uncertain; retry this exact tool request to reconcile it." });
          }
        }
        this.store.approval(approval);
        return finish({
          status: "approval_required",
          capability: name,
          request_id,
          approval_id,
        });
      }
    }
    try {
      executionId ??= createHash("sha256")
        .update(receiptKey ?? request_id)
        .digest("hex");
      const context = {
        ...identity,
        request_id,
        execution_id: executionId,
      };
      let result: Omit<Result, "request_id">;
      const workflowResult = new WorkflowService(this.store).execute(
        tool,
        input,
        context,
      );
      if (workflowResult) result = workflowResult;
      else if (name.startsWith("content."))
        result = await new ContentService(this.adapter).execute(
          tool,
          input,
          context,
        );
      else result = await this.adapter.execute(tool, input, context);
      return finish(resultSchema.parse({ ...result, request_id }));
    } catch {
      return finish({
        status: "failed",
        capability: name,
        request_id,
        message:
          "Adapter execution failed; reconcile external state before issuing a new key.",
      });
    }
  }
  decide(
    id: string,
    reviewer: string,
    decision: "approved" | "rejected",
    reason?: string,
  ) {
    if (this.approvalBridge) throw new Error("canonical_decision_required");
    return this.store.transaction(() => {
      const a = this.store.getApproval(id);
      if (!a || a.status !== "pending") throw new Error("invalid_transition");
      if (Date.parse(a.expires_at) <= Date.now()) {
        a.status = "expired";
        this.store.approval(a);
        return a;
      }
      Object.assign(a, {
        status: decision,
        approved_by: decision === "approved" ? reviewer : null,
        approved_at: decision === "approved" ? new Date().toISOString() : null,
        rejection_reason: decision === "rejected" ? (reason ?? null) : null,
      });
      this.store.approval(a);
      this.store.audit({
        request_id: randomUUID(),
        reviewer,
        tool: a.tool,
        client_id: a.client_id,
        approval_id: id,
        approval_status: decision,
        execution_result: "not_started",
      });
      return a;
    });
  }
  async executeApproval(
    id: string,
    identities: Identity[],
    approvalTokenId?: string,
  ): Promise<Result> {
    const a = this.store.getApproval(id);
    const identity = identities.find((i) => i.bot === a?.requested_by_bot);
    const tool = this.tools.find((t) => t.name === a?.tool);
    if (
      !a ||
      (this.approvalBridge ? !["pending", "approved"].includes(a.status) : a.status !== "approved") ||
      a.execution_status !== "not_started" ||
      !identity ||
      (a.request_token_id ?? null) !== (approvalTokenId ?? null) ||
      !tool ||
      a.risk_level !== tool.risk ||
      !allowed(identity, tool) ||
      !identity.clients.includes(String(a.client_id))
    )
      throw new Error("invalid_transition");
    if (this.approvalBridge) {
      if (!approvalTokenId || !a.canonical_request_id || !a.canonical_payload_hash
        || !await this.approvalBridge.attest(id, approvalTokenId, a.canonical_payload_hash,
          a.canonical_request_id))
        throw new Error("canonical_decision_required");
      const executionKey = randomUUID();
      if (!await this.approvalBridge.claim(id, approvalTokenId,
        a.canonical_payload_hash, executionKey))
        throw new Error("canonical_execution_claimed");
      a.canonical_execution_key = executionKey;
      a.status = "approved";
      a.approved_by = "canonical_inbox";
      a.approved_at = new Date().toISOString();
      this.store.approval(a);
    }
    // Synchronous reservation prevents concurrent reviewers from executing the same action.
    a.execution_status = "executing";
    this.store.approval(a);
    let result: Result;
    try {
      result = await this.call(
        identity,
        a.tool,
        a.structured_payload,
        randomUUID(),
        id,
        approvalTokenId,
      );
    } catch {
      result = { status: "indeterminate", capability: a.tool, request_id: randomUUID(),
        message: "Gateway execution outcome is unknown; reconcile before another action." };
    }
    if (this.approvalBridge) {
      const resultHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
      try {
        await this.approvalBridge.finish(id, a.canonical_execution_key, result.status,
          resultHash);
      } catch {
        a.execution_status = "indeterminate";
        a.status = "failed";
        this.store.approval(a);
        return { status: "indeterminate", capability: a.tool, request_id: result.request_id,
          message: "Canonical outcome recording failed; reconcile before another action." };
      }
    }
    a.execution_status = result.status;
    a.status = ["completed", "accepted"].includes(result.status)
      ? "executed"
      : "failed";
    this.store.approval(a);
    return result;
  }
}
