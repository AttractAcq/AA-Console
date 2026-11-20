import { describe, expect, it, vi } from "vitest";
import { assertMetaPublishPrerequisites } from "./preflight.js";

const token = "private-token-marker";
const appId = "app-123";
const accountId = "17841400000000000";
const instagramScopes = ["instagram_basic", "instagram_content_publish", "pages_read_engagement"];
const facebookScopes = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status,
    json: async () => body } as Response;
}

function probe(platform: "instagram" | "facebook", overrides: {
  appId?: string; scopes?: readonly string[]; account?: string; pageToken?: string;
  tasks?: readonly string[]; valid?: boolean; failAt?: number;
} = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    if (calls.length === overrides.failAt) return response({ error: { message: token } }, 403);
    if (url.includes("/debug_token?")) return response({ data: {
      is_valid: overrides.valid ?? true, expires_at: 0,
      app_id: overrides.appId ?? appId,
      scopes: overrides.scopes ?? (platform === "instagram" ? instagramScopes : facebookScopes),
    } });
    expect(init?.headers).toEqual({ Authorization: `Bearer ${token}` });
    if (url.endsWith("/me?fields=id")) return response({ id: overrides.pageToken ?? accountId });
    if (url.includes("?fields=id%2Ctasks")) return response({
      id: overrides.account ?? accountId, tasks: overrides.tasks ?? ["CREATE_CONTENT"],
    });
    if (url.endsWith("/content_publishing_limit")) return response({ data: [] });
    if (url.endsWith("?fields=id")) return response({ id: overrides.account ?? accountId });
    throw new Error("Unexpected URL");
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("Meta publication preflight", () => {
  it("checks the exact Instagram account, app, token scopes and publishing-limit read", async () => {
    const { calls, fetchImpl } = probe("instagram");
    await assertMetaPublishPrerequisites({ platform: "instagram", accountId, accessToken: token,
      expectedAppId: appId, fetchImpl });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain(`/${accountId}/content_publishing_limit`);
  });

  it("checks a Facebook Page token and a content task", async () => {
    const { calls, fetchImpl } = probe("facebook");
    await assertMetaPublishPrerequisites({ platform: "facebook", accountId, accessToken: token,
      expectedAppId: appId, fetchImpl });
    expect(calls).toHaveLength(4);
    expect(calls[2]).toContain("/me?fields=id");
  });

  it.each([
    ["another app", "instagram", { appId: "other-app" }, /another Meta app/],
    ["missing scope", "instagram", { scopes: ["instagram_basic"] }, /required Meta scopes/],
    ["expired token", "instagram", { valid: false }, /invalid or expired/],
    ["wrong account", "instagram", { account: "42" }, /exact publication account/],
    ["user token", "facebook", { pageToken: "42" }, /exact Facebook Page token/],
    ["missing task", "facebook", { tasks: [] }, /content task/],
  ] as const)("refuses %s before publication", async (_label, platform, overrides, message) => {
    const { fetchImpl } = probe(platform, overrides);
    await expect(assertMetaPublishPrerequisites({ platform, accountId, accessToken: token,
      expectedAppId: appId, fetchImpl })).rejects.toThrow(message);
  });

  it("requires an expected app ID without requesting the provider", async () => {
    const { calls, fetchImpl } = probe("instagram");
    await expect(assertMetaPublishPrerequisites({ platform: "instagram", accountId,
      accessToken: token, expectedAppId: null, fetchImpl })).rejects.toThrow(/Meta app ID/);
    expect(calls).toHaveLength(0);
  });

  it("keeps provider response and credential out of a failed preflight error", async () => {
    const { fetchImpl } = probe("instagram", { failAt: 2 });
    let message = "";
    try {
      await assertMetaPublishPrerequisites({ platform: "instagram", accountId,
        accessToken: token, expectedAppId: appId, fetchImpl });
    } catch (error) { message = String(error); }
    expect(message).toMatch(/HTTP 403/);
    expect(message).not.toContain(token);
  });
});
