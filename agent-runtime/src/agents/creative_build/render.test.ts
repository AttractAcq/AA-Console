import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../../config.js";
import { renderImage } from "./render.js";

afterEach(() => vi.unstubAllGlobals());

it("sends a reel continuity frame to the image edits endpoint", async () => {
  const source = Buffer.from("reference-frame");
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const body = init.body as FormData;
    expect(body.get("model")).toBe("gpt-image-1");
    expect(body.get("prompt")).toBe("Keep the same founder in a new action");
    expect(await (body.get("image") as File).arrayBuffer()).toEqual(
      new Uint8Array(source).buffer,
    );
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("result").toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const rendered = await renderImage({
    openaiApiKey: "test-key", imageModel: "gpt-image-1",
  } as RuntimeConfig, "Keep the same founder in a new action", {
    size: "1024x1536", quality: "high",
    reference: { bytes: source, contentType: "image/png", filename: "reel-shot-1.png" },
  });

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/images/edits");
  expect(rendered.bytes.toString()).toBe("result");
});

it("overrides the model only for a precision-first reel render", async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body)).model).toBe("gpt-image-2.5-sunburst");
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("result").toString("base64") }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderImage({ openaiApiKey: "test-key", imageModel: "gpt-image-2" } as RuntimeConfig,
    "A consistent founder", { size: "1024x1536", quality: "high", model: "gpt-image-2.5-sunburst" });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/images/generations");
});

it("sends one text-only GPT-Image-2 generation and retains provider counters", async () => {
  const usage = { input_tokens: 25, output_tokens: 100, total_tokens: 125,
    input_tokens_details: { text_tokens: 25, image_tokens: 0 } };
  const onReceipt = vi.fn();
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    expect(options.redirect).toBe("error");
    expect(JSON.parse(String(options.body))).toEqual({ model: "gpt-image-2", n: 1,
      prompt: "Fictional illustration", size: "1024x1536", quality: "medium" });
    return new Response(JSON.stringify({ data: [{ b64_json: "YWJj" }], usage }),
      { headers: { "x-request-id": "req-fixture" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderImage({ openaiApiKey: "test-key", imageModel: "gpt-image-2" } as RuntimeConfig,
    "Fictional illustration", { size: "1024x1536", quality: "medium", onReceipt });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/images/generations");
  expect(onReceipt).toHaveBeenCalledWith({ requestId: "req-fixture", usage });
});
