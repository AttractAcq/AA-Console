/** Bounded, read-only Meta Marketing API snapshot of one exact ad account. */
const GRAPH = "https://graph.facebook.com/v27.0";
const MAX_PAGES = 50;
const MAX_ROWS = 5000;

type Row = Record<string, unknown>;
export type MetaReadCredentials = { accountId: string; accessToken: string };
export type MetaReadMetrics = {
  impressions: string; clicks: string; spend: string; actions: Array<{ action_type: string; value: string }>;
};
export type MetaCampaignRead = MetaReadMetrics & {
  id: string; name: string; status: string; effective_status: string;
};
export type MetaAdRead = MetaReadMetrics & {
  id: string; campaign_id: string; adset_id: string; name: string;
  status: string; effective_status: string; creative_id: string | null;
  creative_name: string | null;
};
export type MetaAccountRead = {
  accountId: string; currency: string; fromDate: string; throughDate: string;
  campaigns: MetaCampaignRead[]; ads: MetaAdRead[];
};

export class MetaAdsReadError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

function object(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value))
    throw new MetaAdsReadError(`Meta ${label} was missing or malformed.`, false);
  return value;
}
function text(value: unknown, label: string, limit = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new MetaAdsReadError(`Meta ${label} was missing or malformed.`, false);
  return value;
}
function nonnegative(value: unknown, label: string, decimals = 0): string {
  const number = String(value ?? "0");
  const valid = decimals === 0 ? /^\d{1,18}$/.test(number)
    : decimals === 2 ? /^\d{1,12}(\.\d{1,2})?$/.test(number)
      : /^\d{1,12}(\.\d{1,10})?$/.test(number);
  if (!valid)
    throw new MetaAdsReadError(`Meta ${label} was malformed.`, false);
  return number;
}
function actions(value: unknown): MetaReadMetrics["actions"] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new MetaAdsReadError("Meta actions were malformed.", false);
  return value.map((entry) => {
    const item = object(entry);
    const actionType = text(item?.action_type, "action type", 120);
    const amount = nonnegative(item?.value, "action value", 10);
    return { action_type: actionType, value: amount };
  });
}
function metrics(row: Row | undefined): MetaReadMetrics {
  return { impressions: nonnegative(row?.impressions, "impressions"),
    clicks: nonnegative(row?.clicks, "clicks"), spend: nonnegative(row?.spend, "spend", 2),
    actions: actions(row?.actions) };
}
function classify(status: number, body: Row | null): MetaAdsReadError {
  const code = object(body?.error)?.code;
  return new MetaAdsReadError(`Meta account read returned HTTP ${status}.`,
    status === 429 || status >= 500 || [1, 2, 4, 17, 32, 613].includes(Number(code)));
}

async function get(url: string, credentials: MetaReadCredentials,
  fetchImpl: typeof fetch): Promise<Row> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "error",
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
      signal: AbortSignal.timeout(30_000) });
  } catch { throw new MetaAdsReadError("Meta account read could not reach the provider.", true); }
  const body = object(await response.json().catch(() => null));
  if (!response.ok) throw classify(response.status, body);
  if (!body || body.error != null) throw new MetaAdsReadError("Meta returned an invalid read envelope.", false);
  return body;
}

async function pages(edge: "campaigns" | "ads" | "insights", params: URLSearchParams,
  credentials: MetaReadCredentials, fetchImpl: typeof fetch): Promise<Row[]> {
  const out: Row[] = [];
  let next: string | null = `${GRAPH}/${credentials.accountId}/${edge}?${params.toString()}`;
  const expectedPath = `/v27.0/${credentials.accountId}/${edge}`;
  for (let page = 0; page < MAX_PAGES && next; page += 1) {
    const body = await get(next, credentials, fetchImpl);
    if (!Array.isArray(body.data)) throw new MetaAdsReadError("Meta returned a malformed list.", false);
    for (const item of body.data) {
      const row = object(item);
      if (!row) throw new MetaAdsReadError("Meta returned a malformed row.", false);
      out.push(row);
    }
    if (out.length > MAX_ROWS) throw new MetaAdsReadError("Meta account read exceeded its row limit.", false);
    const candidate = object(body.paging)?.next;
    if (candidate == null) return out;
    if (typeof candidate !== "string") throw new MetaAdsReadError("Meta returned malformed pagination.", false);
    const parsed = new URL(candidate);
    if (parsed.origin !== "https://graph.facebook.com" || parsed.pathname !== expectedPath)
      throw new MetaAdsReadError("Meta pagination left the requested account edge.", false);
    next = parsed.toString();
  }
  if (next) throw new MetaAdsReadError("Meta account read exceeded its page limit.", false);
  return out;
}

