import { describe, expect, it } from "vitest";

import { compiledOfferArgs, requestedOffer, submitTool, validateOffer } from "./index.js";

/**
 * Two things worth pinning here.
 *
 * The job parameters are read defensively. Migration 307 validates kind and
 * source before queueing, but a job row can also be written by the gateway or
 * a cron, and an agent that trusted `params` would compile a main offer
 * because `kind` was absent rather than because anybody asked for one.
 *
 * And exclusions are required with a floor of one, which is stricter than the
 * RPC. An offer that lists what is included and nothing about what is not is
 * the one that causes the argument after the invoice.
 */
const good = () => ({
  service_name: "Garage Gym Conversion",
  audience: "Homeowners with a detached garage used for storage",
  promise: "A garage you can train in, without losing the storage you need",
  inclusions: ["Insulation and damp-proofing", "Rubber flooring", "Lighting and power"],
  exclusions: ["Gym equipment", "Planning permission where required"],
});

it("uses a strict Anthropic object schema for compiled offers", () => {
  expect(submitTool.inputSchema.additionalProperties).toBe(false);
  expect(submitTool.inputSchema.required).toEqual([
    "service_name", "audience", "promise", "inclusions", "exclusions",
  ]);
});

it("passes the complete RPC signature and keeps unverified economics empty", () => {
  const checked = validateOffer(good());
  if ("error" in checked) throw new Error(checked.error);
  expect(compiledOfferArgs("client-1", "secondary", "job-1", checked)).toEqual({
    p_client_id: "client-1",
    p_kind: "secondary",
    p_service_name: checked.serviceName,
    p_audience: checked.audience,
    p_promise: checked.promise,
    p_inclusions: checked.inclusions,
    p_exclusions: checked.exclusions,
    p_price_amount: null,
    p_currency: null,
    p_delivery_cost_estimate: null,
    p_claims: [],
    p_idempotency_key: "job-1:1",
  });
});

describe("reading what the job asked for", () => {
  it("takes a valid kind and source", () => {
    expect(requestedOffer({ kind: "secondary", source: "micro_niche" }))
      .toEqual({ kind: "secondary", source: "micro_niche" });
  });

  it("refuses rather than defaulting to a main offer", () => {
    // The dangerous version of this bug is silent: an absent kind becoming
    // "main" compiles the wrong artefact and nobody is told.
    for (const params of [null, {}, { source: "strategy" }, { kind: "", source: "strategy" }]) {
      expect(requestedOffer(params as Record<string, unknown> | null))
        .toEqual({ error: "This job does not say whether it is a main or a secondary offer." });
    }
  });

  it("refuses an unknown source", () => {
    expect(requestedOffer({ kind: "main", source: "vibes" }))
      .toEqual({ error: "This job does not say what to compile the offer from." });
    expect(requestedOffer({ kind: "main" }))
      .toEqual({ error: "This job does not say what to compile the offer from." });
  });
});

describe("a usable offer", () => {
  it("takes the shape apart and trims it", () => {
    const body = good();
    body.service_name = "  Garage Gym Conversion  ";
    body.inclusions = ["Insulation", "  ", ""];
    const out = validateOffer(body);
    expect(out).toEqual({
      serviceName: "Garage Gym Conversion",
      audience: good().audience,
      promise: good().promise,
      inclusions: ["Insulation"],
      exclusions: good().exclusions,
    });
  });
});

describe("what it refuses", () => {
  it("insists on at least one exclusion", () => {
    const body = good();
    body.exclusions = [];
    expect(validateOffer(body)).toEqual({
      error: "An offer needs at least one exclusion. One that says what is in and nothing about what is out is the offer that causes the argument after the invoice.",
    });
  });

  it("insists on at least one inclusion", () => {
    const body = good();
    body.inclusions = ["   "];
    expect(validateOffer(body)).toEqual({ error: "An offer needs at least one inclusion." });
  });

  it("refuses an empty or over-long name, audience or promise", () => {
    const cases: Array<[keyof ReturnType<typeof good>, number, string]> = [
      ["service_name", 200, "The offer came back with no usable service name."],
      ["audience", 2000, "The offer came back with no usable audience."],
      ["promise", 4000, "The offer came back with no usable promise."],
    ];
    for (const [key, limit, message] of cases) {
      const blank = good();
      (blank[key] as unknown) = "   ";
      expect(validateOffer(blank)).toEqual({ error: message });
      const long = good();
      (long[key] as unknown) = "x".repeat(limit + 1);
      expect(validateOffer(long)).toEqual({ error: message });
    }
  });

  it("refuses a list that is not a list of strings", () => {
    const body = good();
    (body.inclusions as unknown) = "Insulation";
    expect(validateOffer(body)).toEqual({ error: "An offer needs at least one inclusion." });
    const nested = good();
    (nested.exclusions as unknown) = [["Gym equipment"]];
    expect(validateOffer(nested)).toMatchObject({ error: expect.stringContaining("exclusion") });
  });

  it("refuses shapes that are not an offer at all", () => {
    expect(validateOffer(null))
      .toEqual({ error: "The offer came back in a shape this cannot read." });
    expect(validateOffer("an offer"))
      .toEqual({ error: "The offer came back in a shape this cannot read." });
  });
});
