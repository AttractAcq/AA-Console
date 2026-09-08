import { z } from "zod";
import type { Adapter, Context, Tool, Result } from "../shared/types.js";
const inputSchema = z.object({
  client_id: z.string().uuid(),
  idea_id: z.string().uuid(),
});
const responseSchema = inputSchema
  .pick({ client_id: true })
  .extend({ job_id: z.string().uuid() })
  .strict();
const codes = new Set([
  "unauthorized",
  "invalid_bot",
  "invalid_request",
  "idea_not_found",
  "client_mismatch",
  "client_forbidden",
  "invalid_idea_status",
  "idempotency_conflict",
  "brief_agent_unavailable",
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
async function readBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("missing_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) {
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
export class AAApiAdapter implements Adapter {
  constructor(
    private config?: { url: string; token: string; timeoutMs?: number },
  ) {}
  async execute(
    tool: Tool,
    input: Record<string, unknown>,
    context: Context,
  ): Promise<Omit<Result, "request_id">> {
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
      message: `AA brief request failed (${code}); reconcile external state before issuing a new key.`,
    });
    if (tool.name !== "content.generate_brief" || !this.config)
      return {
        status: "not_implemented",
        capability: tool.name,
        message: "AA business endpoint is not connected.",
        required_dependency: tool.dependency,
      };
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return fail("invalid_request");
    const signal = AbortSignal.timeout(this.config.timeoutMs ?? 15000);
    try {
      const response = await fetch(
        new URL("/internal/mcp/content/generate-brief", this.config.url),
        {
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
          body: JSON.stringify(parsed.data),
        },
      );
      let raw: any;
      try {
        raw = await readBody(response);
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
      const data = responseSchema.safeParse(raw);
      if (
        ![200, 202].includes(response.status) ||
        !data.success ||
        data.data.client_id !== input.client_id
      )
        return fail("malformed_response", response.status);
      return { status: "accepted", capability: tool.name, data: data.data };
    } catch {
      return fail(signal.aborted ? "upstream_timeout" : "upstream_unavailable");
    }
  }
}
