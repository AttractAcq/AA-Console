import { z } from "zod";
import type { Adapter, Context, Tool, Result } from "../shared/types.js";

const uuid = z.string().uuid();
const briefResponse = z
  .object({ job_id: uuid, client_id: uuid })
  .strict();
const clientScoped = z
  .object({ client_id: uuid })
  .passthrough()
  .refine((v) => Object.keys(v).length >= 1);

const ROUTES: Record<
  string,
  { path: string; kind: "brief" | "read" | "write" | "queue"; input: z.ZodType }
> = {
  // Sec Phase 5: gateway never holds service_role / never calls can_access_client.
  // AA RPCs enforce require_active_bot + require_bot_client_grant. Client-scope
  // is also denied in ActionEngine before this adapter runs.
  "content.generate_brief": {
    path: "/internal/mcp/content/generate-brief",
    kind: "brief",
    input: z.object({ client_id: uuid, idea_id: uuid }),
  },
  "content.list_ideas": {
    path: "/internal/mcp/content/list-ideas",
    kind: "read",
    input: z.object({
        client_id: uuid,
        limit: z.number().int().min(1).max(100).optional(),
        status: z.enum(["draft", "approved", "rejected", "briefed"]).optional(),
      }),
  },
  "content.get_idea": {
    path: "/internal/mcp/content/get-idea",
    kind: "read",
    input: z.object({ client_id: uuid, idea_id: uuid }),
  },
  "content.get_brief": {
    path: "/internal/mcp/content/get-brief",
    kind: "read",
    input: z
      .object({
        client_id: uuid,
        brief_id: uuid.optional(),
        idea_id: uuid.optional(),
      })
      .refine((v) => Boolean(v.brief_id || v.idea_id)),
  },
  "content.get_production_status": {
    path: "/internal/mcp/content/get-production-status",
    kind: "read",
    input: z
      .object({
        client_id: uuid,
        idea_id: uuid.optional(),
        brief_id: uuid.optional(),
        asset_id: uuid.optional(),
      })
      .refine((v) => Boolean(v.idea_id || v.brief_id || v.asset_id)),
  },
  "content.request_revision": {
    path: "/internal/mcp/content/request-revision",
    kind: "write",
    input: z
      .object({
        client_id: uuid,
        summary: z.string().min(1).max(4000),
        idea_id: uuid.optional(),
        brief_id: uuid.optional(),
        asset_id: uuid.optional(),
      })
      .refine((v) => Boolean(v.idea_id || v.brief_id || v.asset_id)),
  },
  "content.request_approval": {
    path: "/internal/mcp/content/request-approval",
    kind: "write",
    input: z
      .object({
        client_id: uuid,
        summary: z.string().min(1).max(4000).optional(),
        idea_id: uuid.optional(),
        brief_id: uuid.optional(),
        asset_id: uuid.optional(),
      })
      .refine((v) => Boolean(v.idea_id || v.brief_id || v.asset_id)),
  },
  "content.create_repurpose_plan": {
    path: "/internal/mcp/content/create-repurpose-plan",
    kind: "queue",
    input: z.object({
        client_id: uuid,
        asset_id: uuid,
        formats: z
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
          .max(6),
      }),
  },
};

const codes = new Set([
  "unauthorized",
  "invalid_bot",
  "invalid_request",
  "idea_not_found",
  "brief_not_found",
  "asset_not_found",
  "client_mismatch",
  "client_forbidden",
  "bot_not_active",
  "invalid_idea_status",
  "invalid_brief_status",
  "invalid_asset_status",
  "invalid_formats",
  "idempotency_conflict",
  "brief_agent_unavailable",
  "repurpose_agent_unavailable",
  "queue_failure",
  "internal_error",
]);
const fallback: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "client_forbidden",
  404: "idea_not_found",
  409: "idempotency_conflict",
  503: "brief_agent_unavailable",
  500: "internal_error",
};

