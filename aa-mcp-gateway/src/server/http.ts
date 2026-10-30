import http from "node:http";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BotAuthenticator, type FreshIdentity } from "../auth/identity.js";
import type { ActionEngine } from "../policy/engine.js";
import { permissionMatches } from "../policy/permissions.js";
import type { Result, Tool } from "../shared/types.js";
import type { Config } from "./config.js";
const digest = (v: string) => createHash("sha256").update(v).digest();
// These tools read/write the gateway's own SQLite store, so no AA business
// RPC gets a chance to reject a revoked Bot or removed client grant.
const GATEWAY_LOCAL_TOOLS = new Set([
  "workflow.get_pending_approvals",
  "workflow.get_activity",
  "workflow.create_approval",
]);
const hasFreshAaPermission = (fresh: FreshIdentity, tool: Tool) =>
  tool.permissions.every((permission) =>
    fresh.aaPermissions.some((grant) => permissionMatches(grant, permission)),
  );
export function createServer(
  c: Config,
  engine: ActionEngine,
  authenticator = BotAuthenticator.fromConfig(c, (event) => {
    engine.store.audit({
      authorization: "denied",
      execution_result: "rejected",
      error: typeof event.event === "string" ? event.event : "bot_auth_alert",
      ...event,
    });
  }),
) {
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
        if (req.url === "/internal/readiness") {
          if (req.method !== "GET")
            return json(405, { error: "method_not_allowed", request_id });
          // This is a process identity probe, not an MCP tool or a public
          // health check. The gateway and runtime already share this secret.
          if (!c.AA_MCP_SERVICE_SECRET)
            return json(503, { error: "readiness_unconfigured", request_id });
          const token =
            /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "")?.[1] ??
            "";
          if (!timingSafeEqual(digest(c.AA_MCP_SERVICE_SECRET), digest(token)))
            return json(401, { error: "unauthorized", request_id });
          const rawSha =
            process.env.RAILWAY_GIT_COMMIT_SHA ??
            process.env.SOURCE_VERSION ??
            "";
          return json(200, {
            ok: true,
            sha: /^[0-9a-f]{40}$/i.test(rawSha) ? rawSha.toLowerCase() : null,
            observedAt: new Date().toISOString(),
            configured: {
              aaInternalApi: Boolean(c.AA_INTERNAL_API_URL),
              botAuthMode: c.BOT_AUTH_MODE,
            },
          });
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
        } else
          identity = await authenticator.authenticate(
            req.headers.authorization,
          );
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
          const approval = engine.store.getApproval(match[1]);
          if (!approval) throw new Error("invalid_transition");
          const current = await authenticator.freshIdentityForBot(
            approval.requested_by_bot,
          );
          const tool = engine.tools.find((t) => t.name === approval.tool);
          if (!tool || !hasFreshAaPermission(current, tool))
            throw new Error("unauthorized");
          return json(
            200,
            await engine.executeApproval(match[1], [current.identity]),
          );
        }
        if (req.url !== "/mcp")
          return json(404, { error: "not_found", request_id });
        const caller = identity!;
        const freshLocalIdentity = async (): Promise<FreshIdentity> => {
          const current = await authenticator.authenticateFresh(
            req.headers.authorization,
          );
          if (
            current.identity.bot !== caller.bot ||
            current.identity.clients.length === 0
          )
            throw new Error("unauthorized");
          return current;
        };
        const server = new Server(
          { name: "aa-mcp-gateway", version: "0.1.0" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => {
          const visible = engine.discover(caller);
          let local: FreshIdentity | undefined;
          if (visible.some((t) => GATEWAY_LOCAL_TOOLS.has(t.name))) {
            try {
              local = await freshLocalIdentity();
            } catch {
              local = undefined;
              engine.store.audit({
                request_id,
                bot: caller.bot,
                authorization: "denied",
                execution_result: "rejected",
                error: "gateway_local_aa_auth_required",
              });
            }
          }
          const freshNames = local
            ? new Set(
                engine
                  .discover(local.identity)
                  .filter((t) => hasFreshAaPermission(local, t))
                  .map((t) => t.name),
              )
            : new Set<string>();
          return {
            tools: visible
              .filter(
                (t) =>
                  !GATEWAY_LOCAL_TOOLS.has(t.name) || freshNames.has(t.name),
              )
              .map((t) => ({
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
          };
        });
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          let result: Result = {
            status: "rejected",
            capability: request.params.name,
            request_id,
            message: "Tool unavailable or unauthorized.",
          };
          if (GATEWAY_LOCAL_TOOLS.has(request.params.name)) {
            let current: FreshIdentity | undefined;
            try {
              current = await freshLocalIdentity();
              const tool = engine.tools.find(
                (t) => t.name === request.params.name,
              );
              if (!tool || !hasFreshAaPermission(current, tool))
                throw new Error("unauthorized");
            } catch {
              current = undefined;
              engine.store.audit({
                request_id,
                bot: caller.bot,
                tool: request.params.name,
                authorization: "denied",
                execution_result: "rejected",
                error: "gateway_local_aa_auth_required",
              });
            }
            if (current)
              result = await engine.call(
                current.identity,
                request.params.name,
                request.params.arguments,
                request_id,
              );
          } else {
            result = await engine.call(
              caller,
              request.params.name,
              request.params.arguments,
              request_id,
            );
          }
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
