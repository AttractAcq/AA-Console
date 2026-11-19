import { describe, expect, it, vi } from "vitest";
import type { PublishRequest } from "./types.js";
import { readMetaPublication } from "./readback.js";

const request = {
  platform: "instagram", accountId: "17841400000000000", accessToken: "secret-marker",
} as PublishRequest;

function reply(body: unknown, status = 200) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ Authorization: "Bearer secret-marker" });
    return { ok: status < 400, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

describe("Meta publication account read-back", () => {
  it("verifies an Instagram media ID and exact owner", async () => {
    const fetchImpl = reply({ id: "123", owner: { id: request.accountId },
      permalink: "https://www.instagram.com/p/ABC/" });
    expect(await readMetaPublication(request, "123", fetchImpl)).toEqual({
      status: "verified", observedAccountRef: request.accountId,
      providerUrl: "https://www.instagram.com/p/ABC/",
    });
  });

  it("verifies a Facebook object against the expected Page", async () => {
    const fetchImpl = reply({ id: "12_34", from: { id: "12" },
      permalink_url: "https://www.facebook.com/12/posts/34" });
    expect(await readMetaPublication({ ...request, platform: "facebook", accountId: "12" },
      "12_34", fetchImpl)).toMatchObject({ status: "verified", observedAccountRef: "12" });
  });

  it("reports a wrong owner or ID as a mismatch", async () => {
    expect((await readMetaPublication(request, "123", reply({
      id: "123", owner: { id: "999" },
    }))).status).toBe("mismatch");
    expect((await readMetaPublication(request, "123", reply({
      id: "456", owner: { id: request.accountId },
    }))).status).toBe("mismatch");
  });

  it("keeps missing owner, HTTP failure and transport failure unverified", async () => {
    expect((await readMetaPublication(request, "123", reply({ id: "123" }))).status)
      .toBe("unavailable");
    expect((await readMetaPublication(request, "123", reply({ error: { message: "secret-marker" } }, 403))).status)
      .toBe("unavailable");
    const failed = vi.fn(async () => { throw new Error("secret-marker"); }) as unknown as typeof fetch;
    expect((await readMetaPublication(request, "123", failed)).status).toBe("unavailable");
  });

  it("rejects an unsafe provider URL without rejecting verified ownership", async () => {
    expect(await readMetaPublication(request, "123", reply({
      id: "123", owner: { id: request.accountId }, permalink: "https://example.com/p/123",
    }))).toMatchObject({ status: "verified", providerUrl: null });
  });

  it("refuses malformed IDs before contacting Meta", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await readMetaPublication(request, "../other", fetchImpl)).status).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
