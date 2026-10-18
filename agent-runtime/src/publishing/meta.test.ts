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
  contentFormat: "single",
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

describe("carousels", () => {
  const CAROUSEL: PublishRequest = {
    ...BASE,
    contentFormat: "carousel",
    frames: [
      { position: 1, mediaUrl: "https://signed.example/f1.png" },
      { position: 2, mediaUrl: "https://signed.example/f2.png" },
      { position: 3, mediaUrl: "https://signed.example/f3.png" },
    ],
  };

  /** /media answers with a different id each time it is called. */
  function graphWithContainers(ids: string[], rest: Array<[RegExp, Reply]>) {
    let next = 0;
    const replies: Array<[RegExp, Reply]> = [
      [/\/media$|\/media\?/, { get body() { return { id: ids[next++] }; } } as Reply],
      ...rest,
    ];
    return graph(replies);
  }

  it("creates a child container per frame, then one carousel parent", async () => {
    const calls = graphWithContainers(
      ["child-1", "child-2", "child-3", "parent-1"],
      [[/media_publish/, { body: { id: "ig_carousel" } }]],
    );
    const result = await instagramAdapter.publish(CAROUSEL);
    expect(result).toMatchObject({ ok: true, externalId: "ig_carousel" });

    // Three children, each flagged as a carousel item.
    expect(calls.slice(0, 3).every((c) => c.body.includes("is_carousel_item=true"))).toBe(true);
    expect(calls[0]!.body).toContain("image_url=https%3A%2F%2Fsigned.example%2Ff1.png");
    expect(calls[2]!.body).toContain("image_url=https%3A%2F%2Fsigned.example%2Ff3.png");

    // Then the parent, naming all three in order, carrying the caption.
    expect(calls[3]!.body).toContain("media_type=CAROUSEL");
    expect(calls[3]!.body).toContain("children=child-1%2Cchild-2%2Cchild-3");
    expect(calls[3]!.body).toContain("caption=Five+steps");

    expect(calls[4]!.body).toContain("creation_id=parent-1");
  });

  it("describes the set once, on the cover frame", async () => {
    const calls = graphWithContainers(
      ["child-1", "child-2", "child-3", "parent-1"],
      [[/media_publish/, { body: { id: "ig_1" } }]],
    );
    await instagramAdapter.publish(CAROUSEL);
    expect(calls[0]!.body).toContain("alt_text=Cards+in+a+row.");
    expect(calls[1]!.body).not.toContain("alt_text");
    expect(calls[2]!.body).not.toContain("alt_text");
  });

  it("uploads each Facebook frame unpublished and attaches them to one post", async () => {
    let next = 0;
    const ids = ["photo-1", "photo-2", "photo-3"];
    const calls = graph([
      [/\/photos/, { get body() { return { id: ids[next++] }; } } as Reply],
      [/\/feed/, { body: { post_id: "page_1_post_9" } }],
    ]);
    const result = await facebookAdapter.publish({ ...CAROUSEL, platform: "facebook" });
    expect(result).toMatchObject({ ok: true, externalId: "page_1_post_9" });

    expect(calls.slice(0, 3).every((c) => c.body.includes("published=false"))).toBe(true);
    const feed = calls[3]!.body;
    expect(feed).toContain("attached_media%5B0%5D=%7B%22media_fbid%22%3A%22photo-1%22%7D");
    expect(feed).toContain("attached_media%5B2%5D=%7B%22media_fbid%22%3A%22photo-3%22%7D");
    expect(feed).toContain("message=Five+steps");
  });

  it("will not half-send a carousel it was handed wrong", async () => {
    graph([]);
    for (const adapter of [instagramAdapter, facebookAdapter]) {
      await expect(adapter.publish({ ...CAROUSEL, frames: [CAROUSEL.frames![0]!] })).rejects.toThrow(
        "between 2 and 10 frames",
      );
      await expect(adapter.publish({ ...CAROUSEL, frames: undefined })).rejects.toThrow(
        "between 2 and 10 frames",
      );
    }
  });

  it("retries a container that was not ready, because nothing went out", async () => {
    const calls = graphWithContainers(
      ["child-1", "child-2", "child-3", "parent-1"],
      [[/media_publish/, { status: 400, body: { error: { message: "Media ID is not available", code: 9007 } } }]],
    );
    await expect(instagramAdapter.publish(CAROUSEL)).rejects.toMatchObject({
      retryable: true,
    });
    expect(calls).toHaveLength(5);
  });
});

