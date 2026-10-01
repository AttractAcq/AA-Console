import { afterEach, describe, expect, it, vi } from "vitest";
import { createHiggsfieldClient, HIGGSFIELD_BASE_URL, HiggsfieldError } from "./higgsfield.js";

const MOTION = "11111111-1111-4111-8111-111111111111";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Higgsfield adapter", () => {
  it("submits DoP image-to-video and polls status without leaving the mock", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (init?.method === "POST") {
        return jsonResponse({
          request_id: "req_abc12345",
          status: "queued",
          status_url: `${HIGGSFIELD_BASE_URL}/requests/req_abc12345/status`,
          cancel_url: `${HIGGSFIELD_BASE_URL}/requests/req_abc12345/cancel`,
        });
      }
      expect(href).toBe(`${HIGGSFIELD_BASE_URL}/requests/req_abc12345/status`);
      return jsonResponse({
        status: "completed",
        video: { url: "https://cdn.example.test/clip.mp4" },
      });
    });
    const client = createHiggsfieldClient(
      { apiKey: "test-key", apiSecret: "test-secret" },
      fetchImpl as typeof fetch,
    );

    const submitted = await client.submitI2V({
      modelId: "higgsfield-ai/dop/lite",
      prompt: "Name the mechanism",
      imageUrl: "https://cdn.example.test/still.png",
      motions: [{ id: MOTION, strength: 1 }],
    });
    const polled = await client.pollStatus(submitted.requestId);

    expect(submitted.requestId).toBe("req_abc12345");
    expect(polled).toEqual({
      requestId: "req_abc12345",
      status: "completed",
      videoUrl: "https://cdn.example.test/clip.mp4",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [submitUrl, submitInit] = fetchImpl.mock.calls[0]!;
    expect(String(submitUrl)).toBe(`${HIGGSFIELD_BASE_URL}/higgsfield-ai/dop/lite`);
    expect(submitInit?.method).toBe("POST");
    const headers = new Headers(submitInit?.headers);
    expect(headers.get("Authorization")).toBe("Key test-key:test-secret");
    expect(JSON.parse(String(submitInit?.body))).toEqual({
      prompt: "Name the mechanism",
      image_url: "https://cdn.example.test/still.png",
      motions: [{ id: MOTION, strength: 1 }],
    });
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).toMatch(/^https:\/\/platform\.higgsfield\.ai\//);
    }
  });

  it("reads a still from images when the status payload has no video", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ status: "completed", images: [{ url: "https://cdn.example.test/frame.png" }] }),
    );
    const client = createHiggsfieldClient(
      { apiKey: "k", apiSecret: "s" },
      fetchImpl as typeof fetch,
    );
    const polled = await client.pollStatus("req_abc12345");
    expect(polled.videoUrl).toBe("https://cdn.example.test/frame.png");
  });

  it("does not call fetch when the motion id is not a catalog UUID", async () => {
    const fetchImpl = vi.fn();
    const client = createHiggsfieldClient(
      { apiKey: "k", apiSecret: "s" },
      fetchImpl as typeof fetch,
    );
    await expect(
      client.submitI2V({
        modelId: "higgsfield-ai/dop/lite",
        prompt: "Name it",
        imageUrl: "https://cdn.example.test/still.png",
        motions: [{ id: "pending", strength: 1 }],
      }),
    ).rejects.toBeInstanceOf(HiggsfieldError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not call fetch for a model id that would leave the Higgsfield host", async () => {
    const fetchImpl = vi.fn();
    const client = createHiggsfieldClient(
      { apiKey: "k", apiSecret: "s" },
      fetchImpl as typeof fetch,
    );
    await expect(
      client.submitI2V({
        modelId: "https://evil.example/steal",
        prompt: "Name it",
        imageUrl: "https://cdn.example.test/still.png",
        motions: [{ id: MOTION, strength: 1 }],
      }),
    ).rejects.toBeInstanceOf(HiggsfieldError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a 429 as retryable and does not include the response body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "test-secret leaked" }, 429));
    const client = createHiggsfieldClient(
      { apiKey: "test-key", apiSecret: "test-secret" },
      fetchImpl as typeof fetch,
    );
    await expect(client.pollStatus("req_abc12345")).rejects.toMatchObject({
      retryable: true,
      message: "Higgsfield returned 429.",
    });
  });

  it("refuses to construct a client without credentials", () => {
    expect(() => createHiggsfieldClient({ apiKey: " ", apiSecret: "s" }, vi.fn() as typeof fetch)).toThrow(
      /missing/i,
    );
  });
});
