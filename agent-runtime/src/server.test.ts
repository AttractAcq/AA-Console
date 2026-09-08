import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listen: vi.fn(), stop: vi.fn(), handler: undefined as any }));
vi.mock("node:http", () => ({ default: { createServer: (handler: any) => {
  mocks.handler = handler;
  return { listen: mocks.listen, close: vi.fn() };
} } }));
vi.mock("./config.js", () => ({ loadConfig: () => ({ enabled: false, healthPort: 4567, allowedOrigins: [] }) }));
vi.mock("./db.js", () => ({ serviceClient: () => ({}) }));
vi.mock("./worker.js", () => ({ startWorker: vi.fn() }));
vi.mock("./heartbeat.js", () => ({ startHeartbeat: () => ({ stop: mocks.stop }) }));
vi.mock("./orchestration/dispatch.js", () => ({ registeredAgentKeys: () => [] }));
vi.mock("./master/route.js", () => ({ handleMasterChat: vi.fn() }));
vi.mock("./mcp/brief-route.js", () => ({ handleMcpBrief: vi.fn() }));
vi.mock("./logging/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
it("binds the configured port on all IPv4 interfaces and serves public liveness", async () => {
  const signals = vi.spyOn(process, "on").mockReturnValue(process);
  try {
    await import("./server.js");
    expect(mocks.listen).toHaveBeenCalledWith(4567, "0.0.0.0", expect.any(Function));
    const res = { writeHead: vi.fn(), end: vi.fn() };
    mocks.handler({ url: "/health", method: "GET", headers: {} }, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(JSON.parse(res.end.mock.calls[0]![0])).toEqual({ ok: true, enabled: false, workers: 0, pid: process.pid });
  } finally { signals.mockRestore(); }
});
