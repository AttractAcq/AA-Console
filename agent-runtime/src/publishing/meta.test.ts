import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { facebookAdapter, instagramAdapter } from "./meta.js";
import { PublishError, type PublishRequest } from "./types.js";

const BASE: PublishRequest = {
  postId: "post-1",
  clientId: "client-1",
  platform: "instagram",
  accessToken: "a-token",
  accountId: "17841400000000000",
  mediaUrl: "https://signed.example/cut.mp4",
  mediaKind: "image",
  caption: "Five steps, one chain.",
  firstComment: null,
  altText: "Cards in a row.",
  linkUrl: null,
};

interface Reply {
  status?: number;
  body: unknown;
}

/** A fetch that answers by URL fragment, and records what it was asked. */
function graph(replies: Array<[RegExp, Reply]>) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    calls.push({ url, method: init?.method ?? "GET", body });
    const match = replies.find(([pattern]) => pattern.test(url));
    const reply = match?.[1] ?? { status: 404, body: { error: { message: "unmatched", code: 9999 } } };
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      json: async () => reply.body,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Instagram", () => {
  it("creates a container and then publishes it", async () => {
    const calls = graph([
      [/\/media\?|\/media$/, { body: { id: "container-1" } }],
      [/media_publish/, { body: { id: "ig_17900" } }],
    ]);
    const result = await instagramAdapter.publish(BASE);
    expect(result).toMatchObject({ ok: true, externalId: "ig_17900" });

    expect(calls[0]!.url).toContain("/media");
    expect(calls[0]!.body).toContain("image_url=https%3A%2F%2Fsigned.example%2Fcut.mp4");
    expect(calls[1]!.body).toContain("creation_id=container-1");
  });

  it("sends a video as a reel, and waits for the container", async () => {
    const statuses = ["IN_PROGRESS", "FINISHED"];
    const calls = graph([
      [/\/media$|\/media\?/, { body: { id: "container-2" } }],
      [/container-2/, { body: {} }],
      [/media_publish/, { body: { id: "ig_2" } }],
    ]);
    // The container poll answers from the queue above.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.includes("media_publish")) return { ok: true, status: 200, json: async () => ({ id: "ig_2" }) };
      if (url.includes("/media")) return { ok: true, status: 200, json: async () => ({ id: "container-2" }) };
      return { ok: true, status: 200, json: async () => ({ status_code: statuses.shift() ?? "FINISHED" }) };
    });

    vi.useFakeTimers();
    const promise = instagramAdapter.publish({ ...BASE, mediaKind: "video" });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await promise;
    expect(result.externalId).toBe("ig_2");
    expect(calls[0]!.body).toContain("media_type=REELS");
    expect(calls[0]!.body).toContain("video_url=");
  });

  it("does not publish a container the platform could not process", async () => {
    graph([
      [/\/media$|\/media\?/, { body: { id: "container-3" } }],
      [/container-3/, { body: { status_code: "ERROR", status: "the video is too long" } }],
    ]);
    await expect(instagramAdapter.publish({ ...BASE, mediaKind: "video" })).rejects.toMatchObject({
      message: expect.stringContaining("too long"),
      retryable: false,
    });
  });

  it("gives up on a container still processing, and says it may be retried", async () => {
    // Nothing has been published, so another attempt is a fresh container
    // rather than a second post.
    graph([
      [/\/media$|\/media\?/, { body: { id: "container-4" } }],
      [/container-4/, { body: { status_code: "IN_PROGRESS" } }],
    ]);
    vi.useFakeTimers();
    const promise = instagramAdapter.publish({ ...BASE, mediaKind: "video" });
    const caught = promise.catch((e: PublishError) => e);
    await vi.advanceTimersByTimeAsync(20 * 6_000 + 1_000);
    const error = await caught;
    expect(error).toMatchObject({ retryable: true, message: expect.stringContaining("still processing") });
  });

  it("does not fail a published post because its first comment failed", async () => {
    // The post is out. Calling it failed would un-publish something on a
    // board that cannot be un-published on the platform.
    graph([
      [/\/media$|\/media\?/, { body: { id: "container-5" } }],
      [/media_publish/, { body: { id: "ig_5" } }],
      [/comments/, { status: 400, body: { error: { message: "nope", code: 100 } } }],
    ]);
    const result = await instagramAdapter.publish({ ...BASE, firstComment: "More below." });
    expect(result.externalId).toBe("ig_5");
  });

  it("refuses a publish that came back without an id", async () => {
    graph([
      [/\/media$|\/media\?/, { body: { id: "container-6" } }],
      [/media_publish/, { body: {} }],
    ]);
    await expect(instagramAdapter.publish(BASE)).rejects.toMatchObject({ retryable: false });
  });

  it("keeps the token out of the query string on a write", async () => {
    const calls = graph([
      [/\/media$|\/media\?/, { body: { id: "c" } }],
      [/media_publish/, { body: { id: "ig_7" } }],
    ]);
    await instagramAdapter.publish(BASE);
    for (const call of calls) {
      if (call.method === "POST") expect(call.url).not.toContain("a-token");
    }
  });
});

describe("Facebook", () => {
  it("posts a photo to the page and says where to look", async () => {
    const calls = graph([[/photos/, { body: { id: "photo-1", post_id: "page_1_2" } }]]);
    const result = await facebookAdapter.publish({ ...BASE, platform: "facebook", accountId: "page_1" });
    expect(result).toMatchObject({ ok: true, externalId: "page_1_2" });
    expect(result.externalUrl).toContain("page_1_2");
    expect(calls[0]!.body).toContain("caption=Five");
  });

  it("posts a video to the page", async () => {
    const calls = graph([[/videos/, { body: { id: "vid_1" } }]]);
    const result = await facebookAdapter.publish({
      ...BASE,
      platform: "facebook",
      accountId: "page_1",
      mediaKind: "video",
    });
    expect(result.externalId).toBe("vid_1");
    expect(calls[0]!.body).toContain("file_url=");
  });
});

describe("whether another attempt could work", () => {
  it("does not retry a credential problem", async () => {
    graph([[/\/media/, { status: 400, body: { error: { message: "token expired", code: 190 } } }]]);
    await expect(instagramAdapter.publish(BASE)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("needs reconnecting"),
    });
  });

  it("retries a rate limit", async () => {
    graph([[/\/media/, { status: 400, body: { error: { message: "too many", code: 4 } } }]]);
    await expect(instagramAdapter.publish(BASE)).rejects.toMatchObject({ retryable: true });
  });

  it("retries a server error", async () => {
    graph([[/\/media/, { status: 503, body: {} }]]);
    await expect(instagramAdapter.publish(BASE)).rejects.toMatchObject({ retryable: true });
  });

  it("does not retry something it does not recognise", async () => {
    // The default has to be "do not", because an unknown error could mean
    // the post went out and the response was lost.
    graph([[/\/media/, { status: 400, body: { error: { message: "mystery", code: 8888 } } }]]);
    await expect(instagramAdapter.publish(BASE)).rejects.toMatchObject({ retryable: false });
  });

  it("notices an error inside a 200", async () => {
    // Graph answers 200 with an error body often enough that checking only
    // the status is how you ship a publisher that reports success on failure.
    graph([[/\/media/, { status: 200, body: { error: { message: "nope", code: 190 } } }]]);
    await expect(instagramAdapter.publish(BASE)).rejects.toMatchObject({ retryable: false });
  });
});
