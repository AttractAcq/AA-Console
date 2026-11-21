import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { handleDailyVideoOperator } from "./daily-operator-route.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "22222222-2222-4222-8222-222222222222";
const ROUTE = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";
const PACKAGE = "55555555-5555-4555-8555-555555555555";
const RUN = "66666666-6666-4666-8666-666666666666";

function request(body: Record<string, unknown>): IncomingMessage {
  const req = Readable.from([JSON.stringify({ clientId: CLIENT, ...body })]) as IncomingMessage;
  req.method = "POST";
  req.headers = { authorization: "Bearer valid-token" };
  return req;
}

function response(): { res: ServerResponse; result: () => { status: number; body: Record<string, unknown> } } {
  let status = 0;
  let body: Record<string, unknown> = {};
  return {
    res: { writeHead(value: number) { status = value; },
      end(value: string) { body = JSON.parse(value) as Record<string, unknown>; } } as ServerResponse,
    result: () => ({ status, body }),
  };
}

function service(aal = "aal2", manager: string | null = OPERATOR,
  rpcError: string | null = null): { sb: SupabaseClient; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async (name: string) => {
    if (name === "active_video_approval_manager") return { data: manager, error: null };
    if (rpcError) return { data: null, error: { message: rpcError } };
    if (name === "plan_daily_code_video_package_v1") {
      return { data: { id: PACKAGE, run_id: RUN, package_day: "2099-01-02" }, error: null };
    }
    return { data: { source_count: 1 }, error: null };
  });
  const query = { select: () => query, eq: () => query,
    maybeSingle: async () => ({ data: { role: "employee", is_bot: false }, error: null }) };
  const sb = {
    auth: {
      getUser: async () => ({ data: { user: { id: OPERATOR, app_metadata: {} } }, error: null }),
      getClaims: async () => ({ data: { claims: {
        sub: OPERATOR, role: "authenticated", aal,
      } }, error: null }),
    },
    from: vi.fn(() => query), rpc,
  } as unknown as SupabaseClient;
  return { sb, rpc };
}

describe("daily code-video operator route", () => {
  it("requires a current AAL2 session before service calls", async () => {
    const { sb, rpc } = service("aal1");
    const { res, result } = response();
    await handleDailyVideoOperator(request({ action: "plan", packageDay: "2099-01-02" }), res, sb);
    expect(result().status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denies a user who is not this client's manager", async () => {
    const { sb, rpc } = service("aal2", null);
    const { res, result } = response();
    await handleDailyVideoOperator(request({ action: "configure", routePackageId: ROUTE,
      modelRecordIds: [SOURCE] }), res, sb);
    expect(result().status).toBe(403);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith("configure_daily_video_sources_v1", expect.anything());
  });

  it("saves exact sources and requests one explicit day through service-only SQL", async () => {
    const { sb, rpc } = service();
    const configured = response();
    await handleDailyVideoOperator(request({ action: "configure", routePackageId: ROUTE,
      modelRecordIds: [SOURCE] }), configured.res, sb);
    expect(configured.result().status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("configure_daily_video_sources_v1", {
      p_client_id: CLIENT, p_route_package_id: ROUTE, p_record_ids: [SOURCE],
    });
    const planned = response();
    await handleDailyVideoOperator(request({ action: "plan", packageDay: "2099-01-02" }), planned.res, sb);
    expect(planned.result()).toMatchObject({ status: 200,
      body: { ok: true, packageId: PACKAGE, runId: RUN } });
    expect(rpc).toHaveBeenCalledWith("plan_daily_code_video_package_v1", {
      p_client_id: CLIENT, p_day: "2099-01-02",
    });
  });

  it("rejects duplicate sources and invalid dates before service writes", async () => {
    const { sb, rpc } = service();
    const duplicate = response();
    await handleDailyVideoOperator(request({ action: "configure", routePackageId: ROUTE,
      modelRecordIds: [SOURCE, SOURCE] }), duplicate.res, sb);
    expect(duplicate.result().status).toBe(400);
    const badDay = response();
    await handleDailyVideoOperator(request({ action: "plan", packageDay: "2099-02-30" }), badDay.res, sb);
    expect(badDay.result().status).toBe(400);
    expect(rpc).toHaveBeenCalledTimes(2); // authority lookup only
  });

  it("surfaces a stale-source database hold without claiming a package", async () => {
    const { sb } = service("aal2", OPERATOR, "Daily video requires the current organic route.");
    const { res, result } = response();
    await handleDailyVideoOperator(request({ action: "plan", packageDay: "2099-01-02" }), res, sb);
    expect(result()).toMatchObject({ status: 409,
      body: { ok: false, error: "Daily video requires the current organic route." } });
  });
});
