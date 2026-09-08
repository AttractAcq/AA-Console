import http from "node:http";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { authenticate } from "../auth/identity.js";
import type { ActionEngine } from "../policy/engine.js";
import type { Config } from "./config.js";
const digest = (v: string) => createHash("sha256").update(v).digest();
export function createServer(c: Config, engine: ActionEngine) {
  const rates = new Map<string, { count: number; reset: number }>();
  return http.createServer(
    { requestTimeout: 20000, headersTimeout: 10000 },
    async (req, res) => {
      const request_id = randomUUID();
      res.setHeader("x-request-id", request_id);
      res.setHeader("cache-control", "no-store");
      const json = (status: number, value: unknown) => {
        if (!res.headersSent)
          res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      try {
        if (req.url === "/health" && req.method === "GET")
          return json(200, { status: "ok" });
        const origin = new URL(c.PUBLIC_ORIGIN);
        if (
          req.headers.host !== origin.host ||
          (req.headers.origin && req.headers.origin !== origin.origin)
        )
          return json(403, { error: "invalid_origin", request_id });
        // Bound unauthenticated traffic by socket IP; never trust forwarded identity headers.
        const now = Date.now();
        for (const [k, v] of rates) if (v.reset <= now) rates.delete(k);
        const key = req.socket.remoteAddress ?? "unknown";
        const rate = rates.get(key) ?? { count: 0, reset: now + 60000 };
        if (rates.size >= 10000 && !rates.has(key))
          return json(429, { error: "rate_limited", request_id });
        rates.set(key, rate);
        if (++rate.count > 120) {
          res.setHeader("retry-after", "60");
          return json(429, { error: "rate_limited", request_id });
        }
        const admin = req.url?.startsWith("/admin/approvals");
        let identity;
        let reviewer;
        if (admin) {
          const token =
            /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "")?.[1] ??
            "";
          reviewer = c.reviewers.find((r) =>
            timingSafeEqual(digest(r.token), digest(token)),
          );
          if (!reviewer) throw new Error("unauthorized");
        } else identity = authenticate(req.headers.authorization, c.bots);
        if (admin && req.url === "/admin/approvals" && req.method === "GET")
          return json(200, { approvals: engine.store.approvals() });
        if (req.method !== "POST")
          return json(405, { error: "method_not_allowed", request_id });
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(415, { error: "json_required", request_id });
        let body = "";
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 65536)
            return json(413, { error: "body_too_large", request_id });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(400, { error: "invalid_json", request_id });
        }
        if (admin) {
          const match =
            /^\/admin\/approvals\/([0-9a-f-]{36})\/(decision|execute)$/.exec(
              req.url ?? "",
            );
          if (!match) return json(404, { error: "not_found", request_id });
          if (match[2] === "decision") {
            const d = z
              .object({
                decision: z.enum(["approved", "rejected"]),
                reason: z.string().max(2000).optional(),
              })
              .strict()
              .parse(parsed);
            return json(
              200,
              engine.decide(match[1], reviewer!.id, d.decision, d.reason),
            );
          }
          z.object({}).strict().parse(parsed);
          return json(200, await engine.executeApproval(match[1], c.bots));
        }
        if (req.url !== "/mcp")
          return json(404, { error: "not_found", request_id });
        const caller = identity!;
        const server = new Server(
          { name: "aa-mcp-gateway", version: "0.1.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: engine.discover(caller).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: z.toJSONSchema(t.input) as any,
            outputSchema: z.toJSONSchema(t.output) as any,
            annotations: {
              readOnlyHint: t.action === "read",
              destructiveHint: !t.reversible,
              idempotentHint: t.action === "write",
              openWorldHint: false,
            },
          })),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const result = await engine.call(
            caller,
            request.params.name,
            request.params.arguments,
            request_id,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            isError: [
              "failed",
              "rejected",
              "not_implemented",
              "indeterminate",
            ].includes(result.status),
          };
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (error) {
        const unauthorized =
          error instanceof Error && error.message === "unauthorized";
        engine.store.audit({
          request_id,
          authorization: unauthorized ? "denied" : "unknown",
          execution_result: "rejected",
          error: unauthorized ? "unauthorized" : "request_failed",
        });
        json(
          unauthorized
            ? 401
            : error instanceof z.ZodError
              ? 400
              : error instanceof Error && error.message === "invalid_transition"
                ? 409
                : 500,
          {
            error: unauthorized ? "unauthorized" : "request_failed",
            request_id,
          },
        );
      }
    },
  );
}