describe("stories", () => {
  const STORY: PublishRequest = {
    ...BASE,
    contentFormat: "story",
    frames: [
      { position: 1, mediaUrl: "https://signed.example/s1.png" },
      { position: 2, mediaUrl: "https://signed.example/s2.png" },
    ],
  };

  it("sends one Instagram frame as its own STORIES post", async () => {
    const calls = graph([
      [/\/media$|\/media\?/, { body: { id: "story-container-1" } }],
      [/media_publish/, { body: { id: "ig_story_1" } }],
    ]);
    const result = await instagramAdapter.publishFrame!(STORY, STORY.frames![0]!);
    expect(result).toMatchObject({ ok: true, externalId: "ig_story_1" });
    expect(calls[0]!.body).toContain("media_type=STORIES");
    expect(calls[0]!.body).toContain("image_url=https%3A%2F%2Fsigned.example%2Fs1.png");
    // A story has no caption field, so the composed words are not quietly
    // posted into one that would be ignored.
    expect(calls[0]!.body).not.toContain("caption=");
    expect(calls[1]!.body).toContain("creation_id=story-container-1");
  });

  it("waits for a video story container, as it does for a reel", async () => {
    const statuses = ["IN_PROGRESS", "FINISHED"];
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { body?: unknown }) => {
        const url = String(input);
        calls.push({ url, body: init?.body instanceof URLSearchParams ? init.body.toString() : "" });
        if (url.includes("media_publish")) return { ok: true, status: 200, json: async () => ({ id: "ig_v" }) };
        if (url.includes("/media")) return { ok: true, status: 200, json: async () => ({ id: "c-9" }) };
        return { ok: true, status: 200, json: async () => ({ status_code: statuses.shift() ?? "FINISHED" }) };
      }),
    );
    vi.useFakeTimers();
    const promise = instagramAdapter.publishFrame!(
      { ...STORY, mediaKind: "video" },
      STORY.frames![0]!,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await promise).externalId).toBe("ig_v");
    expect(calls[0]!.body).toContain("media_type=STORIES");
    expect(calls[0]!.body).toContain("video_url=");
  });

  it("uploads a Facebook frame unpublished, then makes it a story", async () => {
    const calls = graph([
      [/\/photos/, { body: { id: "photo-7" } }],
      [/photo_stories/, { body: { post_id: "page_story_7" } }],
    ]);
    const result = await facebookAdapter.publishFrame!(
      { ...STORY, platform: "facebook" },
      STORY.frames![1]!,
    );
    expect(result).toMatchObject({ ok: true, externalId: "page_story_7" });
    expect(calls[0]!.body).toContain("published=false");
    expect(calls[1]!.body).toContain("photo_id=photo-7");
  });

});

/**
 * Migration 222: the four surfaces that were left.
 *
 * Three of these change what happens to posts the adapters were already
 * sending -- a first comment that was accepted and dropped, a link that was
 * never read back, a reel that went to the feed. The fourth, a Facebook video
 * story, was refused outright.
 */
