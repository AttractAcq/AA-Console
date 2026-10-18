/**
 * What publishing is, in types.
 *
 * M2. One interface, one adapter per platform, and a failure that knows
 * whether trying again could plausibly work. That last part is not a detail:
 * `retryable` is what the database uses to decide between putting a post
 * back in the queue and telling a person it is not going out, and a wrong
 * answer either spams an account or silently drops a client's post.
 */

import type { Platform } from "../content/platform-limits.js";
import type { ContentFormat } from "../content/format.js";

/**
 * One frame of a shape made of frames.
 *
 * Images only, because that is what the data model says a carousel is:
 * `mediaTypesFor('carousel')` is `['image']`, and a swipeable set of clips is
 * a story rather than a carousel. Instagram would accept a video item; until
 * an asset can carry one, pretending otherwise here would be a field nothing
 * could ever set.
 */
export interface PublishFrame {
  /** 1-based, and the order the frames go out in. */
  readonly position: number;
  /** A signed, time-limited URL the platform can fetch this frame from. */
  readonly mediaUrl: string;
  /** Per-frame copy, where the format carries any. Not every platform shows it. */
  readonly caption?: string | null;
}

/** Everything an adapter needs to make one post. Nothing it does not. */
export interface PublishRequest {
  readonly postId: string;
  readonly clientId: string;
  readonly platform: Platform;
  /** The token, already read from the Vault. Adapters never touch the database. */
  readonly accessToken: string;
  /**
   * The account to post as, as that platform addresses it: an Instagram user
   * id, a Facebook page id. Which column it came from is the runner's
   * problem, not the adapter's.
   */
  readonly accountId: string;
  /** A signed, time-limited URL the platform can fetch the media from. */
  readonly mediaUrl: string;
  readonly mediaKind: "image" | "video";
  /**
   * The shape being sent, which an adapter branches on before anything else.
   *
   * Before migration 219 this was not here and not anywhere: the adapter was
   * handed one file and a media kind, so a carousel arrived looking exactly
   * like a single image and went out as one.
   */
  readonly contentFormat: ContentFormat;
  /**
   * The ordered frames, for a shape made of them. Undefined for a single post
   * or a reel, where `mediaUrl` is the whole thing.
   */
  readonly frames?: readonly PublishFrame[];
  /** The words, already composed and already within the platform's limits. */
  readonly caption: string;
  readonly firstComment?: string | null;
  readonly altText?: string | null;
  readonly linkUrl?: string | null;
}

export interface PublishSuccess {
  readonly ok: true;
  /** The platform's own id for the post. */
  readonly externalId: string;
  /** Where a person can go and look at it, where the platform says. */
  readonly externalUrl?: string | null;
  /** Anything worth putting in the job log. Never the token. */
  readonly detail?: string;
}

/**
 * A failure that says whether to try again.
 *
 * Default false everywhere it is constructed from an unknown: an unknown
 * error retried three times against a real account is three chances to
 * post twice.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export interface PublishAdapter {
  /** The provider row in client_integrations this adapter reads its token from. */
  readonly provider: string;
  /** The platforms it can post to. */
  readonly platforms: readonly Platform[];
  /**
   * Which column on client_integrations holds the account id, so the runner
   * can fetch it without knowing what the adapter will do with it.
   */
  readonly accountColumn: "meta_page_id" | "credential_label" | "ad_account_id";
  publish(request: PublishRequest): Promise<PublishSuccess>;
  /**
   * One frame of a story, as its own post.
   *
   * Stories are the one shape where a frame set is not a single publication:
   * neither platform has a multi-frame story container, so five frames are
   * five posts with five ids. The runner calls this once per frame and
   * records each one as it lands, which is what lets a retry send the rest
   * rather than the lot.
   *
   * Absent on an adapter that cannot send a story at all.
   */
  publishFrame?(request: PublishRequest, frame: PublishFrame): Promise<PublishSuccess>;
}
