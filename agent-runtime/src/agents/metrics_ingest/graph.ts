// Meta Graph API transport.
//
// Ads Insights and Instagram media insights are the same API with the same
// token model, which is the whole reason paid and organic are one connector
// rather than two systems.
//
// Nothing here interprets a number; it fetches pages and classifies
// failures. What the numbers mean lives in normalise.ts.

import { SourceError, type MetricsSource, type SourceCredentials, type Surface, type Window } from "./types.js";

const GRAPH_VERSION = "v21.0";
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_PAGES = 50;
const TIMEOUT_MS = 60_000;

const PAID_FIELDS = [
  "campaign_id",
  "campaign_name",
  "date_start",
  "date_stop",
  "impressions",
  "reach",
  "clicks",
  "spend",
  "account_currency",
  "actions",
].join(",");

const IG_MEDIA_FIELDS =
  "id,caption,media_type,permalink,timestamp,insights.metric(impressions,reach,total_interactions)";

const ACCOUNT_METRICS = "impressions,reach,total_interactions";

/**
 * Meta's error codes, mapped to whether trying again could plausibly work.
 * An expired token retried in five minutes is still expired; a rate limit
 * is not.
 */
function classify(status: number, body: unknown): SourceError {
  const error = (body as { error?: { message?: string; code?: number; error_subcode?: number } })?.error;
  const code = error?.code;
  const message = error?.message ?? `Graph API returned ${status}`;

  // 190 = invalid/expired token, 200/10 = permission. None self-heal.
  if (code === 190 || code === 200 || code === 10) {
    return new SourceError(`${message} (the client's Meta credential needs reconnecting)`, false);
  }
  // 4 = app rate limit, 17 = user rate limit, 32 = page rate limit,
  // 613 = custom-rate limit. 1/2 are transient Meta-side errors.
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 1 || code === 2) {
    return new SourceError(`${message} (rate limited)`, true);
  }
  if (status === 429 || status >= 500) return new SourceError(message, true);
  return new SourceError(message, false);
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) throw classify(response.status, body);
    return body ?? {};
  } catch (error) {
    if (error instanceof SourceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    // A timeout or socket failure is worth another attempt.
    throw new SourceError(`Could not reach the Graph API: ${message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Follows paging.next, which is a fully-formed URL including the token. */
async function getAllPages(firstUrl: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let url: string | null = firstUrl;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const body: Record<string, unknown> = await getJson(url);
    const data = body.data;
    if (Array.isArray(data)) out.push(...data);
    const paging = body.paging as { next?: unknown } | undefined;
    url = typeof paging?.next === "string" ? paging.next : null;
    pages += 1;
  }

  if (url) {
    throw new SourceError(
      `Stopped after ${MAX_PAGES} pages. Narrow the date window and try again.`,
      false,
    );
  }
  return out;
}

export const metaGraphSource: MetricsSource = {
  name: "meta-graph",

  async fetch(surface: Surface, window: Window, creds: SourceCredentials): Promise<unknown[]> {
    const token = encodeURIComponent(creds.accessToken);
    const account = encodeURIComponent(creds.accountId);

    if (surface === "paid") {
      const range = encodeURIComponent(JSON.stringify({ since: window.since, until: window.until }));
      // time_increment=1 is what makes each row a single day rather than
      // one aggregate for the whole range.
      return getAllPages(
        `${BASE}/${account}/insights?level=campaign&time_increment=1&limit=200` +
          `&time_range=${range}&fields=${PAID_FIELDS}&access_token=${token}`,
      );
    }

    if (surface === "organic") {
      const [media, accountInsights] = await Promise.all([
        getAllPages(`${BASE}/${account}/media?limit=100&fields=${IG_MEDIA_FIELDS}&access_token=${token}`),
        getAllPages(
          `${BASE}/${account}/insights?metric=${ACCOUNT_METRICS}&period=day` +
            `&since=${window.since}&until=${window.until}&access_token=${token}`,
        ),
      ]);
      // Tagged so the runner can send each to the right normaliser without
      // a second round trip.
      return [
        { __kind: "media", rows: media },
        { __kind: "account", rows: accountInsights },
      ];
    }

    throw new SourceError(
      `No connector for the "${surface}" surface. Landing and offer pages are not an ad-platform source.`,
      false,
    );
  },
};
