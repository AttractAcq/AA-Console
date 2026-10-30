import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { parseTrustedProxies } from "../public/client-ip.js";
import { requestProxyDiagnostic } from "./proxy.js";

function request(peer: string, forwarded?: string): Pick<IncomingMessage, "headers" | "socket"> {
  return { socket: { remoteAddress: peer } as IncomingMessage["socket"],
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded } };
}

describe("admin-only proxy topology diagnostic", () => {
  it("shows the canonical chain while using only a trusted direct peer", () => {
    const result = requestProxyDiagnostic(request("::ffff:10.0.0.2",
      " 203.0.113.9 , 10.0.0.3 "), parseTrustedProxies("10.0.0.0/8"));
    expect(result).toEqual({
      directPeer: "10.0.0.2", forwardedHops: ["203.0.113.9", "10.0.0.3"],
      chainStatus: "trusted_peer", trustedProxyCount: 1,
      callerIpUsedForQuota: "203.0.113.9",
    });
  });

  it("never promotes a spoofed forwarding header from an untrusted peer", () => {
    const result = requestProxyDiagnostic(request("198.51.100.3", "203.0.113.9"),
      parseTrustedProxies("10.0.0.0/8"));
    expect(result.chainStatus).toBe("ignored_untrusted_peer");
    expect(result.callerIpUsedForQuota).toBe("198.51.100.3");
  });

  it("refuses malformed or oversized chains without echoing raw text", () => {
    for (const forwarded of ["203.0.113.1, injected.example", "x".repeat(2049),
      Array.from({ length: 33 }, () => "10.0.0.1").join(",")]) {
      const result = requestProxyDiagnostic(request("10.0.0.2", forwarded),
        parseTrustedProxies("10.0.0.0/8"));
      expect(result.chainStatus).toBe("invalid");
      expect(result.forwardedHops).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("injected.example");
      expect(result.callerIpUsedForQuota).toBeNull();
    }
  });
});
