import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("./supabase", () => ({ supabase: { auth: { getSession } } }));

import { callRuntime } from "./callRuntime";

describe("callRuntime", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("VITE_AGENT_RUNTIME_URL", "https://runtime.example.test");
    vi.stubGlobal("fetch", fetchMock);
    getSession.mockReset();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not send an admin request when the session has no access token", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    await expect(callRuntime("/admin/test", { secret: "body" })).rejects.toThrow(/sign in/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the bearer token and body when the user has a session", async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: "test-token" } }, error: null });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, job_id: "job-1" }) });

    await expect(callRuntime<{ job_id: string }>("/admin/test", { key: "value" })).resolves.toMatchObject({ job_id: "job-1" });
    expect(fetchMock).toHaveBeenCalledWith("https://runtime.example.test/admin/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ key: "value" }),
    });
  });
});
