import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

/** Only explicitly configured, directly connected proxies may supply XFF. */
export type TrustedProxies = { blocks: BlockList; count: number };

export function parseTrustedProxies(raw: string | undefined): TrustedProxies {
  const blocks = new BlockList();
  if (!raw?.trim()) return { blocks, count: 0 };
  const entries = raw.split(",").map((part) => part.trim());
  if (entries.some((part) => !part)) throw new Error("PUBLIC_TRUSTED_PROXY_CIDRS contains an empty entry");
  for (const entry of entries) {
    const [address, bits, extra] = entry.split("/");
    const family = isIP(address ?? "");
    const max = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (extra !== undefined || !max || !bits || !/^\d+$/.test(bits)
        || Number(bits) === 0 || Number(bits) > max) {
      throw new Error("PUBLIC_TRUSTED_PROXY_CIDRS must contain valid IPv4/IPv6 CIDRs");
    }
    blocks.addSubnet(address!, Number(bits), family === 4 ? "ipv4" : "ipv6");
  }
  return { blocks, count: entries.length };
}

/** Canonicalize before hashing so alternative IPv6 spellings share a bucket. */
export function normalizeIp(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (isIP(trimmed) === 4) return trimmed;
  if (isIP(trimmed) !== 6) return null;
  // Node's URL parser serializes IPv6 in a stable, compressed form.
  const normalized = new URL(`http://[${trimmed}]/`).hostname.slice(1, -1).toLowerCase();
  return normalized.startsWith("::ffff:") && isIP(normalized.slice(7)) === 4
    ? normalized.slice(7)
    : normalized;
}

function trusted(ip: string, policy: TrustedProxies): boolean {
  return policy.blocks.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
}

/** Walk from the socket backwards; untrusted leftmost values are never used. */
export function resolveCallerIp(req: Pick<IncomingMessage, "headers" | "socket">, policy: TrustedProxies): string | null {
  const peer = normalizeIp(req.socket.remoteAddress);
  if (!peer) return null;
  if (!policy.count || !trusted(peer, policy)) return peer;
  const header = req.headers["x-forwarded-for"];
  if (header === undefined) return peer;
  const hops = (Array.isArray(header) ? header.join(",") : header).split(",");
  if (hops.length > 32) return null;
  const normalized = hops.map((hop) => normalizeIp(hop));
  if (normalized.some((hop) => hop === null)) return null;
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    const hop = normalized[i]!;
    if (!trusted(hop, policy)) return hop;
  }
  return normalized[0] ?? peer;
}
