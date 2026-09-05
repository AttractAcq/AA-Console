import { describe, expect, it, vi } from "vitest";

// lib/supabase.ts creates a real client (and hits import.meta.env) at
// import time, so anything that pulls in ./media must have this mocked
// first. vi.mock factories are hoisted above imports, so the fake must be
// built inside vi.hoisted() to avoid a temporal-dead-zone reference.
const { createSignedUrls } = vi.hoisted(() => ({ createSignedUrls: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: {
    storage: {
      from: () => ({ createSignedUrls }),
    },
  },
}));

const { REVIEW_TONE, shortDate, signPaths } = await import("./media");

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
