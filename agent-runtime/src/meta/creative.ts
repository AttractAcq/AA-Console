/**
 * Getting an image into Meta, and turning it into something an ad can use.
 *
 * ads.ts creates an ad from a creative_id, and nothing made one. The chain is
 * three steps and the middle one is the part that carries the words:
 *
 *   upload the image  ->  image_hash
 *   image_hash + copy ->  ad creative  ->  creative_id
 *   creative_id       ->  ad
 *
 * The upload is multipart rather than JSON, which is why it does not use the
 * post() helper in ads.ts. Meta's own documentation is explicit that the
 * filename must carry an extension; a name without one is rejected, and the
 * rejection does not say that is the reason.
 */

import { MetaWriteError, classifyWrite, type AdAccount } from "./ads.js";
import { META_CTAS } from "./cta.js";

const GRAPH_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 120_000;

/** Meta dedupes by content, so the same bytes always come back the same hash. */
export interface UploadedImage {
  hash: string;
}

/**
 * Reads the hash out of Meta's reply.
 *
 * The shape is a map keyed by the filename that was sent, which means the
 * caller cannot look the entry up by a name it chose unless it also trusts
 * Meta to echo it exactly. Taking the single entry is both simpler and more
 * robust, and having more than one is a shape this never sends.
 */
export function imageHashFrom(body: unknown): string | null {
  const images = (body as { images?: Record<string, { hash?: unknown }> })?.images;
  if (!images || typeof images !== "object") return null;
  const entries = Object.values(images);
  if (entries.length !== 1) return null;
  const hash = entries[0]?.hash;
  return typeof hash === "string" && hash ? hash : null;
}

/**
 * Uploads one image to the ad account's image library.
 *
 * `filename` must carry an extension. Enforced here rather than left to Meta
 * because Meta's refusal names neither the field nor the reason.
 */
export async function uploadAdImage(
  account: AdAccount,
  image: { bytes: Uint8Array; filename: string },
): Promise<UploadedImage> {
  if (!/\.[A-Za-z0-9]+$/.test(image.filename)) {
    throw new MetaWriteError(
      `"${image.filename}" has no file extension. Meta rejects an image filename without one.`,
      false,
    );
  }
  if (image.bytes.length === 0) {
    throw new MetaWriteError("That image file is empty.", false);
  }

  const form = new FormData();
  form.append("access_token", account.accessToken);
  form.append(
    "filename",
    new Blob([image.bytes as unknown as BlobPart]),
    image.filename,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(
      `${BASE}/${encodeURIComponent(account.accountId)}/adimages`,
      { method: "POST", body: form, signal: controller.signal },
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw classifyWrite(response.status, body);
    const hash = imageHashFrom(body);
    if (!hash) {
      throw new MetaWriteError("Meta accepted the image but returned no hash.", false);
    }
    return { hash };
  } catch (error) {
    if (error instanceof MetaWriteError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new MetaWriteError(`Could not upload the image: ${message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

export interface AdCopy {
  /** The body copy above the image. */
  primaryText: string;
  /** The bold line under the image. */
  headline: string;
  description?: string | null;
  /** Where the ad sends people. */
  link: string;
  cta?: string | null;
}

export interface AdCreativePayload {
  name: string;
  object_story_spec: {
    page_id: string;
    link_data: {
      image_hash: string;
      link: string;
      message: string;
      name: string;
      description?: string;
      call_to_action?: { type: string; value: { link: string } };
    };
  };
}

/**
 * The ad creative.
 *
 * Only link ads. A click-to-message ad needs a different story spec, and this
 * refuses rather than guessing one — a wrong spec either errors, which is
 * fine, or builds an ad that runs and points nowhere useful, which is not.
 *
 * `call_to_action.value.link` repeats `link_data.link`. That is Meta's own
 * default when the button is omitted, so repeating it keeps the explicit case
 * behaving like the implicit one rather than inventing a second destination.
 */
export function adCreativePayload(args: {
  name: string;
  pageId: string;
  imageHash: string;
  copy: AdCopy;
  /** The campaign template's destination, which decides whether this shape fits. */
  destination: string;
}): AdCreativePayload {
  const name = args.name.trim();
  if (!name) throw new Error("An ad creative needs a name.");

  if (args.destination === "message") {
    throw new Error(
      "A click-to-message ad needs a different creative shape, which this does not build yet.",
    );
  }
  if (args.destination === "none" || args.destination === "post") {
    throw new Error(
      `A ${args.destination} destination has no link for a creative to point at.`,
    );
  }

  const pageId = args.pageId.trim();
  if (!pageId) throw new Error("An ad creative needs the Facebook page it runs from.");
  const imageHash = args.imageHash.trim();
  if (!imageHash) throw new Error("An ad creative needs an uploaded image.");

  const link = args.copy.link.trim();
  if (!/^https:\/\/\S+$/i.test(link)) {
    throw new Error(`"${args.copy.link}" is not an https destination.`);
  }
  const message = args.copy.primaryText.trim();
  if (!message) throw new Error("An ad needs primary text.");
  const headline = args.copy.headline.trim();
  if (!headline) throw new Error("An ad needs a headline.");

  const cta = (args.copy.cta ?? "").trim();
  if (cta && !(META_CTAS as readonly string[]).includes(cta)) {
    throw new Error(`"${cta}" is not a Meta call-to-action button.`);
  }
  const description = (args.copy.description ?? "").trim();

  return {
    name,
    object_story_spec: {
      page_id: pageId,
      link_data: {
        image_hash: imageHash,
        link,
        message,
        name: headline,
        ...(description ? { description } : {}),
        ...(cta ? { call_to_action: { type: cta, value: { link } } } : {}),
      },
    },
  };
}
