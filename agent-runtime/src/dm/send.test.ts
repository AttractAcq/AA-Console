import { describe, expect, it, vi } from "vitest";

import { classifyDmFailure, DmSendError, OUTSIDE_WINDOW_SUBCODE, sendDm } from "./send.js";

/**
 * Replying through the Send API — G01.
 *
 * The one classification that matters is the closed window. Retrying it
 * would burn five attempts to learn what the first refusal already said, and
 * nothing on our side can reopen it.
 */
const request = (over: Record<string, unknown> = {}) => ({
  accessToken: "tok",
  senderId: "page-1",
  recipientId: "igsid-9",
  text: "We do, yes. Would Thursday suit?",
  ...over,
});

const reply = (status: number, body: unknown) =>
  vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
    new Response(JSON.stringify(body), { status }));

describe("classifying a refusal", () => {
  it("never retries a closed window", () => {
    const error = classifyDmFailure(400, {
      error: { message: "outside allowed window", code: 10, error_subcode: OUTSIDE_WINDOW_SUBCODE },
    });
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Only another message from them reopens it");
  });

  it("retries a rate limit and a server fault", () => {
    expect(classifyDmFailure(429, {}).retryable).toBe(true);
    expect(classifyDmFailure(503, {}).retryable).toBe(true);
  });

  it("does not retry any other deliberate refusal", () => {
    expect(classifyDmFailure(400, { error: { message: "bad recipient" } }).retryable).toBe(false);
    expect(classifyDmFailure(403, { error: { message: "no permission" } }).retryable).toBe(false);
  });
});

describe("sending", () => {
  it("posts to the sender's messages edge with the recipient's scoped id", async () => {
    const fetchImpl = reply(200, { message_id: "mid-out-1" });
    const id = await sendDm({ ...request(), fetchImpl } as never);
    expect(id).toBe("mid-out-1");
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/page-1/messages");
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.recipient.id).toBe("igsid-9");
    expect(body.message.text).toBe("We do, yes. Would Thursday suit?");
  });

  it("sends messaging_type RESPONSE and no tag", async () => {
    const fetchImpl = reply(200, { message_id: "m" });
    await sendDm({ ...request(), fetchImpl } as never);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    // A tag would claim an exemption from the window that we do not have.
    expect(body.messaging_type).toBe("RESPONSE");
    expect(body.tag).toBeUndefined();
  });

  it("refuses an empty reply and a missing credential before calling out", async () => {
    const fetchImpl = reply(200, { message_id: "m" });
    await expect(sendDm({ ...request({ text: "   " }), fetchImpl } as never))
      .rejects.toBeInstanceOf(DmSendError);
    await expect(sendDm({ ...request({ accessToken: "" }), fetchImpl } as never))
      .rejects.toBeInstanceOf(DmSendError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries an unreachable API", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => { throw new Error("socket hang up"); });
    await expect(sendDm({ ...request(), fetchImpl } as never))
      .rejects.toMatchObject({ retryable: true });
  });

  it("does not retry an acceptance with no message id", async () => {
    const fetchImpl = reply(200, {});
    await expect(sendDm({ ...request(), fetchImpl } as never))
      .rejects.toMatchObject({ retryable: false });
  });
});
