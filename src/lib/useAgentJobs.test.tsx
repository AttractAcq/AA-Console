import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { useAgentJobs } from "./useAgentJobs";

const pending = new Map<string, (result: { data: unknown[]; error: null }) => void>();
vi.mock("./supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: (_field: string, clientId: string) => ({
          order: () => ({ limit: () => new Promise((resolve) => {
            pending.set(clientId, resolve as (result: { data: unknown[]; error: null }) => void);
          }) }),
        }),
      }),
    }),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: vi.fn(),
  },
}));

it("discards a late job response from a previous client", async () => {
  pending.clear();
  const { result, rerender } = renderHook(
    ({ clientId }) => useAgentJobs(clientId),
    { initialProps: { clientId: "client-a" } },
  );
  await waitFor(() => expect(pending.has("client-a")).toBe(true));
  rerender({ clientId: "client-b" });
  expect(result.current.loaded).toBe(false);
  expect(result.current.jobs).toEqual([]);
  await waitFor(() => expect(pending.has("client-b")).toBe(true));
  await act(async () => pending.get("client-b")!({ data: [{ id: "b-job", status: "completed",
    completed_at: null }], error: null }));
  expect(result.current.jobs.map((job) => job.id)).toEqual(["b-job"]);
  await act(async () => pending.get("client-a")!({ data: [{ id: "a-job", status: "completed",
    completed_at: null }], error: null }));
  expect(result.current.jobs.map((job) => job.id)).toEqual(["b-job"]);
});
