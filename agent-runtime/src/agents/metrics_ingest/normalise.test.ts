import { describe, expect, it } from "vitest";
import { normaliseOrganicAccount, normaliseOrganicPosts, normalisePaid } from "./normalise.js";
import type { Window } from "./types.js";

const WINDOW: Window = { since: "2026-09-01", until: "2026-09-05" };

// Shapes taken from the Graph API's documented responses: every numeric
// field arrives as a string, and conversions are a list of action types.
const PAID_ROW = {
  campaign_id: "23851234567890123",
  campaign_name: "HD - Implants - Cold",
  impressions: "4821",
  reach: "3944",
  clicks: "137",
  spend: "84.22",
  account_currency: "ZAR",
  actions: [
    { action_type: "link_click", value: "137" },
    { action_type: "lead", value: "6" },
    { action_type: "offsite_conversion.fb_pixel_lead", value: "2" },
  ],
  date_start: "2026-09-01",
  date_stop: "2026-09-01",
};

describe("paid normalisation", () => {
  it("parses Meta's string numbers into real numbers", () => {
    const [row] = normalisePaid([PAID_ROW], WINDOW);
    expect(row).toMatchObject({
      surface: "paid",
      entity_type: "campaign",
      external_id: "23851234567890123",
      metric_date: "2026-09-01",
      impressions: 4821,
      reach: 3944,
      clicks: 137,
      spend: 84.22,
      currency: "ZAR",
    });
  });

  it("is daily, because time_increment=1 makes each row one day", () => {
    expect(normalisePaid([PAID_ROW], WINDOW)[0]?.basis).toBe("daily");
  });

  it("counts only actions that are actually conversions", () => {
    // 6 leads + 2 pixel leads = 8. The 137 link clicks are not conversions.
    expect(normalisePaid([PAID_ROW], WINDOW)[0]?.conversions).toBe(8);
  });

  it("reports no conversions rather than zero when none are present", () => {
    const row = { ...PAID_ROW, actions: [{ action_type: "link_click", value: "137" }] };
    expect(normalisePaid([row], WINDOW)[0]?.conversions).toBeNull();
  });

  it("drops rows outside the requested window", () => {
    const outside = { ...PAID_ROW, date_start: "2026-08-20" };
    expect(normalisePaid([outside], WINDOW)).toHaveLength(0);
  });

  it("skips a malformed row instead of writing a broken one", () => {
    const rows = normalisePaid([{ impressions: "5" }, PAID_ROW, null], WINDOW);
    expect(rows).toHaveLength(1);
  });

  it("keeps the payload so a mapping can be fixed without re-fetching", () => {
    expect(normalisePaid([PAID_ROW], WINDOW)[0]?.raw).toEqual(PAID_ROW);
  });
});

const MEDIA = {
  id: "17912345678901234",
  media_type: "VIDEO",
  timestamp: "2026-09-01T10:00:00+0000",
  insights: {
    data: [
      { name: "impressions", values: [{ value: 4100 }] },
      { name: "reach", values: [{ value: 3600 }] },
      { name: "total_interactions", values: [{ value: 210 }] },
    ],
  },
};

describe("organic post normalisation", () => {
  it("marks post metrics cumulative — they are lifetime-to-date, not daily", () => {
    const [row] = normaliseOrganicPosts([MEDIA], "2026-09-05");
    expect(row?.basis).toBe("cumulative");
    expect(row).toMatchObject({
      surface: "organic",
      entity_type: "post",
      external_id: "17912345678901234",
      metric_date: "2026-09-05",
      impressions: 4100,
      reach: 3600,
      engagements: 210,
    });
  });

  it("accepts the older engagement metric name as well as the newer one", () => {
    const older = {
      ...MEDIA,
      insights: { data: [{ name: "engagement", values: [{ value: 99 }] }] },
    };
    expect(normaliseOrganicPosts([older], "2026-09-05")[0]?.engagements).toBe(99);
  });

  it("leaves a missing metric null rather than defaulting it to zero", () => {
    const sparse = { id: "abc", insights: { data: [] } };
    const [row] = normaliseOrganicPosts([sparse], "2026-09-05");
    expect(row?.impressions).toBeNull();
    expect(row?.engagements).toBeNull();
  });
});

const ACCOUNT_INSIGHTS = [
  {
    name: "impressions",
    period: "day",
    values: [
      { value: 1200, end_time: "2026-09-02T07:00:00+0000" },
      { value: 1500, end_time: "2026-09-03T07:00:00+0000" },
    ],
  },
  {
    name: "reach",
    period: "day",
    values: [{ value: 900, end_time: "2026-09-02T07:00:00+0000" }],
  },
];

describe("organic account normalisation", () => {
  it("is daily, unlike the media endpoint", () => {
    const rows = normaliseOrganicAccount(ACCOUNT_INSIGHTS, "ig-1", WINDOW);
    expect(rows.every((r) => r.basis === "daily")).toBe(true);
  });

  it("folds separate metric series into one row per date", () => {
    const rows = normaliseOrganicAccount(ACCOUNT_INSIGHTS, "ig-1", WINDOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ metric_date: "2026-09-02", impressions: 1200, reach: 900 });
    expect(rows[1]).toMatchObject({ metric_date: "2026-09-03", impressions: 1500, reach: null });
  });

  it("carries the account id so rows cannot collide across clients", () => {
    const rows = normaliseOrganicAccount(ACCOUNT_INSIGHTS, "ig-1", WINDOW);
    expect(rows.every((r) => r.external_id === "ig-1")).toBe(true);
    expect(rows.every((r) => r.entity_type === "account")).toBe(true);
  });

  it("drops points outside the window", () => {
    const rows = normaliseOrganicAccount(ACCOUNT_INSIGHTS, "ig-1", {
      since: "2026-09-03",
      until: "2026-09-05",
    });
    expect(rows.map((r) => r.metric_date)).toEqual(["2026-09-03"]);
  });
});

/**
 * Instagram renamed `impressions` to `views` in the 2024 Graph API, and
 * asking for the old name fails the whole request rather than omitting one
 * column. Observed against the live account on 6 October: the token was
 * fine, the metric name was not.
 *
 * Both names are read, because stored payloads from before the rename are
 * still worth normalising if anything replays them.
 */
describe("the rename of impressions to views", () => {
  const point = (name: string, value: number) => ({
    name,
    period: "day",
    values: [{ value, end_time: "2026-10-05T07:00:00+0000" }],
  });

  it("reads views as impressions", () => {
    const rows = normaliseOrganicAccount(
      [point("views", 120), point("reach", 90)],
      "acct-1",
      { since: "2026-10-01", until: "2026-10-10" },
    );
    expect(rows[0]).toMatchObject({ impressions: 120, reach: 90 });
  });

  it("still reads the old name, so a replay of an older payload works", () => {
    const rows = normaliseOrganicAccount(
      [point("impressions", 55)],
      "acct-1",
      { since: "2026-10-01", until: "2026-10-10" },
    );
    expect(rows[0]).toMatchObject({ impressions: 55 });
  });
});
