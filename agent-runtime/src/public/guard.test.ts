import { describe, expect, it } from "vitest";
import {
  boundHistory,
  callerIp,
  clientFacing,
  hashIp,
  MAX_HISTORY_TURNS,
  MAX_MESSAGE_CHARS,
  normaliseOrigin,
  originAllowed,
  publicConfig,
  reachableContact,
  transcriptToTurns,
  validateMessage,
} from "./guard.js";

describe("originAllowed", () => {
  const allowed = "https://attractacq.github.io";

  it("accepts the exact origin the deployment was deployed on", () => {
    expect(originAllowed("https://attractacq.github.io", allowed)).toBe(true);
  });

  it("accepts a custom domain once that is what the deployment says", () => {
    expect(originAllowed("https://offers.harbourdental.co.za", "https://offers.harbourdental.co.za")).toBe(true);
  });

  it("refuses another client's site", () => {
    expect(originAllowed("https://someoneelse.github.io", allowed)).toBe(false);
  });

  it("refuses a hostile origin that merely ends with the allowed one", () => {
    // An endsWith check would wave this through. It is a different site.
    expect(originAllowed("https://attractacq.github.io.evil.com", allowed)).toBe(false);
  });

  it("refuses a hostile origin that merely starts with the allowed one", () => {
    expect(originAllowed("https://attractacq.github.io.attacker.net", allowed)).toBe(false);
  });

  it("refuses a host that ends with the allowed one but is a different host", () => {
    // The real suffix-matching hole, and the one the other cases miss: an
    // attacker registers a name whose tail is the allowed host.
    expect(originAllowed("https://notattractacq.github.io", allowed)).toBe(false);
    expect(originAllowed("https://evil-attractacq.github.io", allowed)).toBe(false);
  });

  it("refuses http when the deployment is https", () => {
    // Scheme is part of the origin; downgrading must not pass.
    expect(originAllowed("http://attractacq.github.io", allowed)).toBe(false);
  });

  it("refuses a missing origin, because the widget always sends one", () => {
    expect(originAllowed(undefined, allowed)).toBe(false);
    expect(originAllowed("", allowed)).toBe(false);
  });

  it("refuses everything when the deployment has no origin recorded", () => {
    expect(originAllowed("https://anything.com", "")).toBe(false);
  });

  it("ignores a trailing slash and host case, which are not meaningful", () => {
    expect(originAllowed("https://AttractAcq.github.io/", allowed)).toBe(true);
  });

  it("ignores a path, which is not part of an origin", () => {
    expect(normaliseOrigin("https://attractacq.github.io/site/page")).toBe(
      "https://attractacq.github.io",
    );
  });
});

