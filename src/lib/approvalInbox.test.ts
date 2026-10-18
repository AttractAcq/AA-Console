import { describe, expect, it } from "vitest";

import {
  inboxCard,
  inboxOrder,
  parseInterval,
  readReasons,
  relativeLabel,
  urgencyOf,
  type InboxRow,
} from "./approvalInbox";

const row = (over: Partial<InboxRow> = {}): InboxRow => ({
  slot_id: "slot-1",
  client_id: "client-1",
  client_name: "Harbour",
  platform: "instagram",
  format: "reel",
  scheduled_at: "2026-10-08T09:00:00Z",
  qa_score: 92,
  qa_findings: [],
  finding_count: 0,
  warnings: 0,
  attempts: 0,
  cost_usd: "1.2500",
  asset_id: "asset-1",
  asset_title: "The Chain",
  pillar_name: "Proof",
  idea_score: "7.5",
  idea_reasons: ["Nothing like it in the last month.", "The pillar is behind."],
  waiting_for: "03:14:00",
  goes_out_in: "20:00:00",
  overdue: false,
  human_approved_at: null,
  ...over,
});

describe("reading a Postgres interval", () => {
  it("reads the clock form", () => {
    expect(parseInterval("03:14:00")).toBe(3 * 3600 + 14 * 60);
    expect(parseInterval("00:01:30")).toBe(90);
  });

  it("reads days alongside the clock", () => {
    expect(parseInterval("2 days 03:00:00")).toBe(2 * 86400 + 3 * 3600);
    expect(parseInterval("1 day")).toBe(86400);
  });

  it("keeps the sign on every part Postgres signed", () => {
    // "-1 days -03:00:00" is minus 27 hours, not minus 21. Reading only the
    // clock part would report a post three hours late as twenty-one hours
    // early.
    expect(parseInterval("-00:40:00")).toBe(-2400);
    expect(parseInterval("-1 days -03:00:00")).toBe(-(86400 + 3 * 3600));
  });

  it("reads months and years, approximately and on purpose", () => {
    expect(parseInterval("1 mon 2 days")).toBe(30 * 86400 + 2 * 86400);
    expect(parseInterval("1 year")).toBe(365 * 86400);
  });

  it("reads fractional seconds", () => {
    expect(parseInterval("00:00:01.5")).toBe(1.5);
  });

  it("says nothing rather than guessing", () => {
    // Date.parse("2 days 03:00:00") is NaN, and NaN in a label reads as a
    // real answer.
    for (const bad of [null, undefined, "", "   ", "soon", "not an interval"]) {
      expect(parseInterval(bad)).toBeNull();
    }
  });
});

describe("how long, in words", () => {
  it("rounds down to the unit somebody would say", () => {
    expect(relativeLabel(3 * 3600 + 3500)).toBe("3 hours");
    expect(relativeLabel(119)).toBe("1 minute");
    expect(relativeLabel(2 * 86400 + 80000)).toBe("2 days");
  });

  it("does not pretend to a precision it has not got", () => {
    expect(relativeLabel(30)).toBe("under a minute");
    expect(relativeLabel(null)).toBe("unknown");
  });

  it("reads a negative interval by its size", () => {
    expect(relativeLabel(-7200)).toBe("2 hours");
  });
});

describe("how soon a slot needs a person", () => {
  it("trusts the view's own overdue flag", () => {
    expect(urgencyOf({ overdue: true, goes_out_in: "20:00:00" })).toBe("overdue");
  });

  it("treats a time that has gone as overdue even if the flag has not caught up", () => {
    expect(urgencyOf({ overdue: false, goes_out_in: "-00:40:00" })).toBe("overdue");
    expect(urgencyOf({ overdue: false, goes_out_in: "00:00:00" })).toBe("overdue");
  });

  it("calls the next day soon and anything further later", () => {
    expect(urgencyOf({ overdue: false, goes_out_in: "02:00:00" })).toBe("soon");
    expect(urgencyOf({ overdue: false, goes_out_in: "3 days" })).toBe("later");
  });

  it("does not call an unknown time urgent", () => {
    expect(urgencyOf({ overdue: false, goes_out_in: null })).toBe("later");
  });
});

describe("one card", () => {
  it("says how long it has waited and when it was meant to go out", () => {
    const card = inboxCard(row());
    expect(card.waited).toBe("Waiting 3 hours");
    expect(card.due).toBe("Goes out in 20 hours");
    expect(card.urgency).toBe("soon");
  });

  it("says a post is late rather than due in a negative number of hours", () => {
    const card = inboxCard(row({ overdue: true, goes_out_in: "-02:30:00" }));
    expect(card.due).toBe("Was due 2 hours ago");
    expect(card.urgency).toBe("overdue");
  });

  it("splits the findings so a blocker is never shown as a warning", () => {
    const card = inboxCard(
      row({
        qa_findings: [
          { severity: "blocker", detail: "Says the thing the brand forbids." },
          { severity: "warning", detail: "No proof on file." },
          { severity: "something else", detail: "Odd." },
        ],
      }),
    );
    expect(card.blockers).toHaveLength(1);
    expect(card.warnings).toHaveLength(1);
    expect(card.notes).toHaveLength(1);
  });

  it("reads the money as a number, whatever PostgREST sent", () => {
    // numeric arrives as a string, and "1.2500" + 0 is "1.25000".
    expect(inboxCard(row({ cost_usd: "1.2500" })).costUsd).toBe(1.25);
    expect(inboxCard(row({ cost_usd: null })).costUsd).toBe(0);
  });

  it("falls back to words rather than showing an empty line", () => {
    const card = inboxCard(row({ client_name: null, asset_title: "  ", pillar_name: "" }));
    expect(card.clientName).toBe("This client");
    expect(card.assetTitle).toBe("Untitled");
    expect(card.pillarName).toBeNull();
  });

  it("says the engine's reasons for choosing this idea", () => {
    expect(inboxCard(row()).reasons).toEqual([
      "Nothing like it in the last month.",
      "The pillar is behind.",
    ]);
  });
});

describe("the engine's reasons, whatever shape they were stored in", () => {
  it("reads an array", () => {
    expect(readReasons(["a", "b"])).toEqual(["a", "b"]);
  });

  it("reads an object as its own lines", () => {
    expect(readReasons({ freshness: 4, pillar: "behind" })).toEqual([
      "freshness: 4",
      "pillar: behind",
    ]);
  });

  it("reads a bare string", () => {
    expect(readReasons("Because.")).toEqual(["Because."]);
  });

  it("has nothing to say about null", () => {
    expect(readReasons(null)).toEqual([]);
    expect(readReasons("")).toEqual([]);
  });
});

describe("the order to work the queue in", () => {
  it("puts what is late first, then what is soonest", () => {
    const cards = [
      inboxCard(row({ slot_id: "later", scheduled_at: "2026-10-20T09:00:00Z", goes_out_in: "13 days" })),
      inboxCard(row({ slot_id: "late", scheduled_at: "2026-10-01T09:00:00Z", overdue: true, goes_out_in: "-5 days" })),
      inboxCard(row({ slot_id: "soon", scheduled_at: "2026-10-08T09:00:00Z", goes_out_in: "02:00:00" })),
    ];
    expect(inboxOrder(cards).map((c) => c.slotId)).toEqual(["late", "soon", "later"]);
  });

  it("does not reorder the caller's own array", () => {
    const cards = [inboxCard(row({ slot_id: "a" })), inboxCard(row({ slot_id: "b", overdue: true }))];
    inboxOrder(cards);
    expect(cards.map((c) => c.slotId)).toEqual(["a", "b"]);
  });
});
