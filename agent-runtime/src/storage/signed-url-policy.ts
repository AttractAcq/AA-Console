/**
 * Storage URLs sent to providers are bearer credentials. Keep these lifetimes
 * named and fixed at each call site; a job or request must never supply its
 * own expiry. The one-hour budget preserves the existing provider fetch
 * window until measured Meta, Google and Higgsfield fetch latencies are known.
 */
export const PROVIDER_MEDIA_FETCH_URL_TTL_SECONDS = 60 * 60;
export const RENDER_REFERENCE_FETCH_URL_TTL_SECONDS = 60 * 60;
export const PRIVATE_OBJECT_CACHE_CONTROL_SECONDS = "60";

/** Provider errors can echo an entire request, including a signed URL. */
export function safeProviderErrorMessage(message: string): string {
  if (/\/storage\/v1\/object\/(?:upload\/)?sign\//i.test(message)
      || /(?:[?&]|\b)token=/i.test(message)
      || /(?:%3f|%26|\b)token%3d/i.test(message)) {
    return "Provider error contained a signed Storage URL; details withheld.";
  }
  return message;
}
