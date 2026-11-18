import { describe, expect, it } from "vitest";

import { runOpportunityDiscoveryJob } from "./opportunity_discovery/index.js";
import { runOpportunityEvaluateJob } from "./opportunity_evaluate/index.js";
import { runOpportunityStrategiseJob } from "./opportunity_strategise/index.js";

type ReadResult = { data: unknown; error: { message: string } | null };

function reader(results: Record<string, ReadResult>) {
  return {
    from(table: string) {
      const result = results[table];
      if (!result) throw new Error(`Unexpected read: ${table}`);
      const query: Record<string, unknown> = {};
      for (const step of ["select", "eq", "in", "order", "limit"]) {
        query[step] = () => query;
      }
      query.maybeSingle = async () => result;
      query.then = (resolve: (value: ReadResult) => unknown) => Promise.resolve(result).then(resolve);
      return query;
    },
  };
}

const job = {
  id: "11111111-1111-4111-8111-111111111111",
  client_id: "22222222-2222-4222-8222-222222222222",
  input_table: "market_opportunities",
  input_id: "33333333-3333-4333-8333-333333333333",
};
const opportunity = { id: job.input_id, client_id: job.client_id, name: "Garage conversion" };
const failure = { data: null, error: { message: "read unavailable" } };
const healthy = (data: unknown): ReadResult => ({ data, error: null });

describe("opportunity agents require successful source reads", () => {
  it("does not discover from an unreadable offer catalog", async () => {
    const db = reader({
      client_agent_records: healthy([{ id: "source", domain: "market", title: "Market", body: "Garage" }]),
      service_offers: failure,
    });
    await expect(runOpportunityDiscoveryJob(db as never, {} as never,
      { agent_key: "opportunity_discovery" } as never, job as never, Date.now() + 60_000))
      .rejects.toThrow("Offer lookup failed: read unavailable");
  });

  it("does not evaluate when Intelligence cannot be read", async () => {
    const db = reader({
      market_opportunities: healthy(opportunity),
      opportunity_score_factors: healthy([{ factor: "available_proof", weight: 0.15, label: "Proof" }]),
      client_agent_records: failure,
    });
    await expect(runOpportunityEvaluateJob(db as never, {} as never,
      { agent_key: "opportunity_evaluate" } as never, job as never, Date.now() + 60_000))
      .rejects.toThrow("Intelligence lookup failed: read unavailable");
  });

  it("does not evaluate from an unreadable offer catalog", async () => {
    const db = reader({
      market_opportunities: healthy(opportunity),
      opportunity_score_factors: healthy([{ factor: "available_proof", weight: 0.15, label: "Proof" }]),
      client_agent_records: healthy([]),
      service_offers: failure,
    });
    await expect(runOpportunityEvaluateJob(db as never, {} as never,
      { agent_key: "opportunity_evaluate" } as never, job as never, Date.now() + 60_000))
      .rejects.toThrow("Offer lookup failed: read unavailable");
  });

  it("does not strategise when Intelligence cannot be read", async () => {
    const db = reader({ market_opportunities: healthy(opportunity), client_agent_records: failure });
    await expect(runOpportunityStrategiseJob(db as never, {} as never,
      { agent_key: "opportunity_strategise" } as never, job as never, Date.now() + 60_000))
      .rejects.toThrow("Intelligence lookup failed: read unavailable");
  });
});