function metricMap(rows: Row[], key: "campaign_id" | "ad_id", currency: string): Map<string, MetaReadMetrics> {
  const out = new Map<string, MetaReadMetrics>();
  for (const row of rows) {
    const externalId = id(row[key], key);
    if (out.has(externalId) || row.account_currency !== currency)
      throw new MetaAdsReadError("Meta returned duplicate metrics or a different account currency.", false);
    out.set(externalId, metrics(row));
  }
  return out;
}

export async function readMetaAdsAccount(credentials: MetaReadCredentials,
  fromDate: string, throughDate: string, fetchImpl: typeof fetch = fetch): Promise<MetaAccountRead> {
  if (!/^act_\d{1,30}$/.test(credentials.accountId) || !credentials.accessToken.trim()
    || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(throughDate)
    || fromDate > throughDate) throw new MetaAdsReadError("Meta read configuration is incomplete.", false);
  const accountUrl = `${GRAPH}/${credentials.accountId}?fields=id,account_id,currency`;
  const account = await get(accountUrl, credentials, fetchImpl);
  if (account.id !== credentials.accountId
    || account.account_id !== credentials.accountId.slice(4)
    || typeof account.currency !== "string" || !/^[A-Z]{3}$/.test(account.currency))
    throw new MetaAdsReadError("Meta did not return the configured ad account identity and currency.", false);
  const currency = account.currency;
  const inventory = await pages("campaigns", new URLSearchParams({
    fields:"id,name,status,effective_status", limit:"200" }), credentials, fetchImpl);
  const adInventory = await pages("ads", new URLSearchParams({
    fields:"id,campaign_id,adset_id,name,status,effective_status,creative{id,name}", limit:"200",
  }), credentials, fetchImpl);
  const timeRange = JSON.stringify({ since:fromDate, until:throughDate });
  const metricFields = "impressions,clicks,spend,actions,account_currency";
  const campaignMetrics = metricMap(await pages("insights", new URLSearchParams({
    fields:`campaign_id,${metricFields}`, level:"campaign",time_range:timeRange,limit:"200",
  }), credentials, fetchImpl), "campaign_id", currency);
  const adMetrics = metricMap(await pages("insights", new URLSearchParams({
    fields:`ad_id,${metricFields}`, level:"ad",time_range:timeRange,limit:"200",
  }), credentials, fetchImpl), "ad_id", currency);
  const campaignIds = new Set<string>();
  const campaigns = inventory.map((row): MetaCampaignRead => {
    const externalId = id(row.id,"campaign ID");
    if (campaignIds.has(externalId)) throw new MetaAdsReadError("Meta returned duplicate campaigns.", false);
    campaignIds.add(externalId);
    return { id:externalId, name:text(row.name,"campaign name"),
      status:text(row.status,"campaign status",80),
      effective_status:text(row.effective_status,"campaign effective status",80),
      ...metrics(campaignMetrics.get(externalId)) };
  });
  const adIds = new Set<string>();
  const ads = adInventory.map((row): MetaAdRead => {
    const externalId = id(row.id,"ad ID");
    const campaignId = id(row.campaign_id,"ad campaign ID");
    if (adIds.has(externalId) || !campaignIds.has(campaignId))
      throw new MetaAdsReadError("Meta returned a duplicate ad or unknown campaign.", false);
    adIds.add(externalId);
    const creative = object(row.creative);
    return { id:externalId, campaign_id:campaignId, adset_id:id(row.adset_id,"ad set ID"),
      name:text(row.name,"ad name"), status:text(row.status,"ad status",80),
      effective_status:text(row.effective_status,"ad effective status",80),
      creative_id: creative ? id(creative.id,"creative ID") : null,
      creative_name: creative ? text(creative.name,"creative name") : null,
      ...metrics(adMetrics.get(externalId)) };
  });
  if ([...campaignMetrics.keys()].some((externalId) => !campaignIds.has(externalId))
    || [...adMetrics.keys()].some((externalId) => !adIds.has(externalId)))
    throw new MetaAdsReadError("Meta metrics referenced an object absent from inventory.", false);
  return { accountId:credentials.accountId,currency,fromDate,throughDate,campaigns,ads };
}
