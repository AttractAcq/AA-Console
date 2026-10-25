import { describe, expect, it, vi } from "vitest";

import { deliverClaimedMessages, sendEmail, SENDERS, SendError, type ClaimedMessage } from "./courier.js";
import type { RuntimeConfig } from "../config.js";
import type { AgentJobRow } from "../queue.js";

/**
 * The governed courier — G02.
 *
 * Every rule about who may be messaged lives in the database, so what is
 * worth testing here is the blast radius of a transport that misbehaves: off
 * claims nothing, an ambiguous failure is retryable and carries an
 * idempotency key, an accepted send with no reference does not retry, and a
 * channel marked supported with no sender fails loudly rather than silently
 * dropping the message.
 */
const job = { id: "job-1" } as AgentJobRow;

const config = (over: Partial<RuntimeConfig> = {}) =>
  ({
    outboundMessagingEnabled: true,
    resendApiKey: "re_test",
    resendFrom: "AA <hello@attractacq.com>",
    ...over,
  }) as RuntimeConfig;

const message = (over: Partial<ClaimedMessage> = {}): ClaimedMessage => ({
  message_id: "m-1",
  client_id: "c-1",
  lead_id: "l-1",
  channel_key: "email",
  address: "priya@example.com",
  rendered_subject: "About your quote",
  rendered_body: "Hi Priya, about your quote.",
  attempts: 1,
  ...over,
});

function database(claimed: ClaimedMessage[] = [message()], claimError?: string) {
  const events: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (name: string, _args?: unknown) => {
    if (name === "claim_outbound_messages") {
      return claimError ? { data: null, error: { message: claimError } } : { data: claimed, error: null };
    }
    return { data: null, error: null };
  });
  const from = vi.fn(() => ({
    insert: vi.fn(async (row: Record<string, unknown>) => {
      events.push(row);
      return { error: null };
    }),
  }));
  return { sb: { rpc, from } as never, rpc, events };
}

const ok = (id = "resend-1") =>
  vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify({ id }), { status: 200 }));

describe("the switch", () => {
  it("claims nothing at all when outbound messaging is off", async () => {
    const { sb, rpc, events } = database();
    const result = await deliverClaimedMessages(sb, config({ outboundMessagingEnabled: false }), job);
    expect(result.ok).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
    expect(String(events[0]!.description)).toMatch(/Outbound messaging is off in this runtime/);
  });

  it("says so rather than failing when nothing is waiting", async () => {
    const { sb, events } = database([]);
    const result = await deliverClaimedMessages(sb, config(), job);
    expect(result.ok).toBe(true);
    expect(String(events[0]!.description)).toMatch(/No message was waiting/);
  });

  it("retries a claim that could not be read", async () => {
    const { sb } = database([], "connection lost");
    const result = await deliverClaimedMessages(sb, config(), job);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });
});

describe("sending", () => {
  it("records the provider's reference on a send", async () => {
    const { sb, rpc } = database();
    const fetchImpl = ok("resend-abc");
    await deliverClaimedMessages(sb, config(), job, fetchImpl as never);
    expect(rpc).toHaveBeenCalledWith("record_outbound_message_sent",
      expect.objectContaining({ p_message_id: "m-1", p_external_id: "resend-abc" }));
  });

  it("keys the provider request on the message, so a retry is not a second email", async () => {
    const fetchImpl = ok();
    await sendEmail(config(), message(), fetchImpl as never);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("outbound-m-1");
  });

  it("sends the body the database rendered, not one built here", async () => {
    const fetchImpl = ok();
    await sendEmail(config(), message(), fetchImpl as never);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toBe("Hi Priya, about your quote.");
    expect(body.to).toEqual(["priya@example.com"]);
    expect(body.subject).toBe("About your quote");
  });

  it("treats an unreachable provider as retryable", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error("socket hang up");
    });
    await expect(sendEmail(config(), message(), fetchImpl as never))
      .rejects.toMatchObject({ retryable: true });
  });

  it("treats a rate limit and a server error as retryable, a rejection as not", async () => {
    for (const [status, retryable] of [[429, true], [503, true], [422, false]] as const) {
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response("no", { status }));
      await expect(sendEmail(config(), message(), fetchImpl as never))
        .rejects.toMatchObject({ retryable });
    }
  });

  it("does not retry a send the provider accepted without a reference", async () => {
    // Worse than a failure: it may be on its way with nothing to trace.
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({}), { status: 200 }));
    await expect(sendEmail(config(), message(), fetchImpl as never))
      .rejects.toMatchObject({ retryable: false });
  });

  it("refuses when the provider is not configured, retryably", async () => {
    await expect(sendEmail(config({ resendApiKey: null }), message()))
      .rejects.toMatchObject({ retryable: true });
  });
});

describe("a channel with no sender", () => {
  it("has a sender for every channel the registry calls supported", () => {
    // The guard on the other direction: this list and
    // message_channels.supported have to agree, and the failure mode of them
    // disagreeing is a message claimed and then failed.
    expect(Object.keys(SENDERS)).toEqual(["email", "instagram_dm", "messenger"]);
  });

  it("fails loudly and non-retryably rather than dropping the message", async () => {
    const { sb, rpc } = database([message({ channel_key: "sms" })]);
    await deliverClaimedMessages(sb, config(), job, ok() as never);
    expect(rpc).toHaveBeenCalledWith("record_outbound_message_failure",
      expect.objectContaining({ p_retryable: false }));
    const args = rpc.mock.calls.find((c) => c[0] === "record_outbound_message_failure")?.[1] as
      { p_reason: string };
    expect(args.p_reason).toContain("No sender is implemented for sms");
  });
});

describe("recording what happened", () => {
  it("retries when the send worked but recording it did not", async () => {
    const { sb, rpc } = database();
    rpc.mockImplementation(async (name: string, _args?: unknown) => {
      if (name === "claim_outbound_messages") return { data: [message()], error: null };
      if (name === "record_outbound_message_sent") {
        return { data: null, error: { message: "write failed" } };
      }
      return { data: null, error: null };
    });
    await deliverClaimedMessages(sb, config(), job, ok() as never);
    const args = rpc.mock.calls.find((c) => c[0] === "record_outbound_message_failure")?.[1] as
      { p_reason: string; p_retryable: boolean };
    // Retryable, and safe to retry: the provider key makes the resend a no-op.
    expect(args.p_retryable).toBe(true);
    expect(args.p_reason).toContain("Sent, but could not record it");
  });

  it("keeps going after one message fails", async () => {
    const { sb, rpc } = database([message({ message_id: "m-1" }), message({ message_id: "m-2" })]);
    let call = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      call += 1;
      return call === 1
        ? new Response("nope", { status: 422 })
        : new Response(JSON.stringify({ id: "resend-2" }), { status: 200 });
    });
    const result = await deliverClaimedMessages(sb, config(), job, fetchImpl as never);
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("record_outbound_message_failure",
      expect.objectContaining({ p_message_id: "m-1" }));
    expect(rpc).toHaveBeenCalledWith("record_outbound_message_sent",
      expect.objectContaining({ p_message_id: "m-2" }));
  });
});
