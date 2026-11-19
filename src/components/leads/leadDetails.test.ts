import { describe, expect, it } from "vitest";

import { changedLeadFieldsPayload, leadFormValues } from "./leadDetails";
import type { Lead } from "./types";

const lead: Lead = {
  id: "lead-1", name: "Sam", contact: "sam@example.test", email: "sam@example.test",
  phone: null, stage: "shown", stage_at: "2026-11-19T08:00:00Z",
  next_action: null, next_action_due: null, opportunity_value: 5000,
  sale_value: 3000, cash_collected: 1000, source_channel: "website",
  owner_member_id: "owner-1", appointment_at: null, appointment_outcome: null,
};

describe("lead detail changes", () => {
  it("does not resend stale cash, sale or owner values when editing an unrelated field", () => {
    const baseline = leadFormValues(lead);
    const changed = { ...baseline, next_action: "Call tomorrow" };
    expect(changedLeadFieldsPayload(changed, baseline)).toEqual({ next_action: "Call tomorrow" });
  });

  it("can deliberately clear a financial field without rewriting the other one", () => {
    const baseline = leadFormValues(lead);
    const changed = { ...baseline, cash_collected: "" };
    expect(changedLeadFieldsPayload(changed, baseline)).toEqual({ cash_collected: null });
    expect(changedLeadFieldsPayload(baseline, baseline)).toEqual({});
  });
});
