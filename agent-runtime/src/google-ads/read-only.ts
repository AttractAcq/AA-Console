/** Read-only Google Ads Search transport. No mutate endpoint is reachable here. */

const API = "https://googleads.googleapis.com/v25";
const MAX_PAGES = 20;
const MAX_CAMPAIGNS = 5000;

export class GoogleAdsReadError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export interface GoogleCampaignRead {
  id: string;
  name: string;
  status: string;
  channel: string;
  impressions: string;
  clicks: string;
  cost_micros: string;
  conversions: string;
}

export interface GoogleAccountRead {
  customerId: string;
  currency: string;
  requestId: string;
  campaigns: GoogleCampaignRead[];
}

type SearchRow = Record<string, unknown>;
type Credentials = {
  customerId: string;
  accessToken: string;
  developerToken: string;
  loginCustomerId?: string | null;
};

function object(value: unknown): SearchRow | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SearchRow : null;
}

function digits(value: unknown, label: string): string {
  const text = String(value ?? "");
  if (!/^\d{1,18}$/.test(text)) throw new GoogleAdsReadError(`Google ${label} was missing or malformed.`, false);
  return text;
}

function nonnegative(value: unknown, label: string, decimal = false): string {
  const text = String(value ?? "0");
  if (decimal) {
    const number = Number(text);
    if (!Number.isFinite(number) || number < 0 || number >= 1e12)
      throw new GoogleAdsReadError(`Google ${label} was missing or malformed.`, false);
    return number.toFixed(10).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  if (!/^\d{1,18}$/.test(text))
    throw new GoogleAdsReadError(`Google ${label} was missing or malformed.`, false);
  return text;
}

async function search(
  credentials: Credentials, query: string, fetchImpl: typeof fetch,
): Promise<{ rows: SearchRow[]; requestId: string }> {
  const rows: SearchRow[] = [];
  let pageToken: string | undefined;
  let requestId = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${API}/customers/${credentials.customerId}/googleAds:search`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "developer-token": credentials.developerToken,
          ...(credentials.loginCustomerId ? { "login-customer-id": credentials.loginCustomerId } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
      });
    } catch {
      throw new GoogleAdsReadError("Google Ads read could not reach the provider.", true);
    }
    const body = object(await response.json().catch(() => null));
    if (!response.ok) throw new GoogleAdsReadError(
      `Google Ads read returned HTTP ${response.status}.`,
      response.status === 429 || response.status >= 500,
    );
    if (body?.error != null) throw new GoogleAdsReadError(
      "Google Ads read returned a provider error envelope.", false);
    if (!body || !Array.isArray(body.results)) {
      // Google may omit results for an empty campaign account.
      if (!body || body.results !== undefined) throw new GoogleAdsReadError(
        "Google Ads read returned an invalid result envelope.", false);
    }
    if (typeof body?.requestId === "string" && body.requestId) requestId = body.requestId;
    for (const row of (body?.results ?? []) as unknown[]) {
      const parsed = object(row);
      if (!parsed) throw new GoogleAdsReadError("Google Ads returned a malformed row.", false);
      rows.push(parsed);
    }
    if (rows.length > MAX_CAMPAIGNS) throw new GoogleAdsReadError(
      "Google Ads result exceeds the bounded read limit.", false);
    pageToken = typeof body?.nextPageToken === "string" && body.nextPageToken
      ? body.nextPageToken : undefined;
    if (!pageToken) return { rows, requestId };
  }
  throw new GoogleAdsReadError("Google Ads pagination exceeded the bounded read limit.", false);
}

export async function readGoogleAdsAccount(
  credentials: Credentials, fromDate: string, throughDate: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleAccountRead> {
  if (!/^\d{10}$/.test(credentials.customerId)
    || !credentials.accessToken.trim() || !credentials.developerToken.trim()
    || credentials.loginCustomerId && !/^\d{10}$/.test(credentials.loginCustomerId)
    || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)
    || !/^\d{4}-\d{2}-\d{2}$/.test(throughDate) || fromDate > throughDate) {
    throw new GoogleAdsReadError("Google Ads read configuration is incomplete.", false);
  }
  const account = await search(credentials,
    "SELECT customer.id, customer.currency_code FROM customer", fetchImpl);
  const exact = account.rows.length === 1 ? object(account.rows[0]?.customer) : null;
  if (String(exact?.id ?? "") !== credentials.customerId
    || typeof exact?.currencyCode !== "string"
    || !/^[A-Z]{3}$/.test(exact.currencyCode)) {
    throw new GoogleAdsReadError("Google Ads did not return the configured customer identity and currency.", false);
  }

  const inventory = await search(credentials,
    "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign",
    fetchImpl);
  const metrics = await search(credentials,
    "SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions "
      + `FROM campaign WHERE segments.date BETWEEN '${fromDate}' AND '${throughDate}'`, fetchImpl);
  if (!account.requestId || !inventory.requestId || !metrics.requestId) throw new GoogleAdsReadError(
    "Google Ads did not return provider request IDs for every read.", false);

  const byId = new Map<string, SearchRow>();
  for (const row of metrics.rows) {
    const campaign = object(row.campaign);
    const id = digits(campaign?.id, "campaign ID");
    if (byId.has(id)) throw new GoogleAdsReadError("Google Ads returned duplicate campaign metrics.", false);
    byId.set(id, object(row.metrics) ?? {});
  }
  const seen = new Set<string>();
  const campaigns = inventory.rows.map((row): GoogleCampaignRead => {
    const campaign = object(row.campaign);
    const id = digits(campaign?.id, "campaign ID");
    if (seen.has(id)) throw new GoogleAdsReadError("Google Ads returned a duplicate campaign.", false);
    seen.add(id);
    const name = campaign?.name;
    const status = campaign?.status;
    const channel = campaign?.advertisingChannelType;
    if (typeof name !== "string" || !name.trim() || name.length > 500
      || typeof status !== "string" || !status.trim()
      || typeof channel !== "string" || !channel.trim()) {
      throw new GoogleAdsReadError("Google Ads returned an incomplete campaign record.", false);
    }
    const metric = byId.get(id) ?? {};
    return { id, name, status, channel,
      impressions: nonnegative(metric.impressions, "impressions"),
      clicks: nonnegative(metric.clicks, "clicks"),
      cost_micros: nonnegative(metric.costMicros, "cost"),
      conversions: nonnegative(metric.conversions, "conversions", true) };
  });
  if ([...byId.keys()].some((id) => !seen.has(id))) throw new GoogleAdsReadError(
    "Google Ads metrics referenced a campaign absent from inventory.", false);
  return { customerId: credentials.customerId, currency: exact.currencyCode,
    requestId: `${account.requestId}:${inventory.requestId}:${metrics.requestId}`,
    campaigns };
}
