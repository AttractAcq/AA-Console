import { describe, expect, it, vi } from "vitest";
import { readVerifiedLocationField } from "./google-business.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const input = { accessToken: "reviewed-token", accountRef: "accounts/123/locations/456",
  field: "description" };

describe("read-only Google Business Profile field check", () => {
  it("verifies account membership and reads exactly one merchant field without PATCH", async () => {
    const mock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/accounts/123")) return json({ name: "accounts/123" });
      if (path.includes("/accounts/123/locations?")) return json({ locations: [{ name: "locations/456" }] });
      return json({ name: "locations/456", profile: { description: "After" } });
    });
    await expect(readVerifiedLocationField({ ...input, fetchImpl: mock as unknown as typeof fetch }))
      .resolves.toEqual({ externalRef: "locations/456#description", observedValue: "After" });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
    expect(String(mock.mock.calls[2]![0])).toContain("readMask=profile.description");
  });

  it("refuses a location outside the reviewed account before reading its field", async () => {
    const mock = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("/accounts/123") ? json({ name: "accounts/123" })
        : json({ locations: [{ name: "locations/other" }] }));
    await expect(readVerifiedLocationField({ ...input, fetchImpl: mock as unknown as typeof fetch }))
      .rejects.toThrow(/absent from the reviewed Business Profile account/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("canonicalizes hours for exact later comparison", async () => {
    const mock = vi.fn(async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.endsWith("/accounts/123")) return json({ name: "accounts/123" });
      if (path.includes("/accounts/123/locations?")) return json({ locations: [{ name: "locations/456" }] });
      return json({ name: "locations/456", regularHours: { periods: [{ openDay: "MONDAY", closeDay: "MONDAY" }] } });
    });
    await expect(readVerifiedLocationField({ ...input, field: "hours",
      fetchImpl: mock as unknown as typeof fetch }))
      .resolves.toEqual({ externalRef: "locations/456#hours",
        observedValue: '{"periods":[{"closeDay":"MONDAY","openDay":"MONDAY"}]}' });
  });
});
