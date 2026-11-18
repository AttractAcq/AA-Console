// @vitest-environment node
import { expect, it, vi } from "vitest";
import { checkHostedAuthFallback, FALLBACK_COUNT_SQL } from "./check-hosted-auth-fallback.mjs";

const refs = { production: "bancbdztffokwiifzoiv", staging: "vmmertwoboqiazcsougw" };
const token = `sbp_fc${"x".repeat(24)}`;

function response(totalUsers, matchingUsers) {
  return { ok: true, json: async () => [{ total_users: totalUsers,
    matching_users: matchingUsers }] };
}

it("passes only two verified zero-match aggregates through the read-only endpoint", async () => {
  const fetchImpl = vi.fn(async (url, options) => {
    expect(url).toMatch(/\/database\/query\/read-only$/);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ query: FALLBACK_COUNT_SQL });
    return response(url.includes(refs.production) ? 6 : 5, 0);
  });
  const result = await checkHostedAuthFallback(refs, token, fetchImpl);
  expect(result.status).toBe("pass");
  expect(result.counts.production).toMatchObject({ totalUsers: 6, matchingUsers: 0 });
  expect(result.counts.staging).toMatchObject({ totalUsers: 5, matchingUsers: 0 });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("blocks release for a positive staging aggregate and rejects unavailable counts", async () => {
  const fetchImpl = vi.fn(async (url) => response(url.includes(refs.production) ? 6 : 5,
    url.includes(refs.production) ? 0 : 5));
  expect((await checkHostedAuthFallback(refs, token, fetchImpl)).status).toBe("blocked");
  await expect(checkHostedAuthFallback(refs, token, async () => ({ ok: true,
    json: async () => [{ total_users: 5, matching_users: null }] })))
    .rejects.toThrow("auth_fallback_aggregate_unverified");
  await expect(checkHostedAuthFallback(refs, token, async () => ({ ok: false,
    status: 403 }))).rejects.toThrow("management_api_http_403");
});