describe("the last four surfaces", () => {
  /** A fetch that records headers too, which the three-phase upload needs. */
  function withHeaders(answer: (url: string) => Reply) {
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
        const url = String(input);
        calls.push({
          url,
          body: init?.body instanceof URLSearchParams ? init.body.toString() : "",
          headers: init?.headers ?? {},
        });
        const reply = answer(url);
        return {
          ok: (reply.status ?? 200) < 400,
          status: reply.status ?? 200,
          json: async () => reply.body,
        };
      }),
    );
    return calls;
  }

  it("reads the permalink back, because Instagram's publish only returns an id", async () => {
    graph([
      [/\/media\?|\/media$/, { body: { id: "container-1" } }],
      [/media_publish/, { body: { id: "ig_17900" } }],
      [/permalink/, { body: { permalink: "https://www.instagram.com/p/ABC/" } }],
    ]);
    const result = await instagramAdapter.publish(BASE);
    expect(result.externalUrl).toBe("https://www.instagram.com/p/ABC/");
  });

  it("does not fail a published post because the link could not be read", async () => {
    graph([
      [/\/media\?|\/media$/, { body: { id: "container-1" } }],
      [/media_publish/, { body: { id: "ig_17900" } }],
      [/permalink/, { status: 500, body: { error: { message: "nope", code: 1 } } }],
    ]);
    const result = await instagramAdapter.publish(BASE);
    expect(result).toMatchObject({ ok: true, externalId: "ig_17900", externalUrl: null });
  });

  it("posts a first comment on a Facebook page post, which it used to drop", async () => {
    const calls = graph([
      [/\/photos/, { body: { post_id: "page_1_9" } }],
      [/comments/, { body: { id: "comment-1" } }],
    ]);
    const result = await facebookAdapter.publish({
      ...BASE,
      platform: "facebook",
      firstComment: "Full breakdown in the link.",
    });
    expect(result.externalId).toBe("page_1_9");
    expect(calls[1]!.url).toContain("page_1_9/comments");
    expect(calls[1]!.body).toContain("message=Full+breakdown");
  });

  it("does not fail a published Facebook post because its first comment did not land", async () => {
    graph([
      [/\/photos/, { body: { post_id: "page_1_9" } }],
      [/comments/, { status: 500, body: { error: { message: "nope", code: 1 } } }],
    ]);
    await expect(
      facebookAdapter.publish({ ...BASE, platform: "facebook", firstComment: "Anything." }),
    ).resolves.toMatchObject({ ok: true, externalId: "page_1_9" });
  });

  it("sends a Facebook reel to the reel surface, not into the page feed", async () => {
    const calls = withHeaders((url) => {
      if (url.includes("rupload")) return { body: { success: true } };
      if (url.includes("upload_phase")) return { body: {} };
      return { body: {} };
    });
    // start answers with a video id; finish answers with a post id.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: unknown, init?: Record<string, unknown>) => {
      const url = String(input);
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
      await original(input, init);
      if (url.includes("rupload")) return { ok: true, status: 200, json: async () => ({ success: true }) };
      if (body.includes("upload_phase=start")) {
        return { ok: true, status: 200, json: async () => ({ video_id: "vid-1" }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, post_id: "reel_9" }) };
    });

    const result = await facebookAdapter.publish({
      ...BASE,
      platform: "facebook",
      mediaKind: "video",
      contentFormat: "reel",
    });
    expect(result).toMatchObject({
      ok: true,
      externalId: "reel_9",
      externalUrl: "https://www.facebook.com/reel/reel_9",
    });

    expect(calls[0]!.url).toContain("/video_reels");
    expect(calls[0]!.body).toContain("upload_phase=start");
    // The middle phase is the only call in this file to another host, and the
    // token moves from the body to a header there.
    expect(calls[1]!.url).toBe("https://rupload.facebook.com/video-upload/v21.0/vid-1");
    expect(calls[1]!.headers.Authorization).toBe("OAuth a-token");
    expect(calls[1]!.headers.file_url).toBe("https://signed.example/cut.mp4");
    expect(calls[2]!.body).toContain("upload_phase=finish");
    expect(calls[2]!.body).toContain("video_id=vid-1");
    expect(calls[2]!.body).toContain("video_state=PUBLISHED");
  });

  it("sends a Facebook video story the same way, on its own surface", async () => {
    const calls = withHeaders(() => ({ body: {} }));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: unknown, init?: Record<string, unknown>) => {
      const url = String(input);
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
      await original(input, init);
      if (url.includes("rupload")) return { ok: true, status: 200, json: async () => ({ success: true }) };
      if (body.includes("upload_phase=start")) {
        return { ok: true, status: 200, json: async () => ({ video_id: "vid-2" }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true, post_id: "story_9" }) };
    });

    const result = await facebookAdapter.publishFrame!(
      { ...BASE, platform: "facebook", mediaKind: "video", contentFormat: "story" },
      { position: 2, mediaUrl: "https://signed.example/s2.mp4" },
    );
    expect(result.externalId).toBe("story_9");
    expect(calls[0]!.url).toContain("/video_stories");
    expect(calls[1]!.headers.file_url).toBe("https://signed.example/s2.mp4");
  });

  it("keeps an upload that failed retryable, because nothing is published until finish", async () => {
    withHeaders(() => ({ body: {} }));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: unknown, init?: Record<string, unknown>) => {
      const url = String(input);
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
      if (url.includes("rupload")) {
        return { ok: false, status: 500, json: async () => ({ error: { message: "upload host down" } }) };
      }
      if (body.includes("upload_phase=start")) {
        return { ok: true, status: 200, json: async () => ({ video_id: "vid-3" }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });

    await expect(
      facebookAdapter.publish({
        ...BASE,
        platform: "facebook",
        mediaKind: "video",
        contentFormat: "reel",
      }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("records the video id when the finish phase returns only success", async () => {
    withHeaders(() => ({ body: {} }));
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: unknown, init?: Record<string, unknown>) => {
      const url = String(input);
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
      if (url.includes("rupload")) return { ok: true, status: 200, json: async () => ({ success: true }) };
      if (body.includes("upload_phase=start")) {
        return { ok: true, status: 200, json: async () => ({ video_id: "vid-4" }) };
      }
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    });

    // It is out. Failing it for want of an id would be the lie this whole
    // run of migrations has been about.
    await expect(
      facebookAdapter.publish({
        ...BASE,
        platform: "facebook",
        mediaKind: "video",
        contentFormat: "reel",
      }),
    ).resolves.toMatchObject({ externalId: "vid-4" });
  });
});
