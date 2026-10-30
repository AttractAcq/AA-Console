import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { collectReleaseProbe } from "./release-probe.js";

const runtimeSha = "a".repeat(40);
const gatewaySha = "b".repeat(40);
const migrationHead = "20261030160000";
const secret = "never-expose-this-service-secret";

function fixture() {
  const rpc = vi.fn(async () => ({ data: { migrationHead }, error: null }));
  const sb = { rpc } as unknown as SupabaseClient;
  const config = {
    gatewayUrl: "https://gateway.example", mcpServiceSecret: secret,
  } as RuntimeConfig;
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.headers).toEqual({ Authorization: `Bearer ${secret}` });
    return { ok: true, json: async () => ({ ok: true, sha: gatewaySha, observedAt: new Date().toISOString(), configured: { botAuthMode: "db" } }) } as Response;
  }) as unknown as typeof fetch;
  return { rpc, sb, config, fetcher };
}

describe("public release identity probe", () => {
  it("reports only fresh full SHAs and the live migration head", async () => {
    const { rpc, sb, config, fetcher } = fixture();
    const probe = await collectReleaseProbe(sb, config, fetcher, { RAILWAY_GIT_COMMIT_SHA: runtimeSha });
    expect(rpc).toHaveBeenCalledWith("system_readiness_catalog");
    expect(fetcher).toHaveBeenCalledWith("https://gateway.example/internal/readiness", expect.objectContaining({ method: "GET", cache: "no-store" }));
    expect(probe).toMatchObject({ ready: true, runtimeSha, gatewaySha, migrationHead, reason: null });
    const exported = JSON.stringify(probe);
    expect(exported).not.toContain(secret);
    expect(exported).not.toContain("botAuthMode");
    expect(exported).not.toContain("gateway.example");
  });

  it("fails closed before calling dependencies when runtime identity is short", async () => {
    const { rpc, sb, config, fetcher } = fixture();
    const probe = await collectReleaseProbe(sb, config, fetcher, { RAILWAY_GIT_COMMIT_SHA: runtimeSha.slice(0, 12) });
    expect(probe).toMatchObject({ ready: false, reason: "runtime_sha_unknown", runtimeSha: null });
    expect(rpc).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not claim readiness when schema or gateway is unavailable or stale", async () => {
    const { sb, config, fetcher } = fixture();
    const badDb = { rpc: async () => ({ data: { migrationHead: "invalid" }, error: null }) } as unknown as SupabaseClient;
    expect(await collectReleaseProbe(badDb, config, fetcher, { RAILWAY_GIT_COMMIT_SHA: runtimeSha }))
      .toMatchObject({ ready: false, reason: "schema_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();

    expect(await collectReleaseProbe(sb, { ...config, mcpServiceSecret: null }, fetcher, { RAILWAY_GIT_COMMIT_SHA: runtimeSha }))
      .toMatchObject({ ready: false, reason: "gateway_unconfigured", migrationHead });
    const stale = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, sha: gatewaySha, observedAt: "2020-01-01T00:00:00Z" }) } as Response)) as unknown as typeof fetch;
    expect(await collectReleaseProbe(sb, config, stale, { RAILWAY_GIT_COMMIT_SHA: runtimeSha }))
      .toMatchObject({ ready: false, reason: "gateway_unavailable", gatewaySha: null });
    const down = vi.fn(async () => { throw new Error(`failed with ${secret}`); }) as unknown as typeof fetch;
    const probe = await collectReleaseProbe(sb, config, down, { RAILWAY_GIT_COMMIT_SHA: runtimeSha });
    expect(probe).toMatchObject({ ready: false, reason: "gateway_unavailable" });
    expect(JSON.stringify(probe)).not.toContain(secret);
  });

  it("bounds a gateway transport that ignores the abort signal", async () => {
    const { sb, config } = fixture();
    const hanging = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const probe = await collectReleaseProbe(sb, config, hanging, { RAILWAY_GIT_COMMIT_SHA: runtimeSha });
    expect(probe).toMatchObject({ ready: false, reason: "gateway_unavailable", gatewaySha: null });
  }, 10_000);
});
