import { createHash, randomUUID } from "node:crypto";
import type { Adapter, Identity, Result, Tool } from "../shared/types.js";
import { resultSchema } from "../shared/types.js";
import { allowed } from "./permissions.js";
import { Store } from "../audit/store.js";
import { WorkflowService } from "../domains/workflow/service.js";
import { ContentService } from "../domains/content/service.js";
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
  ): Promise<Result> {
    const tool = this.tools.find((t) => t.name === name);
    let input: Record<string, unknown> = {};
    let receiptKey: string | undefined;
    const finish = (result: Result, authorization = "allowed"): Result => {
      this.store.transaction(() => {
        this.store.audit({
          request_id,
          bot: identity.bot,
          tool: name,
          input_summary: Object.keys(input).filter(
            (k) => k !== "idempotency_key",
          ),
          client_id: input.client_id,
          resource: input.idea_id ?? input.asset_id ?? input.task_id,
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
    if (name !== "delivery.list_clients" && !identity.clients.includes(String(input.client_id)))
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
          approved.tool !== name ||
          canonical(approved.structured_payload) !== canonical(input) ||
          Date.parse(approved.expires_at) <= Date.now())
      )
        return finish({
          status: "rejected",
          capability: name,
          request_id,
          message: "Approval is invalid or expired.",
        });
      if (!approved) {
        const approval_id = randomUUID();
        this.store.approval({
          approval_id,
          requested_by_bot: identity.bot,
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
        });
        return finish({
          status: "approval_required",
          capability: name,
          request_id,
          approval_id,
        });
      }
    }
    try {
      const context = {
        ...identity,
        request_id,
        execution_id: createHash("sha256")
          .update(receiptKey ?? request_id)
          .digest("hex"),
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
  async executeApproval(id: string, identities: Identity[]) {
    const a = this.store.getApproval(id);
    const identity = identities.find((i) => i.bot === a?.requested_by_bot);
    if (
      !a ||
      a.status !== "approved" ||
      a.execution_status !== "not_started" ||
      !identity
    )
      throw new Error("invalid_transition");
    // Synchronous reservation prevents concurrent reviewers from executing the same action.
    a.execution_status = "executing";
    this.store.approval(a);
    const result = await this.call(
      identity,
      a.tool,
      a.structured_payload,
      randomUUID(),
      id,
    );
    a.execution_status = result.status;
    a.status = ["completed", "accepted"].includes(result.status)
      ? "executed"
      : "failed";
    this.store.approval(a);
    return result;
  }
}
