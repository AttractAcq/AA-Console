import { expect, it, vi } from "vitest";
import { uploadRenderedCut } from "./upload.js";

it("retries a transient upload against the same rendered file before returning", async () => {
  const upload = vi.fn()
    .mockResolvedValueOnce({ error: { message: "Internal Server Error", statusCode: "500" } })
    .mockResolvedValueOnce({ error: { message: "rate limited", statusCode: "429" } })
    .mockResolvedValueOnce({ error: null });
  const sleep = vi.fn(async () => {});
  await uploadRenderedCut(upload, { sleep });
  expect(upload).toHaveBeenCalledTimes(3);
  expect(sleep.mock.calls).toEqual([[1000], [2000]]);
});

it("does not repeat a rejected upload request", async () => {
  const upload = vi.fn(async () => ({ error: { message: "invalid path", statusCode: "400" } }));
  await expect(uploadRenderedCut(upload, { sleep: async () => {} })).rejects.toThrow("invalid path");
  expect(upload).toHaveBeenCalledOnce();
});
