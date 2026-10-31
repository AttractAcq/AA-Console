import { describe, expect, it, vi } from "vitest";
import { probeProvider } from "./provider-diagnostics.js";

const NOW = Date.UTC(2027, 0, 1, 12);
const TOKEN = "private-token-value";
const meta = {
  provider: "meta" as const,
  accessToken: TOKEN,
  expectedAccountId: "act_123",
  expectedAppId: "app-1",
  requiredScopes: ["ads_read"],
  now: () => NOW,
};
const valid = { data: { is_valid: true, app_id: "app-1", scopes: ["ads_read"],
  expires_at: Math.floor((NOW + 30 * 86_400_000) / 1000) } };

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("controlled provider diagnostics", () => {
  it("never routes unsupported provider credentials to Meta or any network endpoint", async () => {
    const fetchImpl = vi.fn();
    for (const provider of ["google_ads", "resend", "google", "facebook", "other"]) {
      const result = await probeProvider({ provider, accessToken: TOKEN,
        fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });
      expect(result.token.state).toBe("unknown");
      expect(result.account.state).toBe("unknown");
      expect(result.action.state).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("verifies only a Meta token, app, declared scopes and exact readable account", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply(valid))
      .mockResolvedValueOnce(reply({ id: "act_123" }));
    const result = await probeProvider({ ...meta, fetchImpl });
    expect(result).toMatchObject({
      provider: "meta", token: { state: "verified" }, app: { state: "verified" },
      scopes: { state: "verified" }, account: { state: "verified" },
      action: { state: "unknown" },
    });
    expect(result.expiresAt).toBe(new Date(NOW + 30 * 86_400_000).toISOString());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(new URL(url).hostname).toBe("graph.facebook.com");
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init.body).toBeUndefined();
    }
    expect(fetchImpl.mock.calls[1]![0]).toBe("https://graph.facebook.com/v21.0/act_123?fields=id");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("keeps action rights unknown even when the token and account read succeed", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(valid))
      .mockResolvedValueOnce(reply({ id: "17841400000000000" }));
    const result = await probeProvider({ provider: "instagram", accessToken: TOKEN,
      expectedAccountId: "17841400000000000", expectedAppId: "app-1",
      requiredScopes: ["ads_read"], fetchImpl, now: () => NOW });
    expect(result.account.state).toBe("verified");
    expect(result.action.state).toBe("unknown");
  });

  it.each([
    [{ data: { is_valid: false } }, "blocked"],
    [{ error: { code: 190 } }, "blocked"],
    [{ data: { is_valid: true, expires_at: Math.floor((NOW - 1000) / 1000) } }, "blocked"],
    [{ data: {} }, "unknown"],
    [{ data: { is_valid: true, error: { code: 613 } } }, "unknown"],
  ] as const)("handles invalid, expired and uncertain Meta token responses without account calls", async (body, state) => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(body));
    const result = await probeProvider({ ...meta, fetchImpl });
    expect(result.token.state).toBe(state);
    expect(result.account.state).toBe("unknown");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats HTTP 200 malformed JSON and provider faults as unknown, not revocation", async () => {
    for (const response of [new Response("not json", { status: 200 }), reply({}, 503)]) {
      const fetchImpl = vi.fn().mockResolvedValue(response);
      const result = await probeProvider({ ...meta, fetchImpl });
      expect(result.token.state).toBe("unknown");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("stops on a wrong app or missing declared scope before reading an account", async () => {
    const wrongApp = vi.fn().mockResolvedValue(reply({ data: { ...valid.data, app_id: "other" } }));
    expect((await probeProvider({ ...meta, fetchImpl: wrongApp })).app.state).toBe("blocked");
    expect(wrongApp).toHaveBeenCalledTimes(1);
    const missingScope = vi.fn().mockResolvedValue(reply({ data: { ...valid.data, scopes: [] } }));
    expect((await probeProvider({ ...meta, fetchImpl: missingScope })).scopes.state).toBe("blocked");
    expect(missingScope).toHaveBeenCalledTimes(1);
  });

  it("never treats an unconfigured app or scope policy as verified", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(valid))
      .mockResolvedValueOnce(reply({ id: "act_123" }));
    const result = await probeProvider({ ...meta, expectedAppId: null,
      requiredScopes: [], fetchImpl });
    expect(result.app.state).toBe("unknown");
    expect(result.scopes.state).toBe("unknown");
    expect(result.account.state).toBe("verified");
  });

  it("blocks an exact account mismatch and invalid IDs without leaking credentials", async () => {
    const mismatch = vi.fn().mockResolvedValueOnce(reply(valid))
      .mockResolvedValueOnce(reply({ id: "act_999" }));
    const result = await probeProvider({ ...meta, fetchImpl: mismatch });
    expect(result.account.state).toBe("blocked");
    const invalid = vi.fn();
    const invalidResult = await probeProvider({ ...meta,
      expectedAccountId: "https://outside.example/path", fetchImpl: invalid });
    expect(invalidResult.account.state).toBe("blocked");
    expect(invalid).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("does not accept an account ID beside a provider error envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply(valid))
      .mockResolvedValueOnce(reply({ id: "act_123", error: { code: 613 } }));
    const result = await probeProvider({ ...meta, fetchImpl });
    expect(result.account.state).toBe("unknown");
  });

  it("reads only the exact Business Profile location and leaves posting unknown", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply({ name: "accounts/a1/locations/l2" }));
    const result = await probeProvider({ provider: "google_business", accessToken: TOKEN,
      expectedLocationRef: "accounts/a1/locations/l2", fetchImpl, now: () => NOW });
    expect(result).toMatchObject({ token: { state: "verified" }, account: { state: "verified" },
      scopes: { state: "unknown" }, action: { state: "unknown" } });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://mybusiness.googleapis.com/v4/accounts/a1/locations/l2");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "error" });
    expect(fetchImpl.mock.calls[0]![1].body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("blocks a wrong or inaccessible Business Profile location, but preserves uncertainty on faults", async () => {
    for (const [response, state] of [
      [reply({ name: "accounts/a1/locations/other" }), "blocked"],
      [reply({ error: "denied" }, 403), "blocked"],
      [reply({ error: "busy" }, 503), "unknown"],
      [new Response("not json", { status: 200 }), "unknown"],
      [reply({ name: "accounts/a1/locations/l2", error: { code: 429 } }), "unknown"],
    ] as const) {
      const fetchImpl = vi.fn().mockResolvedValue(response);
      const result = await probeProvider({ provider: "google_business", accessToken: TOKEN,
        expectedLocationRef: "accounts/a1/locations/l2", fetchImpl });
      expect(result.account.state).toBe(state);
    }
    const fetchImpl = vi.fn();
    const invalid = await probeProvider({ provider: "google_business", accessToken: TOKEN,
      expectedLocationRef: "https://outside.example", fetchImpl });
    expect(invalid.account.state).toBe("blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