describe("clientFacing", () => {
  it("gives one identical answer for a missing deployment and a wrong origin", () => {
    // If these differed, the endpoint would confirm which deployments exist.
    const unavailable = clientFacing("unavailable");
    const origin = clientFacing("origin");
    expect(unavailable).toEqual(origin);
    expect(unavailable.status).toBe(404);
  });

  it("never leaks a reason a prober could use", () => {
    for (const reason of ["unavailable", "origin", "ceiling", "error"] as const) {
      const text = clientFacing(reason).body.error.toLowerCase();
      for (const leak of ["approved", "disabled", "draft", "limit", "budget", "spend", "agent"]) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it("does tell a caller plainly when the fault is their own behaviour", () => {
    // A legitimate widget needs to know to back off.
    expect(clientFacing("rate_limited").status).toBe(429);
    expect(clientFacing("rate_limited").body.error).toMatch(/too many/i);
    expect(clientFacing("too_large").status).toBe(413);
  });
});

describe("validateMessage", () => {
  it("accepts a real question", () => {
    expect(validateMessage("  Do you do full-arch implants?  ")).toEqual({
      message: "Do you do full-arch implants?",
    });
  });
  it("refuses empty and non-string input", () => {
    expect(validateMessage("   ")).toEqual({ reason: "bad_request" });
    expect(validateMessage(undefined)).toEqual({ reason: "bad_request" });
    expect(validateMessage(42)).toEqual({ reason: "bad_request" });
    expect(validateMessage({ message: "nested" })).toEqual({ reason: "bad_request" });
  });
  it("refuses a message used as a payload", () => {
    expect(validateMessage("x".repeat(MAX_MESSAGE_CHARS + 1))).toEqual({ reason: "too_large" });
  });
  it("accepts a message exactly at the limit", () => {
    expect(validateMessage("x".repeat(MAX_MESSAGE_CHARS))).toEqual({
      message: "x".repeat(MAX_MESSAGE_CHARS),
    });
  });
});

describe("boundHistory", () => {
  const turns = Array.from({ length: 50 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `turn ${i}`,
  }));

  it("caps the turns handed to the model, because input tokens are billed", () => {
    expect(boundHistory(turns)).toHaveLength(MAX_HISTORY_TURNS);
  });

  it("keeps the most recent turns, not the first", () => {
    const kept = boundHistory(turns, 3);
    expect(kept.map((t) => t.content)).toEqual(["turn 47", "turn 48", "turn 49"]);
  });

  it("drops blank turns rather than sending empty content to the model", () => {
    expect(boundHistory([{ role: "user", content: "  " }, { role: "user", content: "hi" }])).toEqual(
      [{ role: "user", content: "hi" }],
    );
  });
});

describe("transcriptToTurns", () => {
  it("reads a stored transcript", () => {
    expect(
      transcriptToTurns([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ]),
    ).toHaveLength(2);
  });

  it("drops a malformed row rather than losing the conversation", () => {
    const out = transcriptToTurns([
      { role: "user", content: "keep me" },
      null,
      "nope",
      { role: "system", content: "not a visitor turn" },
      { role: "assistant" },
      { role: "assistant", content: "" },
    ]);
    expect(out).toEqual([{ role: "user", content: "keep me" }]);
  });

  it("returns empty for anything that is not a list", () => {
    expect(transcriptToTurns(null)).toEqual([]);
    expect(transcriptToTurns({ role: "user" })).toEqual([]);
  });
});

describe("hashIp", () => {
  it("is stable for the same caller", () => {
    expect(hashIp("203.0.113.7", "salt")).toBe(hashIp("203.0.113.7", "salt"));
  });
  it("separates different callers", () => {
    expect(hashIp("203.0.113.7", "salt")).not.toBe(hashIp("203.0.113.8", "salt"));
  });
  it("never stores the address itself", () => {
    const hashed = hashIp("203.0.113.7", "salt");
    expect(hashed).not.toContain("203.0.113.7");
  });
  it("is useless against an IP list without the salt", () => {
    expect(hashIp("203.0.113.7", "salt-a")).not.toBe(hashIp("203.0.113.7", "salt-b"));
  });
  it("returns null when there is no address", () => {
    expect(hashIp(undefined, "salt")).toBeNull();
  });
});

describe("callerIp", () => {
  it("takes the original client, not the proxy", () => {
    // Taking the last entry would throttle every visitor behind one proxy together.
    expect(callerIp("203.0.113.7, 10.0.0.1, 10.0.0.2")).toBe("203.0.113.7");
  });
  it("handles a single value and an array header", () => {
    expect(callerIp("203.0.113.7")).toBe("203.0.113.7");
    expect(callerIp(["203.0.113.9, 10.0.0.1"])).toBe("203.0.113.9");
  });
  it("returns undefined when the header is absent or empty", () => {
    expect(callerIp(undefined)).toBeUndefined();
    expect(callerIp("")).toBeUndefined();
  });
});

describe("publicConfig", () => {
  it("returns only the greeting and widget styling", () => {
    const out = publicConfig({ greeting: "Hi there", widget_config: { label: "Ask us" } });
    expect(out).toEqual({
      greeting: "Hi there",
      widget: { label: "Ask us", accent: null, title: null },
    });
  });

  it("cannot leak the prompt, guardrails or script even when handed them", () => {
    // The resolver returns all of these in the same row. Allow-listing is what
    // stops the next added field from reaching a browser.
    const out = publicConfig({
      greeting: "Hi",
      widget_config: {
        label: "Chat",
        system_prompt: "SECRET INSTRUCTIONS",
        guardrails: "NEVER QUOTE A PRICE",
        qualification: [{ question: "budget?" }],
      },
    } as never);
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("SECRET INSTRUCTIONS");
    expect(serialised).not.toContain("NEVER QUOTE A PRICE");
    expect(serialised).not.toContain("budget?");
  });

  it("falls back to a usable greeting rather than an empty bubble", () => {
    expect(publicConfig({ greeting: null, widget_config: null }).greeting).toMatch(/how can we help/i);
    expect(publicConfig({ greeting: "   ", widget_config: [] }).widget.label).toBe("Chat");
  });
});


// A sales agent conversation used to end in a table nobody opens:
// capture_sales_agent_lead existed and nothing ever called it, so a visitor
// who left their number never appeared in Prospects & Leads. This is the
// question the runtime asks before promoting a conversation to a lead.
describe("reachableContact", () => {
  it("is true when there is an email", () => {
    expect(reachableContact({ contact_email: "sam@example.com", contact_phone: null })).toBe(true);
  });

  it("is true when there is only a phone", () => {
    // Plenty of people give a number and not an address.
    expect(reachableContact({ contact_email: null, contact_phone: "031 555 0100" })).toBe(true);
  });

  it("is false for a conversation that left no way to reach anyone", () => {
    // The normal case. Most visitors chat and leave nothing, and that must not
    // be an exception thrown and caught on every message.
    expect(reachableContact({ transcript: [] })).toBe(false);
    expect(reachableContact({ contact_email: null, contact_phone: null })).toBe(false);
  });

  it("does not count whitespace as a way to reach somebody", () => {
    expect(reachableContact({ contact_email: "   ", contact_phone: "\n\t" })).toBe(false);
  });

  it("does not count a name as a way to reach somebody", () => {
    // A lead with a name and no contact details is a row that pads the
    // pipeline and measures nothing — the same rule the database enforces.
    expect(reachableContact({ contact_name: "Sam", outcome: "Wants a quote" })).toBe(false);
  });

  it("ignores non-string values rather than treating them as contact details", () => {
    expect(reachableContact({ contact_email: 42, contact_phone: {} })).toBe(false);
    expect(reachableContact({ contact_email: true })).toBe(false);
  });
});
