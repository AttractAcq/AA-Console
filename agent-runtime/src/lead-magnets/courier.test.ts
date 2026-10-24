import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { RuntimeConfig } from "../config.js";
import type { AgentRow } from "../orchestration/registry.js";
import type { AgentJobRow } from "../queue.js";
import { runLeadMagnetCourierJob, type ClaimedDelivery } from "./courier.js";

/**
 * The courier, with storage and the provider faked.
 *
 * The assertion this file exists for is the hash check: the bytes in storage
 * are downloaded and hashed before they are attached, and a file that has
 * been replaced since approval is not sent. Everything else here is about
 * never recording a send that did not happen, and never retrying one that
 * might have.
 */

const agent = { agent_key: "lead_magnet_courier" } as unknown as AgentRow;
const job = { id: "job-1", params: { limit: 5 } } as unknown as AgentJobRow;
const on = {
  leadMagnetDeliveryEnabled: true,
  resendApiKey: "re_test",
  resendFrom: "AA Console <briefs@attractacq.com>",
} as RuntimeConfig;
const off = { leadMagnetDeliveryEnabled: false } as RuntimeConfig;

const FILE = Buffer.from("%PDF-1.7 a real guide");
const HASH = createHash("sha256").update(FILE).digest("hex");

const DELIVERY: ClaimedDelivery = {
  delivery_id: "del-1",
  client_id: "client-1",
  magnet_version_id: "ver-1",
  channel: "email",
  recipient: "jay@example.test",
  storage_path: "magnets/cost-guide-v1.pdf",
  media_type: "application/pdf",
  content_sha256: HASH,
  delivery_subject: "Your garage conversion cost guide",
  delivery_body: "Here it is, as promised.",
  magnet_name: "Garage conversion cost guide",
  attempt: 1,
};

function database(
  options: {
    claimed?: ClaimedDelivery[];
    file?: Buffer | null;
    downloadError?: string;
    status?: number;
    body?: unknown;
    recordError?: string;
    noFetch?: boolean;
  } = {},
) {
  const events: Record<string, unknown>[] = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "claim_lead_magnet_deliveries") {
      return { data: options.claimed ?? [DELIVERY], error: null };
    }
    if (name === "record_lead_magnet_sent" && options.recordError) {
      return { data: null, error: { message: options.recordError } };
    }
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === "agent_job_events") {
      return {
        insert: vi.fn(async (row: Record<string, unknown>) => {
          events.push(row);
          return { error: null };
        }),
      };
    }
    throw new Error(`The courier should not be reading ${table}.`);
  });
  const bytes = "file" in options ? options.file : FILE;
  const storage = {
    from: () => ({
      download: async () =>
        options.downloadError
          ? { data: null, error: { message: options.downloadError } }
          : {
              data: bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null,
              error: null,
            },
    }),
  };
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify(options.body ?? { id: "resend-42" }), {
      status: options.status ?? 200,
    }),
  );
  if (!options.noFetch) vi.stubGlobal("fetch", fetchImpl);
  return {
    sb: { rpc, from, storage } as unknown as SupabaseClient,
    events,
    calls,
    fetchImpl,
  };
}

const callsTo = (calls: Array<{ name: string; args: Record<string, unknown> }>, name: string) =>
  calls.filter((c) => c.name === name).map((c) => c.args);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the runtime switch", () => {
  it("claims nothing while delivery is off", async () => {
    const { sb, calls, events } = database();
    const result = await runLeadMagnetCourierJob(sb, off, agent, job);
    expect(result).toEqual({ ok: true, retryable: false });
    expect(callsTo(calls, "claim_lead_magnet_deliveries")).toHaveLength(0);
    expect(String(events[0]?.description)).toContain("LEAD_MAGNET_DELIVERY_ENABLED");
  });

  it("says so plainly when nobody is waiting", async () => {
    const { sb, events } = database({ claimed: [] });
    await runLeadMagnetCourierJob(sb, on, agent, job);
    expect(String(events[0]?.description)).toContain("Nobody is waiting");
  });
});

