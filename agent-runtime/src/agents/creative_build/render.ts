// Image rendering.
//
// Deliberately a thin, hand-rolled call rather than the OpenAI SDK: this is
// one endpoint, and adding a dependency to reach it would be the largest
// thing in this package by install size.
//
// The model id is configuration, not a constant. Provider model names change
// faster than this repo does, and a wrong one should be an env edit rather
// than a deploy.

import type { RuntimeConfig } from "../../config.js";

const ENDPOINT = "https://api.openai.com/v1/images/generations";
const TIMEOUT_MS = 180_000;

export class RenderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "RenderError";
    this.retryable = retryable;
  }
}

export interface RenderedImage {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

/** Portrait for feed and story, square for a generic post, landscape for a hero. */
export const SIZES = ["1024x1536", "1024x1024", "1536x1024"] as const;
export const QUALITIES = ["low", "medium", "high"] as const;

export async function renderImage(
  config: RuntimeConfig,
  prompt: string,
  opts: { size: string; quality: string },
): Promise<RenderedImage> {
  if (!config.openaiApiKey) {
    throw new RenderError(
      "No image renderer is configured. Set OPENAI_API_KEY on the runtime to enable AI image builds.",
      false,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.imageModel,
        prompt,
        size: opts.size,
        quality: opts.quality,
        n: 1,
      }),
    });

    const body = (await response.json().catch(() => null)) as {
      data?: Array<{ b64_json?: string; url?: string }>;
      error?: { message?: string; code?: string; type?: string };
    } | null;

    if (!response.ok) {
      const message = body?.error?.message ?? `Image API returned ${response.status}`;
      // 401/403 is a bad key and 400 is a bad request or a refused prompt —
      // none of those improve on a second attempt.
      const retryable = response.status === 429 || response.status >= 500;
      throw new RenderError(
        response.status === 400
          ? `${message} (the renderer refused this prompt — edit the concept and try again)`
          : message,
        retryable,
      );
    }

    const first = body?.data?.[0];
    if (first?.b64_json) {
      return {
        bytes: Buffer.from(first.b64_json, "base64"),
        contentType: "image/png",
        extension: "png",
      };
    }
    // Some responses hand back a URL instead of inline base64.
    if (first?.url) {
      const file = await fetch(first.url, { signal: controller.signal });
      if (!file.ok) throw new RenderError(`Could not download the rendered image (${file.status}).`, true);
      const type = file.headers.get("content-type") ?? "image/png";
      return {
        bytes: Buffer.from(await file.arrayBuffer()),
        contentType: type,
        extension: type.includes("webp") ? "webp" : type.includes("jpeg") ? "jpg" : "png",
      };
    }

    throw new RenderError("The image API returned no image.", true);
  } catch (error) {
    if (error instanceof RenderError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new RenderError(`Could not reach the image API: ${message}`, true);
  } finally {
    clearTimeout(timer);
  }
}
