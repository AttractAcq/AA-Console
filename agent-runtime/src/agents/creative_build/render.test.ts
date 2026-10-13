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
