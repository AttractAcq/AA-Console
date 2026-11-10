import { describe, expect, it, vi } from "vitest";
import { submitAgentRun } from "./AgentSteerForm";
import { supabase } from "../../lib/supabase";

vi.mock("../../lib/supabase", () => ({ supabase: { from: vi.fn() } }));

describe("ICP quote provenance at submission", () => {
  it("refuses a verbatim quote without its source before any database write", async () => {
    await expect(submitAgentRun("icp", "client-id", {
      verified_customer_quotes: "An exact customer sentence",
      verified_quote_source: "",
    })).rejects.toThrow("Add the quote source and date");
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
