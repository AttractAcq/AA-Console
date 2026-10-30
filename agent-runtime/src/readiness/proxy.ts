import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { normalizeIp, resolveCallerIp, type TrustedProxies } from "../public/client-ip.js";

export type RequestProxyDiagnostic = {
  directPeer: string | null;
  forwardedHops: string[];
  chainStatus: "absent" | "invalid" | "ignored_untrusted_peer" | "trusted_peer";
  trustedProxyCount: number;
  signedIngressRequired: boolean;
  callerIpUsedForQuota: string | null;
};

/** Read-only diagnostics for the authenticated admin's own request. Never
 * echo a raw header: cap, parse and canonicalize every hop first. */
export function requestProxyDiagnostic(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustedProxies: TrustedProxies,
  signedIngressRequired = false,
): RequestProxyDiagnostic {
  const directPeer = normalizeIp(req.socket.remoteAddress);
  const callerIpUsedForQuota = signedIngressRequired ? null : resolveCallerIp(req, trustedProxies);
  const base = { directPeer, trustedProxyCount: trustedProxies.count,
    signedIngressRequired, callerIpUsedForQuota };
  const raw = req.headers["x-forwarded-for"];
  if (raw === undefined) return { ...base, forwardedHops: [], chainStatus: "absent" };
  const chain = Array.isArray(raw) ? raw.join(",") : raw;
  if (chain.length > 2048) return { ...base, forwardedHops: [], chainStatus: "invalid" };
  const parts = chain.split(",");
  if (parts.length === 0 || parts.length > 32)
    return { ...base, forwardedHops: [], chainStatus: "invalid" };
  const forwardedHops = parts.map((part) => normalizeIp(part));
  if (forwardedHops.some((part) => part === null))
    return { ...base, forwardedHops: [], chainStatus: "invalid" };
  const trustedPeer = directPeer !== null && trustedProxies.count > 0 &&
    trustedProxies.blocks.check(directPeer, isIP(directPeer) === 4 ? "ipv4" : "ipv6");
  return {
    ...base,
    forwardedHops: forwardedHops as string[],
    chainStatus: trustedPeer ? "trusted_peer" : "ignored_untrusted_peer",
  };
}
