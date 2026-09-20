import { afterEach, describe, expect, it, vi } from "vitest";

// lib/supabase.ts creates a real client (and hits import.meta.env) at
// import time, so anything that pulls in ./media must have this mocked
// first. vi.mock factories are hoisted above imports, so the fake must be
// built inside vi.hoisted() to avoid a temporal-dead-zone reference.
const { createSignedUrls, from } = vi.hoisted(() => ({
  createSignedUrls: vi.fn(),
  from: vi.fn(),
}));
vi.mock("./supabase", () => ({
  supabase: {
    from,
    storage: {
      from: () => ({ createSignedUrls }),
    },
  },
}));

const { REVIEW_TONE, fetchClientAssets, fetchTextBodies, shortDate, signPaths } = await import("./media");

describe("shortDate", () => {
  it("renders an ISO timestamp as just the date", () => {
    expect(shortDate("2026-03-05T14:30:00.000Z")).toBe("2026-03-05");
  });
});

describe("REVIEW_TONE", () => {
  it("covers every review status", () => {
    expect(Object.keys(REVIEW_TONE).sort()).toEqual(["approved", "pending", "rejected"]);
  });
});

describe("signPaths", () => {
  it("returns an empty map without calling Supabase when there are no paths", async () => {
    const result = await signPaths("client-media", []);
    expect(result.size).toBe(0);
    expect(createSignedUrls).not.toHaveBeenCalled();
  });

  it("dedupes paths before requesting signed URLs", async () => {
    createSignedUrls.mockResolvedValueOnce({ data: [], error: null });
    await signPaths("client-media", ["a.png", "a.png", "b.png"]);
    expect(createSignedUrls).toHaveBeenCalledWith(["a.png", "b.png"], 3600);
  });

  it("drops entries that failed to sign", async () => {
    createSignedUrls.mockResolvedValueOnce({
      data: [
        { path: "a.png", signedUrl: "https://signed/a.png", error: null },
        { path: "b.png", signedUrl: null, error: { message: "not found" } },
      ],
      error: null,
    });
    const result = await signPaths("client-media", ["a.png", "b.png"]);
    expect(result.get("a.png")).toBe("https://signed/a.png");
    expect(result.has("b.png")).toBe(false);
  });

  it("returns an empty map when the request itself errors", async () => {
    createSignedUrls.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const result = await signPaths("client-media", ["a.png"]);
    expect(result.size).toBe(0);
  });
});

describe("fetchTextBodies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads markdown from each signed URL", async () => {
    const fetchMock = vi.fn(async () => new Response("# Hello\nCopy body", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchTextBodies(
      [{ id: "asset-1", storage_path: "c/generated/a.md" }],
      new Map([["c/generated/a.md", "https://signed/a.md"]]),
    );
    expect(result.get("asset-1")).toBe("# Hello\nCopy body");
    expect(fetchMock).toHaveBeenCalledWith("https://signed/a.md");
  });

  it("omits files that fail to fetch rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    const result = await fetchTextBodies(
      [{ id: "asset-1", storage_path: "c/generated/a.md" }],
      new Map([["c/generated/a.md", "https://signed/a.md"]]),
    );
    expect(result.size).toBe(0);
  });

  it("skips rows with no signed URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchTextBodies(
      [{ id: "asset-1", storage_path: "c/generated/a.md" }],
      new Map(),
    );
    expect(result.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe("fetchClientAssets and the human-approval filter", () => {
  /** Records every builder call so the query can be asserted on. */
  function recorder() {
    const calls: [string, ...unknown[]][] = [];
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "not"]) {
      chain[method] = (...args: unknown[]) => {
        calls.push([method, ...args]);
        return chain;
      };
    }
    chain.order = (...args: unknown[]) => {
      calls.push(["order", ...args]);
      return Promise.resolve({ data: [], error: null });
    };
    from.mockReturnValue(chain);
    return calls;
  }

  it("asks for only what a person approved", async () => {
    const calls = recorder();
    await fetchClientAssets("c1", { reviewStatus: "approved", humanApproved: true });
    expect(calls).toContainEqual(["not", "human_approved_at", "is", null]);
  });

  // An asset a bot approved is not pending, so this is the only way to
  // find it — without it, it sits in neither queue.
  it("asks for only what still needs a person", async () => {
    const calls = recorder();
    await fetchClientAssets("c1", { reviewStatus: "approved", humanApproved: false });
    expect(calls).toContainEqual(["is", "human_approved_at", null]);
  });

  it("filters on neither when the caller does not ask", async () => {
    const calls = recorder();
    await fetchClientAssets("c1", { reviewStatus: "pending" });
    expect(calls.some(([m, col]) => (m === "is" || m === "not") && col === "human_approved_at")).toBe(false);
  });

  it("selects the column, so a caller can tell the two apart", async () => {
    const calls = recorder();
    await fetchClientAssets("c1", {});
    expect(String(calls.find(([m]) => m === "select")?.[1])).toContain("human_approved_at");
  });
});
