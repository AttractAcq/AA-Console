/** Read-only Business Profile Performance API transport. */

const API = "https://businessprofileperformance.googleapis.com/v1";
const METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
] as const;

export type ProfileMetric = (typeof METRICS)[number];
export type ProfileMetricPoint = { metric: ProfileMetric; day: string; value: string };
export type ProfilePerformanceRead = {
  locationRef: string;
  from: string;
  through: string;
  observedMetrics: ProfileMetric[];
  points: ProfileMetricPoint[];
};

export class ProfilePerformanceReadError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function dayParts(value: string): [number, number, number] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
    || Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new ProfilePerformanceReadError("Business Profile date is invalid.", false);
  }
  return [Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10))];
}

/** Missing dates/series are unknown. Google's omitted value on a returned date means zero. */
export async function readProfilePerformance(input: {
  locationRef: string; accessToken: string; from: string; through: string;
  fetchImpl?: typeof fetch;
}): Promise<ProfilePerformanceRead> {
  const match = /^accounts\/[A-Za-z0-9_-]+\/locations\/([0-9]+)$/.exec(input.locationRef);
  if (!match || !input.accessToken.trim()) {
    throw new ProfilePerformanceReadError("A numbered Business Profile location and credential are required.", false);
  }
  const fromParts = dayParts(input.from);
  const throughParts = dayParts(input.through);
  const span = (Date.parse(`${input.through}T00:00:00Z`)
    - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000;
  if (span < 0 || span > 30) {
    throw new ProfilePerformanceReadError("Business Profile read must cover at most 31 days.", false);
  }
  const url = new URL(`${API}/locations/${match[1]}:fetchMultiDailyMetricsTimeSeries`);
  for (const metric of METRICS) url.searchParams.append("dailyMetrics", metric);
  for (const [prefix, parts] of [["start_date", fromParts], ["end_date", throughParts]] as const) {
    ["year", "month", "day"].forEach((field, index) => {
      url.searchParams.set(`dailyRange.${prefix}.${field}`, String(parts[index]));
    });
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url.href, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
  } catch {
    throw new ProfilePerformanceReadError("Business Profile performance read could not reach Google.", true);
  }
  if (!response.ok) throw new ProfilePerformanceReadError(
    `Business Profile performance read returned HTTP ${response.status}.`,
    response.status === 408 || response.status === 429 || response.status >= 500,
  );
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new ProfilePerformanceReadError("Business Profile returned malformed performance data.", false); }
  const root = object(body);
  if (!root || (root.multiDailyMetricTimeSeries !== undefined
    && !Array.isArray(root.multiDailyMetricTimeSeries))) {
    throw new ProfilePerformanceReadError("Business Profile returned malformed performance data.", false);
  }
  const groups = root.multiDailyMetricTimeSeries ?? [];
  const points: ProfileMetricPoint[] = [];
  const observedMetrics = new Set<ProfileMetric>();
  const seen = new Set<string>();
  for (const group of groups as unknown[]) {
    const groupObject = object(group);
    const items = groupObject?.dailyMetricTimeSeries ?? [];
    if (!groupObject) throw new ProfilePerformanceReadError(
      "Business Profile returned malformed metric series.", false);
    if (!Array.isArray(items)) throw new ProfilePerformanceReadError(
      "Business Profile returned malformed metric series.", false);
    for (const item of items) {
      const series = object(item);
      const metric = series?.dailyMetric;
      if (typeof metric !== "string" || !METRICS.includes(metric as ProfileMetric)
        || series?.dailySubEntityType !== undefined) {
        throw new ProfilePerformanceReadError("Business Profile returned an unexpected metric.", false);
      }
      const values = series?.timeSeries === undefined ? []
        : object(series.timeSeries)?.datedValues;
      if (!Array.isArray(values)) throw new ProfilePerformanceReadError(
        "Business Profile returned malformed dated values.", false);
      observedMetrics.add(metric as ProfileMetric);
      for (const itemValue of values) {
        const entry = object(itemValue);
        const date = object(entry?.date);
        const year = date?.year, month = date?.month, day = date?.day;
        if (![year, month, day].every((part) => Number.isInteger(part))
          || Number(year) < 1000 || Number(month) < 1 || Number(month) > 12
          || Number(day) < 1 || Number(day) > 31) {
          throw new ProfilePerformanceReadError("Business Profile returned an invalid metric date.", false);
        }
        const dateText = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        dayParts(dateText);
        if (dateText < input.from || dateText > input.through) {
          throw new ProfilePerformanceReadError("Business Profile returned a date outside the requested range.", false);
        }
        const raw = entry?.value === undefined ? "0" : String(entry.value);
        if (!/^(0|[1-9][0-9]{0,17})$/.test(raw)) {
          throw new ProfilePerformanceReadError("Business Profile returned an invalid metric value.", false);
        }
        const key = `${metric}:${dateText}`;
        if (seen.has(key)) throw new ProfilePerformanceReadError(
          "Business Profile returned duplicate metric dates.", false);
        seen.add(key);
        points.push({ metric: metric as ProfileMetric, day: dateText, value: raw });
      }
    }
  }
  return { locationRef: input.locationRef, from: input.from, through: input.through,
    observedMetrics: [...observedMetrics], points };
}
