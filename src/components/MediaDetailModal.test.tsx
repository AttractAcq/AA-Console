import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "../lib/media";

const { tables } = vi.hoisted(() => ({ tables: new Map<string, unknown>() }));

// The modal reads six tables in three different query shapes. Keying the
// fake on the table name keeps each test's fixture readable.
vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const result = () => Promise.resolve(tables.get(table) ?? { data: null });
      return {
        select: () => ({
          eq: () => ({ maybeSingle: result, order: () => Promise.resolve(tables.get(table) ?? { data: [] }) }),
          in: () => Promise.resolve(tables.get(table) ?? { data: [] }),
        }),
      };
    },
  },
}));

import { MediaDetailModal } from "./MediaDetailModal";

function asset(over: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "asset-1",
    client_id: "client-1",
    brief_id: "brief-1",
    ref_number: "AS-009",
    media_type: "image",
    title: "Whitening hero",
    storage_path: "client-1/media/a.png",
    review_status: "approved",
    member_id: null,
    created_at: "2026-09-05T10:00:00Z",
    ...over,
  };
}

function show(props: Partial<Parameters<typeof MediaDetailModal>[0]> = {}) {
  const onClose = props.onClose ?? vi.fn();
  const result = render(
    <MediaDetailModal
      asset={asset()}
      url="https://signed/a.png"
      open
      onClose={onClose}
      {...props}
    />,
  );
  return { ...result, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  tables.clear();
  tables.set("client_briefs", { data: { title: "Spring whitening", brief_ref: "BR-004" } });
  tables.set("creative_renders", { data: null });
  tables.set("client_asset_reviews", { data: [] });
});