async function readBody(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error("missing_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("oversized_body");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function aaBody(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === "content.generate_brief")
    return { client_id: input.client_id, idea_id: input.idea_id };
  if (tool === "content.list_ideas") {
    const body: Record<string, unknown> = { client_id: input.client_id };
    if (input.limit !== undefined) body.limit = input.limit;
    if (input.status !== undefined) body.status = input.status;
    return body;
  }
  if (tool === "content.get_idea")
    return { client_id: input.client_id, idea_id: input.idea_id };
  if (tool === "content.get_brief") {
    const body: Record<string, unknown> = { client_id: input.client_id };
    if (input.brief_id) body.brief_id = input.brief_id;
    if (input.idea_id) body.idea_id = input.idea_id;
    return body;
  }
  if (tool === "content.get_production_status") {
    const body: Record<string, unknown> = { client_id: input.client_id };
    if (input.idea_id) body.idea_id = input.idea_id;
    if (input.brief_id) body.brief_id = input.brief_id;
    if (input.asset_id) body.asset_id = input.asset_id;
    return body;
  }
  if (tool === "content.request_revision") {
    const body: Record<string, unknown> = {
      client_id: input.client_id,
      summary: input.summary,
    };
    if (input.idea_id) body.idea_id = input.idea_id;
    if (input.brief_id) body.brief_id = input.brief_id;
    if (input.asset_id) body.asset_id = input.asset_id;
    return body;
  }
  if (tool === "content.request_approval") {
    const body: Record<string, unknown> = { client_id: input.client_id };
    if (input.summary) body.summary = input.summary;
    if (input.idea_id) body.idea_id = input.idea_id;
    if (input.brief_id) body.brief_id = input.brief_id;
    if (input.asset_id) body.asset_id = input.asset_id;
    return body;
  }
  if (tool === "content.create_repurpose_plan")
    return {
      client_id: input.client_id,
      asset_id: input.asset_id,
      formats: input.formats,
    };
  return { client_id: input.client_id };
}

export class AAApiAdapter implements Adapter {
  constructor(
    private config?: { url: string; token: string; timeoutMs?: number },
  ) {}
  async execute(
    tool: Tool,
    input: Record<string, unknown>,
    context: Context,
  ): Promise<Omit<Result, "request_id">> {
    const route = ROUTES[tool.name];
    const fail = (
      code: string,
      upstream_status?: number,
    ): Omit<Result, "request_id"> => ({
      status: "failed",
      capability: tool.name,
      error: {
        code,
        ...(upstream_status === undefined ? {} : { upstream_status }),
      },
      message: `AA ${route?.kind === "brief" ? "brief" : "content"} request failed (${code}); reconcile external state before issuing a new key.`,
    });
    if (!route || !this.config)
      return {
        status: "not_implemented",
        capability: tool.name,
        message: "AA business endpoint is not connected.",
        required_dependency: tool.dependency,
      };
    const parsed = route.input.safeParse(input);
    if (!parsed.success) return fail("invalid_request");
    const signal = AbortSignal.timeout(this.config.timeoutMs ?? 15000);
    const maxBytes = route.kind === "brief" ? 16384 : 65536;
    try {
      const response = await fetch(new URL(route.path, this.config.url), {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
          "x-aa-bot-id": context.bot,
          "x-request-id": context.request_id,
          "idempotency-key": context.execution_id,
        },
        body: JSON.stringify(aaBody(tool.name, parsed.data as Record<string, unknown>)),
      });
      let raw: any;
      try {
        raw = await readBody(response, maxBytes);
      } catch {
        if (signal.aborted) return fail("upstream_timeout");
        return fail(
          response.ok
            ? "malformed_response"
            : (fallback[response.status] ?? "internal_error"),
          response.status,
        );
      }
      if (!response.ok) {
        const code =
          typeof raw?.error === "string"
            ? raw.error
            : (raw?.error?.code ?? raw?.code);
        return fail(
          codes.has(code)
            ? code
            : (fallback[response.status] ?? "internal_error"),
          response.status,
        );
      }
      if (route.kind === "brief") {
        const data = briefResponse.safeParse(raw);
        if (
          ![200, 202].includes(response.status) ||
          !data.success ||
          data.data.client_id !== input.client_id
        )
          return fail("malformed_response", response.status);
        return { status: "accepted", capability: tool.name, data: data.data };
      }
      const scoped = clientScoped.safeParse(raw);
      if (!response.ok || !scoped.success || scoped.data.client_id !== input.client_id)
        return fail("malformed_response", response.status);
      if (route.kind === "queue") {
        if (![200, 202].includes(response.status))
          return fail("malformed_response", response.status);
        const job = z.object({ job_id: uuid, client_id: uuid }).safeParse(raw);
        if (!job.success) return fail("malformed_response", response.status);
        return { status: "accepted", capability: tool.name, data: raw };
      }
      if (response.status !== 200)
        return fail("malformed_response", response.status);
      return { status: "completed", capability: tool.name, data: raw };
    } catch {
      return fail(signal.aborted ? "upstream_timeout" : "upstream_unavailable");
    }
  }
}
