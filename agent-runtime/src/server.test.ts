import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listen: vi.fn(), stop: vi.fn(), release: vi.fn(), handler: undefined as any }));
vi.mock("node:http", () => ({ default: { createServer: (handler: any) => {
  mocks.handler = handler;
  return { listen: mocks.listen, close: vi.fn() };
} } }));
vi.mock("./config.js", () => ({ loadConfig: () => ({ enabled: false, healthPort: 4567, allowedOrigins: [] }) }));
vi.mock("./db.js", () => ({ serviceClient: () => ({}) }));
vi.mock("./worker.js", () => ({ startWorker: vi.fn() }));
vi.mock("./heartbeat.js", () => ({ startHeartbeat: () => ({ stop: mocks.stop }) }));
vi.mock("./readiness/release-probe.js", () => ({ currentReleaseProbe: mocks.release }));
vi.mock("./orchestration/dispatch.js", () => ({ registeredAgentKeys: () => [] }));
vi.mock("./master/route.js", () => ({ handleMasterChat: vi.fn() }));
vi.mock("./mcp/brief-route.js", () => ({ handleMcpBrief: vi.fn() }));
vi.mock("./mcp/content-route.js", () => ({ handleMcpContent: vi.fn() }));
vi.mock("./mcp/auth-route.js", () => ({ handleMcpAuth: vi.fn() }));
vi.mock("./logging/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
it("binds the configured port on all IPv4 interfaces and serves public liveness", async () => {
  const signals = vi.spyOn(process, "on").mockReturnValue(process);
  try {
    await import("./server.js");
    expect(mocks.listen).toHaveBeenCalledWith(4567, "0.0.0.0", expect.any(Function));
    const res = { writeHead: vi.fn(), end: vi.fn() };
    mocks.handler({ url: "/health", method: "GET", headers: {} }, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(JSON.parse(res.end.mock.calls[0]![0])).toEqual({
      ok: true, enabled: false, workflowEnabled: false, workers: 0, pid: process.pid,
    });
  } finally { signals.mockRestore(); }
});

it("serves a minimal public release probe and fails closed on a dependency error", async () => {
  const signals = vi.spyOn(process, "on").mockReturnValue(process);
  try {
    await import("./server.js");
    const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    mocks.release.mockResolvedValueOnce({ observationsComplete: true, runtimeSha: "a".repeat(40), gatewaySha: "b".repeat(40), migrationHead: "20261030160000" });
    mocks.handler({ url: "/release/identities", method: "GET", headers: {} }, res);
    await vi.waitFor(() => expect(res.end).toHaveBeenCalled());
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(JSON.parse(res.end.mock.calls[0]![0])).toMatchObject({ observationsComplete: true, migrationHead: "20261030160000" });

    const failed = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    mocks.release.mockRejectedValueOnce(new Error("private detail"));
    mocks.handler({ url: "/release/identities", method: "GET", headers: {} }, failed);
    await vi.waitFor(() => expect(failed.end).toHaveBeenCalled());
    expect(failed.writeHead).toHaveBeenCalledWith(503, { "Content-Type": "application/json" });
    expect(failed.end.mock.calls[0]![0]).not.toContain("private detail");

    const wrongMethod = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
    mocks.handler({ url: "/release/identities", method: "POST", headers: {} }, wrongMethod);
    expect(wrongMethod.writeHead).toHaveBeenCalledWith(405, { "Content-Type": "application/json" });
    expect(mocks.release).toHaveBeenCalledTimes(2);
  } finally { signals.mockRestore(); }
});
