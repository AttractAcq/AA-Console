/** Read one exact Business Profile local post; this module has no write call. */
import { createHash } from "node:crypto";

const BASE = "https://mybusiness.googleapis.com/v4";
const LOCATION = /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+$/;
const POST = /^accounts\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/localPosts\/[A-Za-z0-9_-]+$/;

export type LocalPostObservation = {
  status: "live_exact_text" | "live_media_unverified" | "nonlive" |
    "mismatch" | "not_found" | "unavailable";
  providerState: string | null;
  observedSummarySha256: string | null;
  providerUrl: string | null;
};

function safeSearchUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "google.com" || url.hostname.endsWith(".google.com")
        || url.hostname === "g.co" || url.hostname === "g.page") ? url.href : null;
  } catch { return null; }
}

export async function readLocalPost(input: {
  accessToken: string;
  accountRef: string;
  externalId: string;
  expectedSummary: string;
  mediaRequired: boolean;
  fetchImpl?: typeof fetch;
}): Promise<LocalPostObservation> {
  const unavailable: LocalPostObservation = {
    status: "unavailable", providerState: null,
    observedSummarySha256: null, providerUrl: null,
  };
  if (!LOCATION.test(input.accountRef)
    || !POST.test(input.externalId)
    || !input.externalId.startsWith(`${input.accountRef}/localPosts/`)
    || !input.accessToken.trim()) return unavailable;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${BASE}/${input.externalId}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${input.accessToken}` },
    });
  } catch { return unavailable; }
  if (response.status === 404) return { ...unavailable, status: "not_found" };
  if (!response.ok) return unavailable;
  let value: unknown;
  try { value = await response.json(); } catch { return unavailable; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable;
  const body = value as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name : null;
  const summary = typeof body.summary === "string" ? body.summary : null;
  const providerState = typeof body.state === "string" ? body.state : null;
  if (!name || summary === null || !providerState) return unavailable;
  const observedSummarySha256 = createHash("sha256").update(summary).digest("hex");
  const providerUrl = safeSearchUrl(body.searchUrl);
  if (name !== input.externalId || summary !== input.expectedSummary) {
    return { status: "mismatch", providerState, observedSummarySha256,
      providerUrl: null };
  }
  return { status: providerState === "LIVE"
    ? input.mediaRequired ? "live_media_unverified" : "live_exact_text"
    : "nonlive", providerState, observedSummarySha256, providerUrl };
}
