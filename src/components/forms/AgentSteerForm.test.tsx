import { describe, expect, it, vi } from "vitest";
import { submitAgentRun } from "./AgentSteerForm";
import { supabase } from "../../lib/supabase";

vi.mock("../../lib/supabase", () => ({ supabase: { from: vi.fn() } }));

describe("ICP quote provenance at submission", () => {
  it("refuses a verbatim quote without its source before any database write", async () => {
    await expect(submitAgentRun("icp", "client-id", {
      verified_customer_quotes: "An exact customer sentence",
      verified_quote_source: "",
      verified_quote_date: "2026-10-01",
    })).rejects.toThrow("Add the quote source and date");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("refuses a verbatim quote without its date before any database write", async () => {
    await expect(submitAgentRun("icp", "client-id", {
      verified_customer_quotes: "An exact customer sentence",
      verified_quote_source: "Call transcript",
      verified_quote_date: "",
    })).rejects.toThrow("Add the quote source and date");
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
