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
import {
  PublishError,
  type PublishAdapter,
  type PublishFrame,
  type PublishRequest,
  type PublishSuccess,
} from "./types.js";

const GRAPH_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 60_000;
/** Meta's upload host for the Reels and Stories surfaces. */
const RUPLOAD = "https://rupload.facebook.com";
/** A minute is not enough for a video Meta has to go and fetch. */
const UPLOAD_TIMEOUT_MS = 180_000;
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
  // 9007 is Instagram saying the container is not ready to be published. The
  // post has definitely not gone out when this comes back, so another attempt
  // builds a fresh container rather than risking a second post.
  if (code === 9007) return new PublishError(`${message} (the media was not ready yet)`, true);
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

/**
 * The frames, or a refusal.
 *
 * `publish_due` has already refused a carousel with an unsendable number of
 * frames, so this never fires in the normal path. It is here because an
 * adapter that trusts its caller about how many frames it was given is an
 * adapter that posts a one-item carousel the day something upstream changes.
 */
function framesOf(request: PublishRequest): readonly PublishFrame[] {
  const frames = request.frames ?? [];
  if (frames.length < 2 || frames.length > 10) {
    throw new PublishError(
      `A carousel takes between 2 and 10 frames; this one has ${frames.length}.`,
      false,
    );
  }
  return frames;
}

/**
 * Instagram's carousel: a container per frame, a parent that names them, and
 * then the publish.
 *
 * The parent is deliberately not polled the way a reel is. An image carousel
 * assembles immediately, and polling a container whose status endpoint
 * returns nothing useful would hang for two minutes before failing. If the
 * parent genuinely is not ready, the publish call says so as code 9007, which
 * `classify` makes retryable: nothing has gone out at that point, so another
 * attempt is a fresh container and not a second post.
 */
async function publishInstagramCarousel(request: PublishRequest): Promise<PublishSuccess> {
  const frames = framesOf(request);
  const children: string[] = [];

  for (const frame of frames) {
    const child = await graph(`${request.accountId}/media`, {
      method: "POST",
      token: request.accessToken,
      body: {
        image_url: frame.mediaUrl,
        is_carousel_item: "true",
        // One alt text describes the set, so it goes on the cover frame
        // rather than being repeated as though it described each one.
        ...(frame.position === 1 && request.altText ? { alt_text: request.altText } : {}),
      },
    });
    const id = String(child.id ?? "");
    if (!id) {
      throw new PublishError(`Instagram returned no container id for frame ${frame.position}.`, true);
    }
    children.push(id);
  }

  const parent = await graph(`${request.accountId}/media`, {
    method: "POST",
    token: request.accessToken,
    body: {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption: request.caption,
    },
  });
  const parentId = String(parent.id ?? "");
  if (!parentId) throw new PublishError("Instagram returned no carousel container id.", true);

  const published = await graph(`${request.accountId}/media_publish`, {
    method: "POST",
    token: request.accessToken,
    body: { creation_id: parentId },
  });
  const id = String(published.id ?? "");
  if (!id) {
    throw new PublishError("Instagram published the carousel but returned no post id.", false);
  }

  await postFirstComment(request, id);

  return {
    ok: true,
    externalId: id,
    externalUrl: await instagramPermalink(id, request.accessToken),
    detail: `Published a ${frames.length}-frame carousel to Instagram.`,
  };
}

/**
 * Facebook's carousel: each frame uploaded to the page unpublished, then one
 * feed post that attaches them.
 *
 * A frame that uploads and then a feed post that fails leaves unpublished
 * photos on the page. They are invisible to the page's audience and the
 * retry uploads its own, so they are litter rather than a problem; deleting
 * them would need a call per frame on a path that has already failed.
 */
