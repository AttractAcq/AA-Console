/**
 * Browser URLs are bearer credentials. Keep previews short lived; callers
 * cannot choose a longer lifetime for a page that stays open.
 *
 * This does not revoke URLs issued before the policy changed. A fetched
 * object may also remain in an HTTP cache after the URL expires.
 */
export const BROWSER_PREVIEW_URL_TTL_SECONDS = 15 * 60;

/** New private uploads get a short object cache lifetime as well. */
export const PRIVATE_OBJECT_CACHE_CONTROL_SECONDS = "60";
