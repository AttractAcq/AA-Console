import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkClientBudget } from "./budget.js";

const sbWith = (data: unknown, error: unknown = null) =>
  ({ rpc: vi.fn(async () => ({ data, error })) }) as unknown as SupabaseClient;

const state = (over: Record<string, unknown> = {}) => [
  { capped: true, cap_usd: 50, spent_usd: 10, remaining_usd: 40, ...over },
];

describe("a client over its monthly cap starts nothing", () => {
  it("allows work under the cap", async () => {
    expect(await checkClientBudget(sbWith(state()), "client-1")).toMatchObject({ allowed: true });
  });

  it("refuses at the cap, not only past it", async () => {
    // Spending exactly the cap has used all of it. Allowing equality would
    // let one more job through every month, at whatever that job costs.
    const result = await checkClientBudget(sbWith(state({ spent_usd: 50, remaining_usd: 0 })), "client-1");
    expect(result.allowed).toBe(false);
    expect(result.message).toMatch(/\$50\.00 of its \$50\.00 cap/);
  });

  it("refuses past the cap and says what was spent", async () => {
    const result = await checkClientBudget(sbWith(state({ spent_usd: 63.4, remaining_usd: -13.4 })), "client-1");
    expect(result.allowed).toBe(false);
    expect(result.message).toMatch(/\$63\.40/);
    expect(result.message).toMatch(/Raise the cap/);
  });

  it("treats a cap of zero as stop, because that is what it means", async () => {
    const result = await checkClientBudget(sbWith(state({ cap_usd: 0, spent_usd: 0, remaining_usd: 0 })), "client-1");
    expect(result.allowed).toBe(false);
  });
});

describe("no cap is not a cap of zero", () => {
  it("allows everything when no budget row exists", async () => {
    // The whole safety of shipping this. capped=false is every client today;
    // reading it as zero would have stopped all of them at once.
    const noRow = [{ capped: false, cap_usd: null, spent_usd: 120, remaining_usd: null }];
    expect(await checkClientBudget(sbWith(noRow), "client-1")).toMatchObject({ allowed: true });
  });

  it("allows when the function returns nothing at all", async () => {
    expect(await checkClientBudget(sbWith([]), "client-1")).toMatchObject({ allowed: true });
    expect(await checkClientBudget(sbWith(null), "client-1")).toMatchObject({ allowed: true });
  });

  it("allows a capped row whose cap somehow came back null", async () => {
    const odd = [{ capped: true, cap_usd: null, spent_usd: 10, remaining_usd: null }];
    expect(await checkClientBudget(sbWith(odd), "client-1")).toMatchObject({ allowed: true });
  });

  it("lets capped=false win over a cap figure that is somehow still present", async () => {
    // capped is the authoritative "is there a row" signal. Without this case
    // the flag is unobservable: every no-cap fixture also has a null cap, so
    // removing the check entirely still passes. Found by mutating it.
    const contradictory = [{ capped: false, cap_usd: 10, spent_usd: 999, remaining_usd: -989 }];
    expect(await checkClientBudget(sbWith(contradictory), "client-1")).toMatchObject({ allowed: true });
  });
});

describe("the cap is a cost control, not a safety interlock", () => {
  it("lets work through when the budget read fails", async () => {
    // Refusing the whole queue because one SELECT timed out would turn a
    // budgeting feature into an outage.
    const broken = sbWith(null, { message: "statement timeout" });
    expect(await checkClientBudget(broken, "client-1")).toMatchObject({ allowed: true });
  });

  it("lets work through when the budget read throws rather than returns", async () => {
    // Not the same path as a returned error. A missing rpc, a dead transport
    // or a client stubbed without one all throw, and dispatch must survive it.
    const throwing = { rpc: async () => { throw new Error("no rpc here"); } } as unknown as SupabaseClient;
    expect(await checkClientBudget(throwing, "client-1")).toMatchObject({ allowed: true });
    const noRpcAtAll = {} as unknown as SupabaseClient;
    expect(await checkClientBudget(noRpcAtAll, "client-1")).toMatchObject({ allowed: true });
  });

  it("does not ask at all for a job with no client", async () => {
    const sb = sbWith(state({ spent_usd: 9999 }));
    expect(await checkClientBudget(sb, null)).toMatchObject({ allowed: true });
    expect(sb.rpc).not.toHaveBeenCalled();
  });

  it("handles numeric coming back as a string, which PostgREST does", async () => {
    const asText = [{ capped: true, cap_usd: "50.00", spent_usd: "50.00", remaining_usd: "0.00" }];
    expect((await checkClientBudget(sbWith(asText), "client-1")).allowed).toBe(false);
  });
});
