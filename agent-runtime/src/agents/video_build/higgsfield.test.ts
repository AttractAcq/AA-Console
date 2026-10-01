import { afterEach, describe, expect, it, vi } from "vitest";
import { createHiggsfieldClient, HIGGSFIELD_BASE_URL, HIGGSFIELD_MOTIONS_PATH, HiggsfieldError, listMotions } from "./higgsfield.js";
import { resolveMotionPreset, ZOOM_IN_MOTION_ID } from "./motions.js";

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

describe("listMotions", () => {
  it("does not fetch when credentials are missing", async () => {
    const fetchImpl = vi.fn();
    const result = await listMotions({ apiKey: "", apiSecret: "secret" }, fetchImpl as typeof fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_higgsfield_credentials");
    expect(result.message).toContain("HIGGSFIELD_API_KEY");
    expect(result.message).not.toContain("secret");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the catalog from a mock and resolves only ids the catalog returned", async () => {
    const dollyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        motions: [{ id: ZOOM_IN_MOTION_ID, name: "Zoom In" }, { id: dollyId, name: "Dolly In" }],
      }),
    );
    const listed = await listMotions({ apiKey: "test-key", apiSecret: "test-secret" }, fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("catalog fetch was not made");
    const [url, init] = call;
    expect(String(url)).toBe(`${HIGGSFIELD_BASE_URL}${HIGGSFIELD_MOTIONS_PATH}`);
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Key test-key:test-secret");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(resolveMotionPreset("Dolly In", listed.motions)).toMatchObject({ ok: true, id: dollyId, via: "catalog" });
    expect(resolveMotionPreset("Orbit", listed.motions)).toEqual({ ok: false, preset: "Orbit" });
    expect(resolveMotionPreset("pending", listed.motions)).toMatchObject({ id: ZOOM_IN_MOTION_ID, via: "phase1_default" });
  });
});
