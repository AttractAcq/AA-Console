const raw = import.meta.env.VITE_BUILD_SHA as string | undefined;

/** The browser bundle can claim a commit only when CI embedded a full SHA. */
export const browserBuildSha = raw && /^[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() : null;
