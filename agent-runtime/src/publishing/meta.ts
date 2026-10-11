/**
 * Instagram and Facebook, through the Graph API.
 *
 * One file because they are one API with one token model and two endpoints,
 * the same reason paid and organic metrics are one connector. Splitting them
 * would duplicate the error classification, which is the part that actually
 * matters here.
 *
 * Instagram is two calls and a wait: create a container, then publish it.
 * A video container is not ready the instant it is created, and publishing
 * an unfinished one fails with a message about the media not being ready —
 * so the container is polled, and the poll is bounded.
 */

import type { Platform } from "../content/platform-limits.js";
import { PublishError, type PublishAdapter, type PublishRequest, type PublishSuccess } from "./types.js";

const GRAPH_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 60_000;
/** A reel of a minute or two finishes well inside this. */
const CONTAINER_POLLS = 20;
const CONTAINER_POLL_MS = 6_000;

/**
 * Meta's codes, mapped to whether another attempt could plausibly work.
 * Same table as the metrics ingest, and the same reasoning: an expired token
 * retried in five minutes is still expired.
 *
 * The default is NOT retryable, which is the opposite of what a queue
 * usually wants. Here an unknown error could mean the post went out and the
 * response was lost, and retrying that posts twice.
 */
function classify(status: number, body: unknown): PublishError {
  const error = (body as { error?: { message?: string; code?: number; error_subcode?: number } })?.error;
  const code = error?.code;
  const message = error?.message ?? `Graph API returned ${status}`;

  if (code === 190 || code === 200 || code === 10) {
    return new PublishError(`${message} (the client's Meta credential needs reconnecting)`, false);
  }
  // 4 app / 17 user / 32 page / 613 custom rate limits, 1 and 2 transient.
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 1 || code === 2) {
    return new PublishError(`${message} (rate limited)`, true);
  }
  if (status === 429 || status >= 500) return new PublishError(message, true);
  return new PublishError(message, false);
}

async function graph(
  path: string,
  init: { method: "GET" | "POST"; token: string; body?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = new URL(`${BASE}/${path}`);
    // The token goes in the body on a write and the query on a read. Never
    // in a log line either way.
    const form = new URLSearchParams({ ...(init.body ?? {}), access_token: init.token });
    const response =
      init.method === "POST"
        ? await fetch(url, { method: "POST", body: form, signal: controller.signal })
        : await fetch(`${url}?${form.toString()}`, { signal: controller.signal });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw classify(response.status, payload);
    // Graph returns 200 with an error body often enough that only checking
    // the status is how you ship a publisher that reports success on
    // failure. The metrics ingest learned this the same way.
    if (payload && "error" in payload) throw classify(200, payload);
    return payload ?? {};
  } catch (error) {
    if (error instanceof PublishError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // A timeout is the one case worth another attempt, and the one most
    // likely to have landed. Retryable, because the alternative is a post
    // that never goes out because a socket hiccupped — and a double post is
    // caught by the duplicate check below.
    throw new PublishError(`Could not reach the Graph API: ${message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForContainer(containerId: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < CONTAINER_POLLS; attempt += 1) {
    const status = await graph(containerId, { method: "GET", token, body: { fields: "status_code,status" } });
    const code = String(status.status_code ?? "");
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new PublishError(
        `Instagram could not process the media: ${String(status.status ?? code)}`,
        false,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_MS));
  }
  // Still not finished. Retryable: nothing has been published, so another
  // attempt is a fresh container rather than a second post.
  throw new PublishError("Instagram is still processing the media after two minutes.", true);
}

export const instagramAdapter: PublishAdapter = {
  provider: "instagram",
  platforms: ["instagram"] as readonly Platform[],
  // The IG user id lives where the metrics ingest already reads it from.
  accountColumn: "credential_label",

  async publish(request: PublishRequest): Promise<PublishSuccess> {
    const container = await graph(`${request.accountId}/media`, {
      method: "POST",
      token: request.accessToken,
      body: {
        caption: request.caption,
        ...(request.mediaKind === "video"
          ? { media_type: "REELS", video_url: request.mediaUrl }
          : { image_url: request.mediaUrl }),
        ...(request.altText ? { alt_text: request.altText } : {}),
      },
    });
    const containerId = String(container.id ?? "");
    if (!containerId) throw new PublishError("Instagram returned no container id.", true);

    if (request.mediaKind === "video") await waitForContainer(containerId, request.accessToken);

    const published = await graph(`${request.accountId}/media_publish`, {
      method: "POST",
      token: request.accessToken,
      body: { creation_id: containerId },
    });
    const id = String(published.id ?? "");
    if (!id) throw new PublishError("Instagram published the container but returned no post id.", false);

    if (request.firstComment) {
      // A first comment that fails is not a failed post. The post is out;
      // saying it failed would un-publish something on a board that cannot
      // be un-published on the platform.
      await graph(`${id}/comments`, {
        method: "POST",
        token: request.accessToken,
        body: { message: request.firstComment },
      }).catch(() => undefined);
    }

    return { ok: true, externalId: id, externalUrl: null, detail: "Published to Instagram." };
  },
};

export const facebookAdapter: PublishAdapter = {
  provider: "meta",
  platforms: ["facebook"] as readonly Platform[],
  accountColumn: "meta_page_id",

  async publish(request: PublishRequest): Promise<PublishSuccess> {
    const endpoint = request.mediaKind === "video" ? "videos" : "photos";
    const body: Record<string, string> =
      request.mediaKind === "video"
        ? { description: request.caption, file_url: request.mediaUrl }
        : { caption: request.caption, url: request.mediaUrl };

    const posted = await graph(`${request.accountId}/${endpoint}`, {
      method: "POST",
      token: request.accessToken,
      body,
    });
    // A photo returns a photo id and a post id; a video returns its own id.
    const id = String(posted.post_id ?? posted.id ?? "");
    if (!id) throw new PublishError("Facebook returned no post id.", false);

    return {
      ok: true,
      externalId: id,
      externalUrl: `https://www.facebook.com/${id}`,
      detail: "Published to the Facebook page.",
    };
  },
};
