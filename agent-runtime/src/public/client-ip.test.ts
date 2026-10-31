import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { normalizeIp, parseTrustedProxies, resolveCallerIp } from "./client-ip.js";

const request = (peer: string, forwarded?: string | string[]) => ({
  socket: { remoteAddress: peer },
  headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
}) as unknown as IncomingMessage;

describe("trusted public caller address", () => {
  it("ignores spoofed forwarding headers from a direct untrusted caller", () => {
    const policy = parseTrustedProxies("10.0.0.0/8");
    expect(resolveCallerIp(request("203.0.113.8", "198.51.100.1"), policy)).toBe("203.0.113.8");
    expect(resolveCallerIp(request("203.0.113.8", "malformed"), policy)).toBe("203.0.113.8");
    expect(resolveCallerIp(request("10.0.0.2", "198.51.100.1"), parseTrustedProxies(undefined)))
      .toBe("10.0.0.2");
  });

  it("walks a trusted chain from the right, ignoring a forged leftmost hop", () => {
    const policy = parseTrustedProxies("10.0.0.0/8,192.0.2.0/24");
    expect(resolveCallerIp(request("10.0.0.2", "198.51.100.99, 203.0.113.4, 192.0.2.7"), policy))
      .toBe("203.0.113.4");
    expect(resolveCallerIp(request("10.0.0.2", ["203.0.113.4", "192.0.2.7"]), policy))
      .toBe("203.0.113.4");
  });

  it("canonicalizes IPv6 and IPv4-mapped peers before hashing", () => {
    const policy = parseTrustedProxies("2001:db8:1::/48,10.0.0.0/8");
    expect(normalizeIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(resolveCallerIp(request("2001:db8:1::2", "2001:0db8:0000::1"), policy))
      .toBe("2001:db8::1");
    expect(resolveCallerIp(request("::ffff:10.0.0.2", "203.0.113.4"), policy))
      .toBe("203.0.113.4");
    expect(normalizeIp("::ffff:203.0.113.4")).toBe("203.0.113.4");
    expect(normalizeIp("::ffff:cb00:7104")).toBe("203.0.113.4");
  });

  it("rejects malformed trusted chains and missing socket peers", () => {
    const policy = parseTrustedProxies("10.0.0.0/8");
    expect(resolveCallerIp(request("10.0.0.2", "203.0.113.4, invalid"), policy)).toBeNull();
    expect(resolveCallerIp(request("10.0.0.2", "203.0.113.4,"), policy)).toBeNull();
    expect(resolveCallerIp(request("invalid", "203.0.113.4"), policy)).toBeNull();
    // net.isIP accepts zone IDs, but URL parsing does not. Both socket and
    // attacker-supplied forwarded cases must fail closed without throwing.
    expect(normalizeIp("fe80::1%en0")).toBeNull();
    expect(resolveCallerIp(request("fe80::1%en0", "203.0.113.4"), policy)).toBeNull();
    expect(resolveCallerIp(request("10.0.0.2", "fe80::1%en0"), policy)).toBeNull();
    expect(() => parseTrustedProxies("10.0.0.0/99")).toThrow(/PUBLIC_TRUSTED_PROXY_CIDRS/);
    expect(() => parseTrustedProxies("10.0.0.0/8,")).toThrow(/PUBLIC_TRUSTED_PROXY_CIDRS/);
  });
});
