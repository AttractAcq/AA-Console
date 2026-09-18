import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null }),
          order: () => Promise.resolve({ data: [] }),
        }),
        in: () => Promise.resolve({ data: [] }),
      }),
    }),
    rpc: vi.fn(),
  },
}));

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
  useParams.mockReturnValue({ clientId: "client-1" });
  fetchClientAssets.mockImplementation(async (_clientId: string, opts?: { mediaType?: string }) => {
    if (opts?.mediaType === "text") return [textAsset()];
    return [];
  });
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
    render(<ApprovalsPanel />);

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
    render(<ApprovalsPanel />);

    await user.click(await screen.findByRole("button", { name: "Text" }));
    await user.click(await screen.findByRole("button", { name: /Preview Shade guide follow-up/ }));

    expect(await screen.findByText(/copy could not be loaded/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ApprovalsPanel — review controls stay intact", () => {
  it("still offers Approve and Reject on a pending text asset", async () => {
    const user = userEvent.setup();
    render(<ApprovalsPanel />);
    await user.click(await screen.findByRole("button", { name: "Text" }));
    await screen.findByText("Shade guide follow-up");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });
});
