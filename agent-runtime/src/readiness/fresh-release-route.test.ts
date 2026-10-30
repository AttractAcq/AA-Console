import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";

const probes = vi.hoisted(() => ({ fresh: vi.fn(), cached: vi.fn() }));
vi.mock("./release-probe.js", () => ({
  collectReleaseProbe: probes.fresh,
  currentReleaseProbe: probes.cached,
}));
import { handleFreshReleaseProbe } from "./fresh-release-route.js";

const token = "a1".repeat(32);
const wrongToken = "b2".repeat(32);
const sb = {} as SupabaseClient;
const complete = {
  schemaVersion: 1, observedAt: new Date().toISOString(), observationsComplete: true,
  runtimeSha: "c".repeat(40), gatewaySha: "d".repeat(40),
  migrationHead: "20261030160000", reason: null,
};

function request(method = "GET", authorization?: string): IncomingMessage {
  return { method, headers: authorization ? { authorization } : {} } as IncomingMessage;
}

function response() {
  const setHeader = vi.fn();
  const writeHead = vi.fn();
  const end = vi.fn();
  return { res: { setHeader, writeHead, end } as unknown as ServerResponse, setHeader, writeHead, end };
}

function config(browserReleaseProbeToken: string | null = token): RuntimeConfig {
  return { browserReleaseProbeToken } as RuntimeConfig;
}

beforeEach(() => {
  probes.fresh.mockReset();
  probes.cached.mockReset();
  probes.fresh.mockResolvedValue(complete);
});

describe("authenticated uncached release identity probe", () => {
  it("rejects absent or malformed configuration before reading dependencies", () => {
    for (const configured of [null, "short", "A".repeat(64)]) {
      const r = response();
      handleFreshReleaseProbe(request("GET", `Bearer ${token}`), r.res, sb, config(configured));
      expect(r.writeHead).toHaveBeenCalledWith(503, { "Content-Type": "application/json" });
      expect(r.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    }
    expect(probes.fresh).not.toHaveBeenCalled();
  });

  it("requires an exact bearer token and never probes for unauthorized requests", () => {
    for (const header of [undefined, "", `Bearer ${wrongToken}`, `bearer ${token}`, `Bearer ${token} `, `Bearer ${token.slice(0, -2)}`, `Basic ${token}`]) {
      const r = response();
      handleFreshReleaseProbe(request("GET", header), r.res, sb, config());
      expect(r.writeHead).toHaveBeenCalledWith(401, { "Content-Type": "application/json" });
      expect(r.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
      expect(r.end.mock.calls[0]![0]).not.toContain(token);
    }
    expect(probes.fresh).not.toHaveBeenCalled();
  });

  it("rejects non-GET calls before probing", () => {
    const r = response();
    handleFreshReleaseProbe(request("POST", `Bearer ${token}`), r.res, sb, config());
    expect(r.writeHead).toHaveBeenCalledWith(405, { "Content-Type": "application/json" });
    expect(r.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(probes.fresh).not.toHaveBeenCalled();
  });

  it("performs a new database and gateway collection on every authorized request", async () => {
    const first = response();
    const second = response();
    handleFreshReleaseProbe(request("GET", `Bearer ${token}`), first.res, sb, config());
    handleFreshReleaseProbe(request("GET", `Bearer ${token}`), second.res, sb, config());
    await vi.waitFor(() => expect(second.end).toHaveBeenCalled());
    expect(probes.fresh).toHaveBeenCalledTimes(2);
    expect(probes.cached).not.toHaveBeenCalled();
    expect(first.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(second.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(first.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(second.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(JSON.parse(second.end.mock.calls[0]![0])).toEqual(complete);
  });

  it("allows a healthy collector that completes after the old five-second Pages deadline", async () => {
    vi.useFakeTimers();
    try {
      probes.fresh.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(complete), 9_000)));
      const r = response();
      handleFreshReleaseProbe(request("GET", `Bearer ${token}`), r.res, sb, config());
      expect(r.end).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(r.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
      expect(r.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns only a fixed failure when a dependency rejects", async () => {
    probes.fresh.mockRejectedValueOnce(new Error(`private ${token}`));
    const r = response();
    handleFreshReleaseProbe(request("GET", `Bearer ${token}`), r.res, sb, config());
    await vi.waitFor(() => expect(r.end).toHaveBeenCalled());
    expect(r.writeHead).toHaveBeenCalledWith(503, { "Content-Type": "application/json" });
    expect(r.end.mock.calls[0]![0]).not.toContain(token);
  });

  it("returns 503 for an incomplete live observation", async () => {
    probes.fresh.mockResolvedValueOnce({ ...complete, observationsComplete: false, reason: "gateway_unavailable" });
    const r = response();
    handleFreshReleaseProbe(request("GET", `Bearer ${token}`), r.res, sb, config());
    await vi.waitFor(() => expect(r.end).toHaveBeenCalled());
    expect(r.writeHead).toHaveBeenCalledWith(503, { "Content-Type": "application/json" });
  });
});