describe("MediaDetailModal — visibility", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <MediaDetailModal asset={asset()} open={false} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without an asset", () => {
    const { container } = render(<MediaDetailModal asset={null} open onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = show();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on the backdrop", async () => {
    const user = userEvent.setup();
    const { onClose } = show();
    await user.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("MediaDetailModal — the preview", () => {
  it("shows an image at full size", () => {
    show();
    expect(screen.getByRole("img", { name: "Whitening hero" })).toHaveAttribute(
      "src",
      "https://signed/a.png",
    );
  });

  it("shows a video with controls rather than a broken image", () => {
    const { container } = show({ asset: asset({ media_type: "video" }) });
    const video = container.querySelector("video");
    expect(video).toHaveAttribute("src", "https://signed/a.png");
    expect(video).toHaveAttribute("controls");
  });

  it("shows the copy for a text asset", () => {
    show({ asset: asset({ media_type: "text" }), url: undefined, body: "Book before April." });
    expect(screen.getByText("Book before April.")).toBeInTheDocument();
  });

  it("says so when the copy is missing rather than showing a blank panel", () => {
    show({ asset: asset({ media_type: "text" }), url: undefined, body: null });
    expect(screen.getByText(/copy could not be loaded/i)).toBeInTheDocument();
  });

  // The bucket is private: a missing signed URL is a normal state, not a bug.
  it("says the preview is unavailable when there is no signed url", () => {
    show({ url: undefined });
    expect(screen.getByText("Preview unavailable.")).toBeInTheDocument();
  });

  it("offers the full file only when there is a url to open", () => {
    show();
    expect(screen.getByRole("link", { name: /Open the full file/ })).toHaveAttribute(
      "href",
      "https://signed/a.png",
    );
  });

  it("offers no file link without a url", () => {
    show({ url: undefined });
    expect(screen.queryByRole("link", { name: /Open the full file/ })).not.toBeInTheDocument();
  });
});

describe("MediaDetailModal — provenance", () => {
  it("traces the asset back to its brief", async () => {
    show();
    expect(await screen.findByText("BR-004 — Spring whitening")).toBeInTheDocument();
  });

  // An agent's asset and an editor's upload look identical in the grid and
  // are not the same thing at all.
  it("marks a generated asset as generated and credits both models", async () => {
    tables.set("creative_renders", {
      data: { quality: "high", model: "gpt-image-2", generation_id: "gen-1" },
    });
    tables.set("creative_generations", { data: { concept_model: "gpt-5.6-sol" } });
    show();
    expect(await screen.findByText("Generated")).toBeInTheDocument();
    expect(
      screen.getByText(/Written by gpt-5.6-sol, rendered by gpt-image-2/),
    ).toBeInTheDocument();
  });

  it("never attributes a generated asset to a person", async () => {
    tables.set("creative_renders", {
      data: { quality: "high", model: "gpt-image-2", generation_id: "gen-1" },
    });
    tables.set("creative_generations", { data: { concept_model: "gpt-5.6-sol" } });
    tables.set("team_members", { data: { name: "Erin Editor" } });
    show({ asset: asset({ member_id: "ed-1" }) });
    await screen.findByText("Generated");
    expect(screen.queryByText("Made by")).not.toBeInTheDocument();
    expect(screen.queryByText("Erin Editor")).not.toBeInTheDocument();
  });

  it("credits the person who made an uploaded asset", async () => {
    tables.set("team_members", { data: { name: "Erin Editor" } });
    show({ asset: asset({ member_id: "ed-1" }) });
    // Named twice on purpose: the header badge and the "Made by" row.
    await waitFor(() => expect(screen.getAllByText("Erin Editor")).toHaveLength(2));
    expect(screen.getByText("Made by")).toBeInTheDocument();
    expect(screen.queryByText("Generated")).not.toBeInTheDocument();
  });

  it("omits rows it has nothing for instead of printing dashes", async () => {
    tables.set("client_briefs", { data: null });
    show({ asset: asset({ brief_id: null, ref_number: null }) });
    await waitFor(() => expect(screen.queryByText("From brief")).not.toBeInTheDocument());
    expect(screen.queryByText("Reference")).not.toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
  });
});

describe("MediaDetailModal — decisions", () => {
  // The audit-trail gap: reviews were written since the beginning and shown
  // nowhere, so "rejected" arrived without the reason attached.
  it("shows the rejection reason, not just the decision", async () => {
    tables.set("client_asset_reviews", {
      data: [
        {
          id: "rev-1",
          decision: "rejected",
          reason: "The logo is cropped on the right edge.",
          created_at: "2026-09-05T12:00:00Z",
          reviewed_by: "user-1",
        },
      ],
    });
    tables.set("profiles", { data: [{ id: "user-1", full_name: "Alex Thomas" }] });
    show();
    expect(await screen.findByText("The logo is cropped on the right edge.")).toBeInTheDocument();
    expect(screen.getByText(/Alex Thomas/)).toBeInTheDocument();
  });

  it("shows every decision, not only the latest", async () => {
    tables.set("client_asset_reviews", {
      data: [
        { id: "rev-2", decision: "approved", reason: null, created_at: "2026-09-05T13:00:00Z", reviewed_by: null },
        { id: "rev-1", decision: "rejected", reason: "Too dark", created_at: "2026-09-05T12:00:00Z", reviewed_by: null },
      ],
    });
    show();
    expect(await screen.findByText("Too dark")).toBeInTheDocument();
    // Scoped to the decision list: the header badge also reads "approved",
    // because that is the asset's current review status.
    const decisions = within(screen.getByRole("list"));
    expect(decisions.getByText("approved")).toBeInTheDocument();
    expect(decisions.getByText("rejected")).toBeInTheDocument();
  });

  it("does not invent a reviewer it cannot name", async () => {
    tables.set("client_asset_reviews", {
      data: [
        { id: "rev-1", decision: "approved", reason: null, created_at: "2026-09-05T12:00:00Z", reviewed_by: null },
      ],
    });
    show();
    expect(await screen.findByText(/Someone/)).toBeInTheDocument();
  });

  it("shows no decisions section when nothing has been decided", async () => {
    show();
    await screen.findByText("BR-004 — Spring whitening");
    expect(screen.queryByText("Decisions")).not.toBeInTheDocument();
  });
});
