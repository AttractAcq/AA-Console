import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "../../lib/media";

const { fetchClientAssets, signPaths, useParams } = vi.hoisted(() => ({
  fetchClientAssets: vi.fn(),
  signPaths: vi.fn(),
  useParams: vi.fn(),
}));

vi.mock("../../lib/media", async () => {
  const actual = await vi.importActual<typeof import("../../lib/media")>("../../lib/media");
  return { ...actual, fetchClientAssets, signPaths };
});
vi.mock("react-router-dom", async (original) => ({
  ...(await original<typeof import("react-router-dom")>()),
  useParams,
}));
// A chain that answers whatever order the panel calls it in. The engine-held
// lookup is .select().eq().eq().not(), the rest are shorter, and a mock that
// only answers one shape fails on the first query that is not that shape.
const engineHeldRows: Array<{ asset_id: string | null }> = [];

vi.mock("../../lib/supabase", () => {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    not: () => Promise.resolve({ data: engineHeldRows, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    order: () => Promise.resolve({ data: [], error: null }),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  });
  return { supabase: { from: () => chain, rpc: vi.fn() } };
});

import { ApprovalsPanel } from "./ApprovalsPanel";

const COPY_BODY = "Book the shade guide consult this week. Mention the April offer.";

function textAsset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "asset-text-1",
    client_id: "client-1",
    brief_id: "brief-1",
    ref_number: "AA-0034",
    media_type: "text",
    title: "Shade guide follow-up",
    storage_path: "client-1/generated/aa-0034.md",
    review_status: "pending",
    member_id: null,
    created_at: "2026-09-18T10:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  engineHeldRows.length = 0;
  useParams.mockReturnValue({ clientId: "client-1" });
  // Two calls now: pending, and approved-without-a-human. They are mutually
  // exclusive in the database, so the mock answers only the pending one —
  // returning the same rows for both would list every asset twice.
  fetchClientAssets.mockImplementation(
    async (_clientId: string, opts?: { mediaType?: string; reviewStatus?: string }) => {
      if (opts?.reviewStatus !== "pending") return [];
      if (opts?.mediaType === "text") return [textAsset()];
      return [];
    },
  );
  signPaths.mockImplementation(async (_bucket: string, paths: string[]) => {
    return new Map(paths.map((path) => [path, `https://signed/${path.split("/").pop()}`]));
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith(".md")) {
        return new Response(COPY_BODY, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApprovalsPanel — text preview", () => {
  it("loads the markdown body into the preview instead of the failure message", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ApprovalsPanel /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "Text" }));
    expect(await screen.findByText("Shade guide follow-up")).toBeInTheDocument();
    expect(screen.getByText(COPY_BODY)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Preview Shade guide follow-up/ }));

    const dialog = await screen.findByRole("dialog", { name: "Shade guide follow-up" });
    expect(dialog).toHaveTextContent(COPY_BODY);
    expect(screen.queryByText(/copy could not be loaded/i)).not.toBeInTheDocument();
  });

  it("does not fetch copy when the signed URL is missing", async () => {
    signPaths.mockResolvedValue(new Map());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter><ApprovalsPanel /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "Text" }));
    await user.click(await screen.findByRole("button", { name: /Preview Shade guide follow-up/ }));

    expect(await screen.findByText(/copy could not be loaded/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ApprovalsPanel — review controls stay intact", () => {
  it("still offers Approve and Reject on a pending text asset", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ApprovalsPanel /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "Text" }));
    await screen.findByText("Shade guide follow-up");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("links a finished reel back to its production history", async () => {
    fetchClientAssets.mockImplementation(async (_clientId: string, opts?: { mediaType?: string; reviewStatus?: string }) =>
      opts?.reviewStatus === "pending" && opts?.mediaType === "video"
        ? [textAsset({ id: "reel-1", media_type: "video", content_format: "reel", title: "Launch reel",
          render_path: "client-1/reels/cut.mp4" })] : [],
    );
    render(<MemoryRouter><ApprovalsPanel /></MemoryRouter>);
    await userEvent.setup().click(screen.getByRole("button", { name: "Video" }));
    expect(await screen.findByRole("link", { name: "Production history" })).toHaveAttribute(
      "href", "/clients/client-1/delivery/media?tab=reel-shots&brief=brief-1",
    );
  });
});

describe("an asset the engine's own queue owns", () => {
  it("is not offered here, because approving it here would strand the slot", async () => {
    // review_media_asset signs the asset off and moves nothing. An asset
    // whose slot is awaiting_approval would end up approved with the slot
    // still waiting, never scheduled and in no queue at all — which is the
    // fault migration 159 exists to fix, reintroduced on the wrong tab.
    engineHeldRows.push({ asset_id: "asset-text-1" });
    const user = userEvent.setup();
    render(<MemoryRouter><ApprovalsPanel /></MemoryRouter>);

    await user.click(await screen.findByRole("button", { name: "Text" }));
    expect(await screen.findByText(/waiting on the Engine tab/i)).toBeInTheDocument();
    expect(screen.queryByText("Shade guide follow-up")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("counts them so nobody thinks the queue is empty", async () => {
    engineHeldRows.push({ asset_id: "asset-text-1" });
    const user = userEvent.setup();
    render(<MemoryRouter><ApprovalsPanel /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "Text" }));
    expect(await screen.findByText(/^1 piece is waiting on the Engine tab\./)).toBeInTheDocument();
  });

  it("says nothing when the engine holds nothing", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><ApprovalsPanel /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "Text" }));
    await screen.findByText("Shade guide follow-up");
    expect(screen.queryByText(/Engine tab/i)).not.toBeInTheDocument();
  });

  it("ignores a slot with no asset on it", async () => {
    engineHeldRows.push({ asset_id: null });
    const user = userEvent.setup();
    render(<MemoryRouter><ApprovalsPanel /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: "Text" }));
    expect(await screen.findByText("Shade guide follow-up")).toBeInTheDocument();
  });
});
