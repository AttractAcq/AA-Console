import { useEffect, useMemo, useState } from "react";
import { signPaths } from "./media";
import { BROWSER_PREVIEW_URL_TTL_SECONDS } from "./signedUrlPolicy";
import { supabase } from "./supabase";

type Snapshot = {
  key: string;
  urls: ReadonlyMap<string, string>;
};

const EMPTY_URLS: ReadonlyMap<string, string> = new Map();
const REFRESH_EARLY_MS = 60_000;
const RETRY_MS = 60_000;
const pageIsHidden = () => document.visibilityState === "hidden";

/**
 * A preview is a short-lived bearer URL, not durable page state. Re-sign the
 * current paths through Storage authorization while the page is visible,
 * clear old URLs before every renewal, and discard late or obsolete results.
 */
export function useSignedPreviewPaths(
  bucket: string,
  paths: readonly (string | null | undefined)[],
  enabled = true,
): ReadonlyMap<string, string> {
  const pathsKey = JSON.stringify([...new Set(paths.filter((path): path is string => Boolean(path)))].sort());
  const stablePaths = useMemo(() => JSON.parse(pathsKey) as string[], [pathsKey]);
  const key = JSON.stringify([bucket, pathsKey, enabled]);
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: "", urls: EMPTY_URLS });

  useEffect(() => {
    let disposed = false;
    let request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const clear = () => setSnapshot({ key, urls: EMPTY_URLS });

    const renew = async () => {
      const current = ++request;
      clearTimer();
      clear();
      if (!enabled || stablePaths.length === 0 || pageIsHidden()) return;
      const startedAt = Date.now();
      try {
        const urls = await signPaths(bucket, stablePaths);
        if (disposed || current !== request || pageIsHidden()) return;
        const expiresAt = startedAt + BROWSER_PREVIEW_URL_TTL_SECONDS * 1000;
        if (Date.now() >= expiresAt) {
          timer = setTimeout(() => { void renew(); }, 0);
          return;
        }
        setSnapshot({ key, urls });
        const refreshAt = expiresAt - REFRESH_EARLY_MS;
        timer = setTimeout(() => { void renew(); }, Math.max(0, refreshAt - Date.now()));
      } catch {
        // Storage permission or network failure: never restore the old bearer URL.
        if (!disposed && current === request && !pageIsHidden()) {
          timer = setTimeout(() => { void renew(); }, RETRY_MS);
        }
      }
    };

    const onVisibility = () => {
      if (pageIsHidden()) {
        ++request;
        clearTimer();
        clear();
      } else void renew();
    };
    const onFocus = () => {
      if (!pageIsHidden()) void renew();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    // Keep sign-out from leaving a bearer URL in the DOM. Supabase calls must
    // not run synchronously within an auth callback, so other events defer.
    const auth = supabase.auth?.onAuthStateChange?.((event) => {
      if (event === "SIGNED_OUT") {
        ++request;
        clearTimer();
        clear();
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        clearTimer();
        timer = setTimeout(() => { if (!disposed) void renew(); }, 0);
      }
    });
    void renew();
    return () => {
      disposed = true;
      ++request;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      auth?.data.subscription.unsubscribe();
    };
  }, [bucket, enabled, key, stablePaths]);

  if (!enabled || snapshot.key !== key) return EMPTY_URLS;
  return snapshot.urls;
}
