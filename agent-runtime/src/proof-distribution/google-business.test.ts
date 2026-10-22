import { describe, expect, it, vi } from "vitest";

import { createLocalPost, PlacementTransportError, SUMMARY_LIMIT } from "./google-business.js";

/**
 * The transport, with Google faked.
 *
 * The assertions worth having are about which failures are allowed to be
 * retried, because a proof post on a public profile cannot be unposted. A
 * wrong answer here either posts a customer's words twice or gives up on a
 * rate limit.
 */

const ok = (body: unknown, status = 200) =>
  vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;

/**
 * The error from a call that must fail.
 *
 * A `.catch` that returns the thrown value gives back a union with the
 * success type, so every assertion about `retryable` has to be cast. Worse,
 * it reads as a pass if the call unexpectedly succeeds. This throws in that
 * case, which is the assertion the file actually wants.
 */
async function refusal(
  request: Parameters<typeof createLocalPost>[0],
): Promise<PlacementTransportError> {
  try {
    await createLocalPost(request);
  } catch (thrown) {
    return thrown as PlacementTransportError;
  }
  throw new Error("Expected the post to be refused, and it was not.");
}

const base = {
  accessToken: "a-token",
  accountRef: "accounts/123/locations/456",
  summary: "They said it took half as long.",
};

describe("what it refuses before sending anything", () => {
  it("refuses a location that is not a Business Profile location", async () => {
    const fetchImpl = ok({});
    await expect(
      createLocalPost({ ...base, accountRef: "456", fetchImpl }),
    ).rejects.toThrow("is not a Business Profile location");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an empty payload", async () => {
    const fetchImpl = ok({});
    await expect(createLocalPost({ ...base, summary: "   ", fetchImpl })).rejects.toThrow(
      "no words to post",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to shorten a payload that is too long, rather than cutting it", async () => {
    const fetchImpl = ok({});
    // Truncating would publish something nobody approved, which is the one
    // thing the whole module exists to prevent.
    await expect(
      createLocalPost({ ...base, summary: "x".repeat(SUMMARY_LIMIT + 1), fetchImpl }),
    ).rejects.toThrow("Shorten the approved version");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("what it sends", () => {
  it("posts the approved words to the location's localPosts, and nothing else", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ name: "accounts/123/locations/456/localPosts/9" }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await createLocalPost({ ...base, fetchImpl });

    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]!;
    expect(url).toBe("https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer a-token");
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent.summary).toBe(base.summary);
    expect(sent.media).toBeUndefined();
    expect(result.externalId).toBe("accounts/123/locations/456/localPosts/9");
  });

  it("includes media and a call to action only when the placement carries them", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ name: "n", searchUrl: "https://g.co/p" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await createLocalPost({
      ...base,
      mediaUrl: "https://signed.example/a.png",
      linkUrl: "https://client.example/offer",
      fetchImpl,
    });

    const sent = JSON.parse(
      String(
        (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]
          .body,
      ),
    ) as Record<string, unknown>;
    expect(sent.media).toEqual([
      { mediaFormat: "PHOTO", sourceUrl: "https://signed.example/a.png" },
    ]);
    expect(sent.callToAction).toEqual({
      actionType: "LEARN_MORE",
      url: "https://client.example/offer",
    });
    expect(result.externalUrl).toBe("https://g.co/p");
  });
});

describe("which failures may be tried again", () => {
  it("retries a rate limit and a server error", async () => {
    for (const status of [408, 429, 500, 503]) {
      const error = await refusal({ ...base, fetchImpl: ok("slow down", status) });
      expect(error.retryable, `${status} should be retryable`).toBe(true);
    }
  });

  it("does not retry a refusal the API chose", async () => {
    // A revoked token, a location the credential cannot see, a payload it
    // rejected. Three identical refusals in the log is not diligence.
    for (const status of [400, 401, 403, 404]) {
      const error = await refusal({ ...base, fetchImpl: ok("no", status) });
      expect(error.retryable, `${status} should not be retryable`).toBe(false);
      expect(error.message).toContain(String(status));
    }
  });

  it("retries a request that got no response at all", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const error = await refusal({ ...base, fetchImpl });
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("socket hang up");
  });

  it("treats an accepted post with no id as a failure to go and look at", async () => {
    // Worse than a plain failure: the post may be live with nothing recorded
    // that could retract it.
    const error = await refusal({ ...base, fetchImpl: ok({ searchUrl: "https://g.co/p" }) });
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Check the profile");
  });
});
