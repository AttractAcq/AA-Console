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
}
