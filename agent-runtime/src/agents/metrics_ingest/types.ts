// Shared shapes for metrics ingest.
//
// The source is an interface on purpose. Today it is Meta's Graph API
// directly; if AA Graph API turns out to be a wrapper that already handles
// auth and normalisation, it implements MetricsSource and nothing else in
// the runner changes.

export type Surface = "paid" | "organic" | "landing" | "offer";
export type EntityType = "account" | "campaign" | "post" | "page";
export type Basis = "daily" | "cumulative";

export interface Window {
  since: string; // YYYY-MM-DD, inclusive
  until: string; // YYYY-MM-DD, inclusive
}

/** One row ready for metrics_daily, before client-side ids are attached. */
export interface MetricRow {
  surface: Surface;
  entity_type: EntityType;
  external_id: string;
  metric_date: string;
  basis: Basis;
  impressions: number | null;
  reach: number | null;
  clicks: number | null;
  engagements: number | null;
  spend: number | null;
  conversions: number | null;
  currency: string | null;
  raw: unknown;
}

export interface SourceCredentials {
  accessToken: string;
  /** act_<id> for paid; the IG user id for organic. */
  accountId: string;
}

export interface MetricsSource {
  readonly name: string;
  fetch(surface: Surface, window: Window, creds: SourceCredentials): Promise<unknown[]>;
}

/** Upstream failures the runner must tell apart to decide on a retry. */
export class SourceError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "SourceError";
    this.retryable = retryable;
  }
}
