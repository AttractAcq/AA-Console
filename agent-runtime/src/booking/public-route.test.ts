import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { parseTrustedProxies } from "../public/client-ip.js";

import { handlePublicBooking as routeBooking, isBookingRequest } from "./public-route.js";

const config = { publicIpSalt: "test-salt", trustedProxies: parseTrustedProxies(undefined) } as RuntimeConfig;
const handlePublicBooking = (req: IncomingMessage, res: ServerResponse, sb: SupabaseClient) =>
  routeBooking(req, res, sb, config);

/**
 * The public booking surface — G04.
 *
 * It is unauthenticated, so the tests are about what it refuses to reveal
 * and what it refuses to decide. Availability and the lock live in the
 * database; this route must not grow its own opinion about either.
 */
/** A real readable stream: readJsonBody listens for 'data' and 'end'. */
function request(url: string, method = "GET", body?: unknown): IncomingMessage {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as IncomingMessage;
  req.url = url;
  req.method = method;
  req.headers = { "content-type": "application/json" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "203.0.113.9" } });
  return req;
}

function response() {
  const out = { status: 0, body: "" as string, headers: {} as Record<string, string> };
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => {
      out.status = status; out.headers = headers;
    },
    end: (body?: string) => { out.body = body ?? ""; },
  } as unknown as ServerResponse;
  return { res, out };
}

const TOKEN = "a".repeat(64);
const db = (over: Record<string, unknown> = {}) => {
  const rpc = vi.fn(async (name: string, _args?: unknown) => {
    if (name in over) return over[name] as { data: unknown; error: unknown };
    if (name === "admit_public_route_v6") return { data: true, error: null };
    if (name === "public_slots_for_link_v6") {
      return { data: [{ starts_at: "2026-11-02T10:00:00Z" }], error: null };
    }
    return { data: [{ appointment_id: "ap-1", starts_at: "2026-11-02T10:00:00Z" }], error: null };
  });
  return { sb: { rpc } as never, rpc };
};

describe("which requests are ours", () => {
  it("claims only the booking prefix", () => {
    expect(isBookingRequest(`/public/book/v1/${TOKEN}`)).toBe(true);
    expect(isBookingRequest("/public/lead/submit")).toBe(false);
    expect(isBookingRequest(undefined)).toBe(false);
  });

  it("refuses a malformed token without touching the database", async () => {
    const { res, out } = response();
    const { sb, rpc } = db();
    await handlePublicBooking(request("/public/book/v1/short"), res, sb);
    expect(out.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.parse(out.body).error).toBe("This booking link is not accepting bookings.");
  });

  it("refuses a path it does not recognise", async () => {
    const { res, out } = response();
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}/everything`), res, db().sb);
    expect(out.status).toBe(404);
  });
});

describe("reading the free times", () => {
  it("returns the slots the database computed", async () => {
    const { res, out } = response();
    const { sb, rpc } = db();
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}/slots`), res, sb);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).slots).toHaveLength(1);
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      "admit_public_route_v6", "public_slots_for_link_v6",
    ]);
  });

  it("refuses a saturated caller before reading slots", async () => {
    const { res, out } = response();
    const { sb, rpc } = db({ admit_public_route_v6: { data: false, error: null } });
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}/slots`), res, sb);
    expect(out.status).toBe(429);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith("public_slots_for_link_v6", expect.anything());
  });

  it("answers an empty list for a dead link, so a token cannot be probed", async () => {
    const { res, out } = response();
    const { sb } = db({ public_slots_for_link_v6: { data: [], error: null } });
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}/slots`), res, sb);
    // Not a 404: a wrong token and a real link with nothing free look the same.
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).slots).toEqual([]);
  });
});

describe("taking a slot", () => {
  const good = { name: "Priya", email: "p@example.com", consent: "They agreed", startsAt: "2026-11-02T10:00:00Z" };

  it("passes the body through and reports the booking", async () => {
    const { res, out } = response();
    const { sb, rpc } = db();
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}`, "POST", good), res, sb);
    expect(out.status).toBe(201);
    expect(rpc).toHaveBeenCalledWith("book_from_public_link_v6",
      expect.objectContaining({ p_email: "p@example.com", p_consent_wording: "They agreed" }));
    expect(JSON.parse(out.body).booked).toBe(true);
  });

  it("refuses a time it cannot parse before calling the booking RPC", async () => {
    const { res, out } = response();
    const { sb, rpc } = db();
    await handlePublicBooking(
      request(`/public/book/v1/${TOKEN}`, "POST", { ...good, startsAt: "soon" }), res, sb);
    expect(out.status).toBe(400);
    expect(rpc).not.toHaveBeenCalledWith("book_from_public_link_v6", expect.anything());
  });

  it("passes the database's own refusal back word for word", async () => {
    const { res, out } = response();
    const { sb } = db({
      book_from_public_link_v6: {
        data: null,
        error: { message: "That slot is not available. Read the free slots again and choose another." },
      },
    });
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}`, "POST", good), res, sb);
    expect(out.status).toBe(400);
    expect(JSON.parse(out.body).error).toContain("not available");
  });

  it("says nothing was held when the call returns no appointment", async () => {
    const { res, out } = response();
    const { sb } = db({ book_from_public_link_v6: { data: [], error: null } });
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}`, "POST", good), res, sb);
    expect(out.status).toBe(503);
    expect(JSON.parse(out.body).error).toContain("Nothing has been held");
  });

  it("refuses the wrong method on each endpoint", async () => {
    const a = response();
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}`, "GET"), a.res, db().sb);
    expect(a.out.status).toBe(405);
    const b = response();
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}/slots`, "POST", {}), b.res, db().sb);
    expect(b.out.status).toBe(405);
  });

  it("answers a preflight, because the page is on another origin", async () => {
    const { res, out } = response();
    await handlePublicBooking(request(`/public/book/v1/${TOKEN}`, "OPTIONS"), res, db().sb);
    expect(out.status).toBe(204);
    expect(out.headers["Access-Control-Allow-Origin"]).toBe("*");
  });
});