async function publishFacebookCarousel(request: PublishRequest): Promise<PublishSuccess> {
  const frames = framesOf(request);
  const attached: string[] = [];

  for (const frame of frames) {
    const photo = await graph(`${request.accountId}/photos`, {
      method: "POST",
      token: request.accessToken,
      body: { url: frame.mediaUrl, published: "false" },
    });
    const id = String(photo.id ?? "");
    if (!id) {
      throw new PublishError(`Facebook returned no photo id for frame ${frame.position}.`, true);
    }
    attached.push(id);
  }

  const body: Record<string, string> = { message: request.caption };
  attached.forEach((id, index) => {
    body[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
  });

  const posted = await graph(`${request.accountId}/feed`, {
    method: "POST",
    token: request.accessToken,
    body,
  });
  const id = String(posted.post_id ?? posted.id ?? "");
  if (!id) throw new PublishError("Facebook returned no post id for the carousel.", false);

  await postFirstComment(request, id);

  return {
    ok: true,
    externalId: id,
    externalUrl: `https://www.facebook.com/${id}`,
    detail: `Published a ${frames.length}-frame carousel to the Facebook page.`,
  };
}

/**
 * The words that follow a post, posted as a comment on it.
 *
 * Fire and forget on both platforms, and the same reasoning on both: the post
 * is already out. Reporting a failed first comment as a failed post would
 * have the board show something as not published that is published, and a
 * retry would then post it twice.
 */
async function postFirstComment(request: PublishRequest, postId: string): Promise<void> {
  if (!request.firstComment) return;
  await graph(`${postId}/comments`, {
    method: "POST",
    token: request.accessToken,
    body: { message: request.firstComment },
  }).catch(() => undefined);
}

/**
 * Where a person can go and look at an Instagram post.
 *
 * Instagram's publish response is an id and nothing else, so the link has to
 * be read back from the media node. Best effort by the same argument as the
 * first comment: a post with no link recorded is a small annoyance on a
 * board, and failing a published post over it is not.
 */
async function instagramPermalink(id: string, token: string): Promise<string | null> {
  const node = await graph(id, {
    method: "GET",
    token,
    body: { fields: "permalink" },
  }).catch(() => null);
  const link = typeof node?.permalink === "string" ? node.permalink.trim() : "";
  return link || null;
}

/**
 * Meta's three-phase video upload, which Reels and video stories both need.
 *
 * A page video posted to /videos takes a `file_url` and is one call. The Reels
 * and Stories surfaces do not: they want a session started on the Graph host,
 * the bytes sent to a different host entirely, and the session finished. The
 * middle phase is the only place in this file that talks to anything but
 * graph.facebook.com.
 *
 * The bytes are not streamed. rupload accepts a `file_url` header and fetches
 * the media itself, which is the same arrangement every other call here uses
 * -- our signed URL handed over for the platform to pull -- and it keeps the
 * runtime from holding a video in memory.
 */
async function uploadFacebookVideo(
  request: PublishRequest,
  surface: "video_reels" | "video_stories",
  mediaUrl: string,
  finishExtra: Record<string, string> = {},
): Promise<string> {
  const started = await graph(`${request.accountId}/${surface}`, {
    method: "POST",
    token: request.accessToken,
    body: { upload_phase: "start" },
  });
  const videoId = String(started.video_id ?? started.id ?? "");
  if (!videoId) throw new PublishError(`Facebook started no ${surface} upload.`, true);

  await ruploadFromUrl(videoId, mediaUrl, request.accessToken);

  const finished = await graph(`${request.accountId}/${surface}`, {
    method: "POST",
    token: request.accessToken,
    body: {
      upload_phase: "finish",
      video_id: videoId,
      video_state: "PUBLISHED",
      ...finishExtra,
    },
  });
  // It is out. Some of these surfaces return a post id and some return only
  // success, and the video id is a real identifier for the thing that was
  // published -- so it is the fallback rather than a reason to fail
  // something that has already happened.
  return String(finished.post_id ?? finished.id ?? videoId);
}

async function ruploadFromUrl(videoId: string, mediaUrl: string, token: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${RUPLOAD}/video-upload/${GRAPH_VERSION}/${videoId}`, {
      method: "POST",
      // `file_url` is the header that makes this a fetch rather than an
      // upload. The token goes in an Authorization header on this host, not
      // in the body as it does on the Graph host.
      headers: { Authorization: `OAuth ${token}`, file_url: mediaUrl },
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw classify(response.status, payload);
    if (payload && "error" in payload) throw classify(200, payload);
    if (payload && payload.success === false) {
      throw new PublishError("Facebook could not fetch the video to upload it.", true);
    }
  } catch (error) {
    if (error instanceof PublishError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // Nothing is published until the finish phase, so another attempt starts
    // a new session rather than risking a second post.
    throw new PublishError(`Could not upload the video to Facebook: ${message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

export const instagramAdapter: PublishAdapter = {
  provider: "instagram",
  platforms: ["instagram"] as readonly Platform[],
  // The IG user id lives where the metrics ingest already reads it from.
  accountColumn: "credential_label",

  async publish(request: PublishRequest): Promise<PublishSuccess> {
    if (request.contentFormat === "carousel") return publishInstagramCarousel(request);

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

    await postFirstComment(request, id);

    return {
      ok: true,
      externalId: id,
      externalUrl: await instagramPermalink(id, request.accessToken),
      detail: "Published to Instagram.",
    };
  },
  /**
   * One STORIES container, published on its own.
   *
   * No caption: a story has no caption field on the Graph API, so the words
   * composed for this post stay where they are rather than being dropped into
   * a parameter that would be ignored. A video story is a container that has
   * to finish first, exactly like a reel.
   */
  async publishFrame(request: PublishRequest, frame: PublishFrame): Promise<PublishSuccess> {
    const container = await graph(`${request.accountId}/media`, {
      method: "POST",
      token: request.accessToken,
      body: {
        media_type: "STORIES",
        ...(request.mediaKind === "video"
          ? { video_url: frame.mediaUrl }
          : { image_url: frame.mediaUrl }),
      },
    });
    const containerId = String(container.id ?? "");
    if (!containerId) {
      throw new PublishError(`Instagram returned no container id for frame ${frame.position}.`, true);
    }
    if (request.mediaKind === "video") await waitForContainer(containerId, request.accessToken);

    const published = await graph(`${request.accountId}/media_publish`, {
      method: "POST",
      token: request.accessToken,
      body: { creation_id: containerId },
    });
    const id = String(published.id ?? "");
    if (!id) {
      throw new PublishError(
        `Instagram published story frame ${frame.position} but returned no post id.`,
        false,
      );
    }
    return {
      ok: true,
      externalId: id,
      // No first comment: a story has no comment thread to put one under.
      externalUrl: await instagramPermalink(id, request.accessToken),
      detail: `Published story frame ${frame.position} to Instagram.`,
    };
  },
};

export const facebookAdapter: PublishAdapter = {
  provider: "meta",
  platforms: ["facebook"] as readonly Platform[],
  accountColumn: "meta_page_id",

  async publish(request: PublishRequest): Promise<PublishSuccess> {
    if (request.contentFormat === "carousel") return publishFacebookCarousel(request);

    // A reel is its own surface, not a page video with a vertical aspect
    // ratio. Until now one went to /videos and landed in the feed, which
    // published the whole video but put it somewhere nobody chose.
    if (request.contentFormat === "reel" && request.mediaKind === "video") {
      const reelId = await uploadFacebookVideo(request, "video_reels", request.mediaUrl, {
        description: request.caption,
      });
      await postFirstComment(request, reelId);
      return {
        ok: true,
        externalId: reelId,
        externalUrl: `https://www.facebook.com/reel/${reelId}`,
        detail: "Published a reel to the Facebook page.",
      };
    }

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

    await postFirstComment(request, id);

    return {
      ok: true,
      externalId: id,
      externalUrl: `https://www.facebook.com/${id}`,
      detail: "Published to the Facebook page.",
    };
  },
  /**
   * A page photo story: the frame uploaded unpublished, then turned into a
   * story.
   *
   * A video story goes the other way: started on the Graph host, uploaded to
   * rupload, finished. Same three phases as a reel, different surface.
   */
  async publishFrame(request: PublishRequest, frame: PublishFrame): Promise<PublishSuccess> {
    if (request.mediaKind === "video") {
      const storyId = await uploadFacebookVideo(request, "video_stories", frame.mediaUrl);
      return {
        ok: true,
        externalId: storyId,
        externalUrl: `https://www.facebook.com/${storyId}`,
        detail: `Published video story frame ${frame.position} to the Facebook page.`,
      };
    }
    const photo = await graph(`${request.accountId}/photos`, {
      method: "POST",
      token: request.accessToken,
      body: { url: frame.mediaUrl, published: "false" },
    });
    const photoId = String(photo.id ?? "");
    if (!photoId) {
      throw new PublishError(`Facebook returned no photo id for frame ${frame.position}.`, true);
    }

    const story = await graph(`${request.accountId}/photo_stories`, {
      method: "POST",
      token: request.accessToken,
      body: { photo_id: photoId },
    });
    const id = String(story.post_id ?? story.id ?? "");
    if (!id) {
      throw new PublishError(
        `Facebook made story frame ${frame.position} but returned no post id.`,
        false,
      );
    }
    return {
      ok: true,
      externalId: id,
      externalUrl: `https://www.facebook.com/${id}`,
      detail: `Published story frame ${frame.position} to the Facebook page.`,
    };
  },
};
