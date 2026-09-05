// Graph API payloads -> metrics_daily rows.
//
// Deliberately pure and free of network or database access: this is the
// part that decides what a number means, so it is the part worth testing.
// Everything upstream of it is transport, everything downstream is a write.

import type { Basis, EntityType, MetricRow, Surface, Window } from "./types.js";

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Meta reports conversions as a list of {action_type, value}. There is no
 * single "conversions" number, so we sum the action types that represent a
 * completed outcome and ignore the rest — a link click is not a lead.
 */
const CONVERSION_ACTIONS = new Set([
  "lead",
  "offsite_conversion.fb_pixel_lead",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_conversion.lead_grouped",
  "purchase",
  "complete_registration",
  "schedule",
  "submit_application",
]);

function conversionsFrom(actions: unknown): number | null {
  if (!Array.isArray(actions)) return null;
  let total = 0;
  let matched = false;
  for (const entry of actions) {
    const action = entry as { action_type?: unknown; value?: unknown };
    if (typeof action?.action_type !== "string") continue;
    if (!CONVERSION_ACTIONS.has(action.action_type)) continue;
    const value = num(action.value);
    if (value !== null) {
      total += value;
      matched = true;
    }
  }
  return matched ? total : null;
}

/** Instagram returns insights as [{name, values:[{value}]}]. */
function igMetric(insights: unknown, name: string): number | null {
  const list = (insights as { data?: unknown[] } | undefined)?.data;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const metric = entry as { name?: unknown; values?: Array<{ value?: unknown }> };
    if (metric?.name !== name) continue;
    return num(metric.values?.[0]?.value);
  }
  return null;
}

const clampToWindow = (date: string, window: Window): boolean =>
  date >= window.since && date <= window.until;

/** One malformed entry must not take down a whole ingest. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function blank(
  surface: Surface,
  entity: EntityType,
  externalId: string,
  date: string,
  basis: Basis,
  raw: unknown,
): MetricRow {
  return {
    surface,
    entity_type: entity,
    external_id: externalId,
    metric_date: date,
    basis,
    impressions: null,
    reach: null,
    clicks: null,
    engagements: null,
    spend: null,
    conversions: null,
    currency: null,
    raw,
  };
}

/**
 * Paid: one row per campaign per day. time_increment=1 makes each entry a
 * single day, so these are genuinely daily values and sum correctly.
 */
export function normalisePaid(rows: unknown[], window: Window): MetricRow[] {
  const out: MetricRow[] = [];
  for (const entry of rows) {
    if (!isRecord(entry)) continue;
    const row = entry;
    const campaignId = row.campaign_id ?? row.id;
    const date = row.date_start;
    if (typeof campaignId !== "string" || typeof date !== "string") continue;
    if (!clampToWindow(date, window)) continue;

    const metric = blank("paid", "campaign", campaignId, date, "daily", row);
    metric.impressions = num(row.impressions);
    metric.reach = num(row.reach);
    metric.clicks = num(row.clicks);
    metric.spend = num(row.spend);
    metric.conversions = conversionsFrom(row.actions);
    metric.currency = typeof row.account_currency === "string" ? row.account_currency : null;
    out.push(metric);
  }
  return out;
}

/**
 * Organic posts: Instagram media insights are lifetime-to-date, not per
 * day, so every row is a snapshot stamped with the day it was pulled and
 * marked cumulative. Summing these across dates would be wrong, which is
 * why basis is a column rather than a comment.
 */
export function normaliseOrganicPosts(rows: unknown[], asOf: string): MetricRow[] {
  const out: MetricRow[] = [];
  for (const entry of rows) {
    if (!isRecord(entry)) continue;
    const row = entry;
    const id = row.id;
    if (typeof id !== "string") continue;

    const metric = blank("organic", "post", id, asOf, "cumulative", row);
    metric.impressions = igMetric(row.insights, "impressions");
    metric.reach = igMetric(row.insights, "reach");
    // Newer IG accounts report "total_interactions" where older ones
    // report "engagement"; take whichever is present.
    metric.engagements =
      igMetric(row.insights, "engagement") ?? igMetric(row.insights, "total_interactions");
    out.push(metric);
  }
  return out;
}

/**
 * Organic account: /{ig-user-id}/insights with period=day IS a daily
 * series, unlike the media endpoint above.
 */
export function normaliseOrganicAccount(
  payload: unknown[],
  accountId: string,
  window: Window,
): MetricRow[] {
  const byDate = new Map<string, MetricRow>();

  for (const entry of payload) {
    if (!isRecord(entry)) continue;
    const metric = entry as { name?: unknown; values?: unknown };
    if (typeof metric?.name !== "string" || !Array.isArray(metric.values)) continue;

    for (const point of metric.values) {
      if (!isRecord(point)) continue;
      const value = point as { value?: unknown; end_time?: unknown };
      if (typeof value.end_time !== "string") continue;
      const date = value.end_time.slice(0, 10);
      if (!clampToWindow(date, window)) continue;

      let row = byDate.get(date);
      if (!row) {
        row = blank("organic", "account", accountId, date, "daily", []);
        byDate.set(date, row);
      }
      (row.raw as unknown[]).push(point);

      const n = num(value.value);
      if (metric.name === "impressions") row.impressions = n;
      else if (metric.name === "reach") row.reach = n;
      else if (metric.name === "accounts_engaged" || metric.name === "total_interactions") {
        row.engagements = n;
      }
    }
  }

  return [...byDate.values()].sort((a, b) => a.metric_date.localeCompare(b.metric_date));
}
