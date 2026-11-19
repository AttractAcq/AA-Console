import { expect, test, vi } from "vitest";
import { readLocalPost } from "./google-business-post-read.js";

const input = { accessToken: "token", accountRef: "accounts/123/locations/456",
  externalId: "accounts/123/locations/456/localPosts/7",
  expectedSummary: "Approved result", mediaRequired: false };
const reply = (body: unknown, status = 200) => vi.fn(async () =>
  new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("GET verifies exact text, location and LIVE state without a write", async () => {
  const fetchImpl = reply({ name: input.externalId, summary: input.expectedSummary,
    state: "LIVE", searchUrl: "https://g.co/post" });
  const result = await readLocalPost({ ...input, fetchImpl });
  expect(result).toMatchObject({ status: "live_exact_text", providerState: "LIVE",
    providerUrl: "https://g.co/post" });
  expect(result.observedSummarySha256).toMatch(/^[0-9a-f]{64}$/);
  expect(fetchImpl).toHaveBeenCalledWith(
    `https://mybusiness.googleapis.com/v4/${input.externalId}`,
    expect.objectContaining({ method: "GET", redirect: "error" }));
});

test("a live media post remains unverified for media bytes", async () => {
  const result = await readLocalPost({ ...input, mediaRequired: true,
    fetchImpl: reply({ name: input.externalId, summary: input.expectedSummary, state: "LIVE" }) });
  expect(result.status).toBe("live_media_unverified");
});

test("wrong text or account never verifies a post", async () => {
  for (const body of [
    { name: input.externalId, summary: "Changed", state: "LIVE" },
    { name: "accounts/999/locations/888/localPosts/7", summary: input.expectedSummary, state: "LIVE" },
  ]) {
    expect((await readLocalPost({ ...input, fetchImpl: reply(body) })).status).toBe("mismatch");
  }
});

test("processing, 404 and transport failure never prove absence or live placement", async () => {
  expect((await readLocalPost({ ...input, fetchImpl: reply({
    name: input.externalId, summary: input.expectedSummary, state: "PROCESSING",
  }) })).status).toBe("nonlive");
  expect((await readLocalPost({ ...input, fetchImpl: reply({}, 404) })).status).toBe("not_found");
  expect((await readLocalPost({ ...input, fetchImpl: vi.fn(async () => {
    throw new Error("timeout");
  }) as unknown as typeof fetch })).status).toBe("unavailable");
});

test("invalid target never contacts Google", async () => {
  const fetchImpl = reply({});
  expect((await readLocalPost({ ...input, externalId: "https://evil.example/post",
    fetchImpl })).status).toBe("unavailable");
  expect(fetchImpl).not.toHaveBeenCalled();
});
