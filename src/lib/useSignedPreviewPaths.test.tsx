import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSignedPreviewPaths } from "./useSignedPreviewPaths";
import { BROWSER_PREVIEW_URL_TTL_SECONDS } from "./signedUrlPolicy";

const signPaths = vi.fn();
let authEvent: ((event: string) => void) | undefined;
const unsubscribe = vi.fn();
vi.mock("./media", () => ({ signPaths: (...args: unknown[]) => signPaths(...args) }));
vi.mock("./supabase", () => ({
  supabase: { auth: { onAuthStateChange: (callback: (event: string) => void) => {
    authEvent = callback;
    return { data: { subscription: { unsubscribe } } };
  } } },
}));

const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const visibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T00:00:00Z"));
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  signPaths.mockReset();
  unsubscribe.mockReset();
  authEvent = undefined;
});
afterEach(() => vi.useRealTimers());

describe("useSignedPreviewPaths", () => {
  it("re-signs before expiry and removes the previous URL while renewal is pending", async () => {
    let resolveSecond!: (value: Map<string, string>) => void;
    signPaths.mockResolvedValueOnce(new Map([["a.jpg", "first"]]))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const { result } = renderHook(() => useSignedPreviewPaths("client-media", ["a.jpg"]));
    await flush();
    expect(result.current.get("a.jpg")).toBe("first");
    await act(async () => { vi.advanceTimersByTime((BROWSER_PREVIEW_URL_TTL_SECONDS - 60) * 1000); });
    expect(signPaths).toHaveBeenCalledTimes(2);
    expect(result.current.size).toBe(0);
    await act(async () => { resolveSecond(new Map([["a.jpg", "second"]])); });
    expect(result.current.get("a.jpg")).toBe("second");
    expect(signPaths).toHaveBeenNthCalledWith(2, "client-media", ["a.jpg"]);
  });

  it("clears a hidden page and re-signs only when visible again", async () => {
    signPaths.mockResolvedValueOnce(new Map([["a.jpg", "first"]]))
      .mockResolvedValueOnce(new Map([["a.jpg", "second"]]));
    const { result } = renderHook(() => useSignedPreviewPaths("client-media", ["a.jpg"]));
    await flush();
    visibility("hidden");
    expect(result.current.size).toBe(0);
    await act(async () => { vi.advanceTimersByTime(BROWSER_PREVIEW_URL_TTL_SECONDS * 2000); });
    expect(signPaths).toHaveBeenCalledTimes(1);
    visibility("visible");
    await flush();
    expect(result.current.get("a.jpg")).toBe("second");
  });

  it("discards a late result for a changed path and never exposes the old path", async () => {
    let resolveOld!: (value: Map<string, string>) => void;
    signPaths.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(new Map([["b.jpg", "new"]]));
    const { result, rerender } = renderHook(({ path }) => useSignedPreviewPaths("client-media", [path]), {
      initialProps: { path: "a.jpg" },
    });
    rerender({ path: "b.jpg" });
    expect(result.current.size).toBe(0);
    await flush();
    expect(result.current.get("b.jpg")).toBe("new");
    await act(async () => { resolveOld(new Map([["a.jpg", "late"]])); });
    expect(result.current.get("a.jpg")).toBeUndefined();
    expect(result.current.get("b.jpg")).toBe("new");
  });

  it("clears on sign-out and discards the in-flight response on unmount", async () => {
    let resolve!: (value: Map<string, string>) => void;
    signPaths.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { result, unmount } = renderHook(() => useSignedPreviewPaths("client-media", ["a.jpg"]));
    act(() => authEvent?.("SIGNED_OUT"));
    expect(result.current.size).toBe(0);
    unmount();
    await act(async () => { resolve(new Map([["a.jpg", "late"]])); });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("clears an issued URL on sign-out and re-signs on focus with current permission", async () => {
    signPaths.mockResolvedValueOnce(new Map([["a.jpg", "first"]]))
      .mockResolvedValueOnce(new Map());
    const { result } = renderHook(() => useSignedPreviewPaths("client-media", ["a.jpg"]));
    await flush();
    expect(result.current.get("a.jpg")).toBe("first");
    act(() => authEvent?.("SIGNED_OUT"));
    expect(result.current.size).toBe(0);
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(signPaths).toHaveBeenCalledTimes(2);
    expect(result.current.size).toBe(0);
  });

  it("re-signs on focus after a background timer was delayed", async () => {
    signPaths.mockResolvedValueOnce(new Map([["a.jpg", "first"]]))
      .mockResolvedValueOnce(new Map([["a.jpg", "second"]]));
    const { result } = renderHook(() => useSignedPreviewPaths("client-media", ["a.jpg"]));
    await flush();
    // A focused page renews immediately, independent of timer scheduling.
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current.size).toBe(0);
    await flush();
    expect(result.current.get("a.jpg")).toBe("second");
  });

  it("keeps a denied preview empty and retries without extending the bearer TTL", async () => {
    signPaths.mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(new Map());
    const { result } = renderHook(() => useSignedPreviewPaths("proof", ["private.jpg"]));
    await flush();
    expect(result.current.size).toBe(0);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(signPaths).toHaveBeenCalledTimes(2);
    expect(result.current.size).toBe(0);
  });
});
