import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { collectReleaseProbe } from "./release-probe.js";

function authorized(header: string | undefined, expected: string | null): boolean {
  // Both sides must decode to exactly 32 bytes before the constant-time
  // comparison. Missing or malformed configuration cannot authorize a call.
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const candidate = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "")?.[1];
  return candidate !== undefined && timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
}

export function handleFreshReleaseProbe(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
  config: RuntimeConfig,
): void {
  res.setHeader("Cache-Control", "no-store");
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "GET") {
    json(405, { observationsComplete: false, reason: "method_not_allowed" });
    return;
  }
  if (!config.browserReleaseProbeToken || !/^[0-9a-f]{64}$/.test(config.browserReleaseProbeToken)) {
    json(503, { observationsComplete: false, reason: "release_probe_unconfigured" });
    return;
  }
  if (!authorized(req.headers.authorization, config.browserReleaseProbeToken)) {
    json(401, { observationsComplete: false, reason: "unauthorized" });
    return;
  }
  // This privileged route deliberately bypasses currentReleaseProbe's public
  // ten-second cache. The release job needs a new database and gateway read.
  void collectReleaseProbe(sb, config).then(
    (probe) => json(probe.observationsComplete ? 200 : 503, probe),
    () => json(503, { observationsComplete: false, reason: "release_probe_unavailable" }),
  );
}
