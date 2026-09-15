import { describe, expect, it } from "vitest";
import {
  isMaturing,
  isUnavailable,
  money,
  ranges,
  showAcv,
  showCost,
  showRatio,
} from "./metrics";

const reason = (s: ReturnType<typeof showRatio>) =>
  isUnavailable(s) ? s.unavailable : `VALUE:${s.value}`;

describe("money", () => {
  it("prefixes a known currency and drops the cents", () => {
    expect(money(38000, "ZAR")).toBe("R38,000");
    expect(money(1500, "USD")).toBe("$1,500");
    expect(money(1500, "GBP")).toBe("£1,500");
  });
  it("falls back to the code for a currency it does not know", () => {
    expect(money(100, "JPY")).toBe("JPY 100");
  });
  it("renders a real zero rather than hiding it", () => {
    // A spend of zero is a fact. Only ratios become "—".
    expect(money(0, "ZAR")).toBe("R0");
  });
});

describe("showCost", () => {
  it("shows a cost when one exists", () => {
    expect(reason(showCost(2500, "ZAR", "leads"))).toBe("VALUE:R2,500");
  });
  it("refuses a cost per nothing, and says which stage is empty", () => {
    expect(reason(showCost(null, "ZAR", "appointments"))).toBe("No appointments in this cohort yet");
    expect(reason(showCost(null, "ZAR", "customers"))).toBe("No customers in this cohort yet");
  });
});

describe("showRatio", () => {
  it("shows a multiple when spend and revenue both exist", () => {
    expect(reason(showRatio(4, 10000, 40000))).toBe("VALUE:4.00×");
  });

  it("distinguishes no spend from no revenue, because they are different facts", () => {
    // One means the question is meaningless; the other means it is early.
    expect(reason(showRatio(null, 0, 0))).toBe("No spend recorded in this period");
    expect(reason(showRatio(0, 8888, 0))).toBe("No revenue from this cohort yet");
  });

  it("never renders a bare 0.00 for a cohort that has produced nothing yet", () => {
    // The database correctly returns 0.00 here. Showing it would read as
    // "this failed" when the truth is "nothing has landed yet".
    const shown = showRatio(0, 8888, 0);
    expect(isUnavailable(shown)).toBe(true);
  });

  it("keeps a genuine sub-1 multiple rather than calling it unavailable", () => {
    expect(reason(showRatio(0.4, 10000, 4000))).toBe("VALUE:0.40×");
  });
});

describe("showAcv", () => {
  it("needs a customer before it means anything", () => {
    expect(reason(showAcv(null, "ZAR", 0))).toBe("No customers in this cohort yet");
  });
  it("needs revenue too", () => {
    expect(reason(showAcv(0, "ZAR", 2))).toBe("No revenue from this cohort yet");
  });
  it("shows the value when both exist", () => {
    expect(reason(showAcv(20000, "ZAR", 2))).toBe("VALUE:R20,000");
  });
});

describe("isMaturing", () => {
  const today = new Date("2026-09-11T10:00:00Z");
  it("flags a window that has not closed yet", () => {
    // until is exclusive, so a window ending tomorrow is still filling.
    expect(isMaturing("2026-09-12", today)).toBe(true);
  });
  it("does not flag a window that has closed", () => {
    expect(isMaturing("2026-09-01", today)).toBe(false);
    expect(isMaturing("2026-09-11", today)).toBe(false);
  });
});

describe("ranges", () => {
  const today = new Date("2026-09-11T10:00:00Z");

  it("makes until exclusive so today is included exactly once", () => {
    const r = ranges(today);
    const last7 = r.find((x) => x.id === "7d")!;
    expect(last7.since).toBe("2026-09-05");
    expect(last7.until).toBe("2026-09-12");
  });

  it("spans 30 days inclusive of today", () => {
    const r30 = ranges(today).find((x) => x.id === "30d")!;
    expect(r30.since).toBe("2026-08-13");
    expect(r30.until).toBe("2026-09-12");
  });

  it("starts this month on the first", () => {
    const m = ranges(today).find((x) => x.id === "month")!;
    expect(m.since).toBe("2026-09-01");
  });

  it("makes last month a closed window that ends where this month starts", () => {
    const p = ranges(today).find((x) => x.id === "prev")!;
    expect(p.since).toBe("2026-08-01");
    expect(p.until).toBe("2026-09-01");
    // No gap and no overlap with "this month".
    expect(p.until).toBe(ranges(today).find((x) => x.id === "month")!.since);
  });

  it("rolls the year back correctly in January", () => {
    const jan = ranges(new Date("2027-01-15T10:00:00Z")).find((x) => x.id === "prev")!;
    expect(jan.since).toBe("2026-12-01");
    expect(jan.until).toBe("2027-01-01");
  });
});
