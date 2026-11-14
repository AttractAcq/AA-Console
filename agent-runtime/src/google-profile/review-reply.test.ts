import { describe, expect, it, vi } from "vitest";
import { GoogleReplyTransportError, putApprovedReviewReply } from "./review-reply.js";

const name = "accounts/a1/locations/l2/reviews/r3";
const reviewUrl = `https://mybusiness.googleapis.com/v4/${name}`;
const replyUrl = `${reviewUrl}/reply`;
const body = "Thank you for the detailed review.";
const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200, headers: { "Content-Type": "application/json" },
});
const base = {
  accessToken: "fixture-token", locationRef: "accounts/a1/locations/l2",
  reviewRef: "r3", exactBody: body,
};

describe("Google review reply provider transport", () => {
  it("checks the exact approval after reading the provider and before PUT", async () => {
    const fetchImpl = vi.fn(async () => json({ name })) as unknown as typeof fetch;
    const assertPrewrite = vi.fn(async () => { throw new Error("decision revoked"); });
    await expect(putApprovedReviewReply({ ...base, fetchImpl, assertPrewrite }))
      .rejects.toThrow("decision revoked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(reviewUrl, expect.objectContaining({ method: "GET" }));
  });

  it("refuses to overwrite a different provider reply", async () => {
    const fetchImpl = vi.fn(async () => json({ name, reviewReply: { comment: "Different words" } })) as unknown as typeof fetch;
    const assertPrewrite = vi.fn(async () => {});
    await expect(putApprovedReviewReply({ ...base, fetchImpl, assertPrewrite }))
      .rejects.toThrow(/different reply words/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(assertPrewrite).not.toHaveBeenCalled();
  });

  it("sends the exact words once, then reads them back", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ name }))
      .mockResolvedValueOnce(json({ comment: body }))
      .mockResolvedValueOnce(json({ name, reviewReply: {
        comment: body, updateTime: "2026-11-15T00:00:00Z", reviewReplyState: "PUBLISHED",
      } })) as unknown as typeof fetch;
    const assertPrewrite = vi.fn(async () => {});
    const receipt = await putApprovedReviewReply({ ...base, fetchImpl, assertPrewrite });
    expect(assertPrewrite).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenNthCalledWith(2, replyUrl, expect.objectContaining({
      method: "PUT", body: JSON.stringify({ comment: body }),
    }));
    expect(receipt).toMatchObject({ reviewRef: name, alreadyPresent: false,
      providerState: "PUBLISHED", providerUpdateTime: "2026-11-15T00:00:00Z" });
    expect(receipt.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reconciles the same reply without a second write", async () => {
    const fetchImpl = vi.fn(async () => json({ name, reviewReply: { comment: body } })) as unknown as typeof fetch;
    const receipt = await putApprovedReviewReply({ ...base, fetchImpl, assertPrewrite: async () => {} });
    expect(receipt.alreadyPresent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).not.toHaveBeenCalledWith(replyUrl, expect.anything());
  });

  it("treats an unreadable write outcome as uncertain and never retries automatically", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ name }))
      .mockRejectedValueOnce(new Error("connection dropped")) as unknown as typeof fetch;
    await expect(putApprovedReviewReply({ ...base, fetchImpl, assertPrewrite: async () => {} }))
      .rejects.toMatchObject({ outcomeUncertain: true } satisfies Partial<GoogleReplyTransportError>);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a wrong location or oversized UTF-8 reply before contacting Google", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(putApprovedReviewReply({ ...base, reviewRef: "accounts/other/locations/l2/reviews/r3",
      fetchImpl, assertPrewrite: async () => {} })).rejects.toThrow(/does not belong/);
    await expect(putApprovedReviewReply({ ...base, exactBody: "é".repeat(2049),
      fetchImpl, assertPrewrite: async () => {} })).rejects.toThrow(/4096/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