describe("the exact file, re-checked against its bytes", () => {
  it("sends the approved file and records the provider reference", async () => {
    const { sb, calls, fetchImpl } = database();
    await runLeadMagnetCourierJob(sb, on, agent, job);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    const sent = JSON.parse(String(init.body)) as Record<string, never>;
    expect(sent.to).toEqual(["jay@example.test"]);
    expect(sent.subject).toBe("Your garage conversion cost guide");
    // The approved bytes, attached, not a link that may have expired by the
    // time somebody opens their email.
    expect(sent.attachments).toEqual([
      { filename: "cost-guide-v1.pdf", content: FILE.toString("base64") },
    ]);
    // The provider's own duplicate guard is keyed on the delivery.
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "lead-magnet-del-1",
    );

    expect(callsTo(calls, "record_lead_magnet_sent")).toEqual([
      { p_delivery_id: "del-1", p_provider_ref: "resend-42" },
    ]);
  });

  it("refuses to send a file that no longer hashes to what was approved", async () => {
    // The database's hash records what was uploaded. It cannot prove the
    // object in storage was not replaced afterwards, which is what this check
    // is for.
    const { sb, calls, fetchImpl } = database({ file: Buffer.from("a different document") });
    await runLeadMagnetCourierJob(sb, on, agent, job);

    expect(fetchImpl).not.toHaveBeenCalled();
    const failure = callsTo(calls, "record_lead_magnet_failure")[0]!;
    expect(String(failure.p_reason)).toContain("no longer matches what was approved");
    expect(failure.p_retryable).toBe(false);
    expect(callsTo(calls, "record_lead_magnet_sent")).toHaveLength(0);
  });

  it("retries a storage read that failed, since nothing was sent", async () => {
    const { sb, calls } = database({ downloadError: "connection reset" });
    await runLeadMagnetCourierJob(sb, on, agent, job);
    expect(callsTo(calls, "record_lead_magnet_failure")[0]).toMatchObject({ p_retryable: true });
  });
});

describe("which failures may be tried again", () => {
  it("retries a rate limit or a server error", async () => {
    for (const status of [429, 500, 503]) {
      const { sb, calls } = database({ status, body: { message: "slow down" } });
      await runLeadMagnetCourierJob(sb, on, agent, job);
      expect(
        callsTo(calls, "record_lead_magnet_failure")[0],
        `${status} should be retryable`,
      ).toMatchObject({ p_retryable: true });
    }
  });

  it("does not retry a rejected address", async () => {
    const { sb, calls } = database({ status: 422, body: { message: "invalid recipient" } });
    await runLeadMagnetCourierJob(sb, on, agent, job);
    const failure = callsTo(calls, "record_lead_magnet_failure")[0]!;
    expect(failure.p_retryable).toBe(false);
    expect(String(failure.p_reason)).toContain("422");
  });

  it("retries a missing provider configuration without sending", async () => {
    const { sb, calls, fetchImpl } = database();
    await runLeadMagnetCourierJob(
      sb,
      { leadMagnetDeliveryEnabled: true } as RuntimeConfig,
      agent,
      job,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(callsTo(calls, "record_lead_magnet_failure")[0]).toMatchObject({ p_retryable: true });
  });

  it("treats an accepted send with no reference as something to go and check", async () => {
    const { sb, calls } = database({ body: { ok: true } });
    await runLeadMagnetCourierJob(sb, on, agent, job);
    const failure = callsTo(calls, "record_lead_magnet_failure")[0]!;
    expect(failure.p_retryable).toBe(false);
    expect(String(failure.p_reason)).toContain("nothing to trace");
  });

  it("has no courier for a download link, and says so once", async () => {
    const { sb, calls, fetchImpl } = database({
      claimed: [{ ...DELIVERY, channel: "download_link" }],
    });
    await runLeadMagnetCourierJob(sb, on, agent, job);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(callsTo(calls, "record_lead_magnet_failure")[0]).toMatchObject({ p_retryable: false });
  });
});

describe("sent but not recorded", () => {
  it("says it went out, and does not offer a retry", async () => {
    const { sb, calls } = database({ recordError: "deadlock detected" });
    await runLeadMagnetCourierJob(sb, on, agent, job);
    const failure = callsTo(calls, "record_lead_magnet_failure")[0]!;
    expect(String(failure.p_reason)).toContain("Sent, but could not record it");
    expect(failure.p_retryable).toBe(false);
  });
});

describe("one delivery's failure is its own", () => {
  it("carries on to the next and reports both", async () => {
    const { sb, calls, events } = database({
      claimed: [
        { ...DELIVERY, delivery_id: "del-bad", channel: "download_link" },
        { ...DELIVERY, delivery_id: "del-good" },
      ],
    });
    await runLeadMagnetCourierJob(sb, on, agent, job);
    expect(callsTo(calls, "record_lead_magnet_failure")[0]).toMatchObject({
      p_delivery_id: "del-bad",
    });
    expect(callsTo(calls, "record_lead_magnet_sent")[0]).toMatchObject({
      p_delivery_id: "del-good",
    });
    expect(events.map((e) => String(e.description))).toContain("1 sent, 1 not.");
  });
});
