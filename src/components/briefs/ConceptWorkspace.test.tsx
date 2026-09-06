import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, tables, signPaths, reads } = vi.hoisted(() => ({
  rpc: vi.fn(),
  tables: new Map<string, unknown>(),
  signPaths: vi.fn(),
  // How many table reads have actually resolved. The component issues one
  // query for renders and two more only if a render produced an asset, so
  // a fixed wait on the asset path hangs forever for a failed render.
  reads: { done: 0 },
}));

// One fake standing in for three different query shapes: renders are read
// with .eq().order(), assets and posts with .in(). Keying on the table name
// keeps the test honest about which read it is stubbing.
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const result = () =>
        Promise.resolve(tables.get(table) ?? { data: [] }).then((r) => {
          reads.done += 1;
          return r;
        });
      return { select: () => ({ eq: () => ({ order: result }), in: result }) };
    },
    rpc,
  },
}));

vi.mock("../../lib/media", () => ({ signPaths }));

import { ConceptWorkspace, type Generation } from "./ConceptWorkspace";

const CONCEPT = {
  headline: "Straighter teeth by summer",
  subhead: "Free consultation this month",
  subject: "A patient mid-laugh in a bright clinic",
  avoid: "No stock-photo dentistry",
  rationale: "Leads with the outcome, not the practice",
};

function generation(over: Partial<Generation> = {}): Generation {
  return {
    id: "gen-1",
    stage: "rendered",
    concept: CONCEPT,
    quality: "medium",
    size: "1024x1536",
    reference_path: null,
    concept_model: "gpt-5.6-sol",
    image_model: "gpt-image-2",
    concept_edited_at: null,
    cost_usd: 0.115,
    error: null,
    created_at: "2026-09-05T10:00:00Z",
    media_type: "image",
    ...over,
  };
}

type Render = {
  id: string;
  status: string;
  quality: string;
  size: string;
  asset_id: string | null;
  cost_usd: number | null;
  error: string | null;
  selected: boolean;
  created_at: string;
};

function renderRow(over: Partial<Render> = {}): Render {
  return {
    id: "r-1",
    status: "done",
    quality: "medium",
    size: "1024x1536",
    asset_id: "asset-1",
    cost_usd: 0.045,
    error: null,
    selected: false,
    created_at: "2026-09-05T10:01:00Z",
    ...over,
  };
}

function setData(opts: {
  renders?: Render[];
  review?: "pending" | "approved" | "rejected";
  scheduled?: { asset_id: string; scheduled_for: string; channel: string }[];
}) {
  tables.set("creative_renders", { data: opts.renders ?? [] });
  tables.set("client_media_assets", {
    data: [
      {
        id: "asset-1",
        storage_path: "client-1/media/a.png",
        review_status: opts.review ?? "pending",
        ref_number: "AS-009",
      },
    ],
  });
  tables.set("scheduled_posts", { data: opts.scheduled ?? [] });
}

async function show(gen: Partial<Generation> = {}, onChanged = vi.fn()) {
  // Three reads when a render has an asset to look up, one when it does not.
  const expected =
    (tables.get("creative_renders") as { data: Render[] }).data.some((r) => r.asset_id) ? 3 : 1;
  reads.done = 0;
  const result = render(<ConceptWorkspace generation={generation(gen)} onChanged={onChanged} />);
  await waitFor(() => expect(reads.done).toBe(expected));
  return { ...result, onChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
  tables.clear();
  rpc.mockResolvedValue({ error: null });
  signPaths.mockResolvedValue(new Map([["client-1/media/a.png", "https://signed/a.png"]]));
  setData({ renders: [renderRow()] });
});

describe("ConceptWorkspace — the concept", () => {
  it("labels the concept fields rather than showing raw keys", async () => {
    await show();
    expect(screen.getByText("Headline")).toBeInTheDocument();
    expect(screen.getByText("Do not include")).toBeInTheDocument();
    expect(screen.getByText("Straighter teeth by summer")).toBeInTheDocument();
  });

  it("omits fields the concept does not carry", async () => {
    await show({ concept: { headline: "Only this" } });
    expect(screen.queryByText("Call to action")).not.toBeInTheDocument();
  });

  it("says a failed build wrote no concept instead of showing an empty list", async () => {
    await show({ concept: null });
    expect(screen.getByText(/No concept was written/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
  });

  it("marks a concept that a person changed", async () => {
    await show({ concept_edited_at: "2026-09-05T11:00:00Z" });
    expect(screen.getByText("edited by hand")).toBeInTheDocument();
  });

  it("credits both models", async () => {
    await show();
    expect(screen.getByText(/Concept by gpt-5.6-sol, rendered by gpt-image-2/)).toBeInTheDocument();
  });
});

describe("ConceptWorkspace — editing the concept", () => {
  it("keeps the fields it was not asked to change", async () => {
    const user = userEvent.setup();
    const { onChanged } = await show();
    await user.click(screen.getByRole("button", { name: /Edit/ }));

    const headline = screen.getByDisplayValue("Straighter teeth by summer");
    await user.clear(headline);
    await user.type(headline, "Book before April");
    await user.click(screen.getByRole("button", { name: /Save concept/ }));

    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith("update_generation_concept", {
      p_generation_id: "gen-1",
      p_concept: { ...CONCEPT, headline: "Book before April" },
    });
    expect(onChanged).toHaveBeenCalled();
  });

  // The whole point of splitting the concept from its renders: an edit is
  // free until you ask for an image.
  it("does not spend anything on save", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    await user.click(screen.getByRole("button", { name: /Save concept/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain("rerender_generation");
  });

  it("keeps the editor open and reports why a save failed", async () => {
    rpc.mockResolvedValue({ error: { message: "concept must be an object" } });
    const user = userEvent.setup();
    const { onChanged } = await show();
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    await user.click(screen.getByRole("button", { name: /Save concept/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("concept must be an object"));
    expect(screen.getByRole("button", { name: /Save concept/ })).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("discards the draft on cancel", async () => {
    const user = userEvent.setup();
    await show();
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    await user.clear(screen.getByDisplayValue("Straighter teeth by summer"));
    await user.click(screen.getByRole("button", { name: /Cancel/ }));

    expect(screen.getByText("Straighter teeth by summer")).toBeInTheDocument();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("ConceptWorkspace — renders", () => {
  it("totals what the renders have cost", async () => {
    setData({ renders: [renderRow({ id: "r-1", cost_usd: 0.045 }), renderRow({ id: "r-2", cost_usd: 0.165 })] });
    await show();
    expect(screen.getByText(/\$0\.210 total/)).toBeInTheDocument();
  });

  it("re-renders at the quality chosen, not the one the build used", async () => {
    const user = userEvent.setup();
    await show();
    await user.selectOptions(screen.getByRole("combobox"), "high");
    await user.click(screen.getByRole("button", { name: /Render again/ }));

    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith("rerender_generation", {
      p_generation_id: "gen-1",
      p_quality: "high",
    });
  });

  it("offers no selection for a render that failed", async () => {
    setData({ renders: [renderRow({ status: "failed", asset_id: null, error: "Content policy" })] });
    await show();
    expect(screen.queryByRole("button", { name: /^Select$/ })).not.toBeInTheDocument();
    expect(screen.getByText("Content policy")).toBeInTheDocument();
  });

  it("selects a render by id", async () => {
    const user = userEvent.setup();
    setData({ renders: [renderRow({ id: "r-2" })] });
    await show();
    await user.click(screen.getByRole("button", { name: /^Select$/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("select_render", { p_render_id: "r-2" }));
  });

  it("shows no render machinery for a text generation", async () => {
    await show({ media_type: "text" });
    expect(screen.queryByRole("button", { name: /Render again/ })).not.toBeInTheDocument();
  });
});

describe("ConceptWorkspace — approve and schedule", () => {
  it("asks for a selection before offering the next step", async () => {
    setData({ renders: [renderRow({ selected: false })] });
    await show();
    expect(screen.getByText(/Select a render to approve and schedule it/i)).toBeInTheDocument();
  });

  it("offers approval, not scheduling, while the asset is unreviewed", async () => {
    setData({ renders: [renderRow({ selected: true })], review: "pending" });
    await show();
    expect(screen.getByRole("button", { name: /Approve/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Schedule$/ })).not.toBeInTheDocument();
  });

  it("approves the selected asset", async () => {
    const user = userEvent.setup();
    setData({ renders: [renderRow({ selected: true })], review: "pending" });
    await show();
    await user.click(screen.getByRole("button", { name: /Approve/ }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("review_media_asset", {
        p_asset_id: "asset-1",
        p_decision: "approved",
      }),
    );
  });

  it("will not book a date it was not given", async () => {
    const user = userEvent.setup();
    setData({ renders: [renderRow({ selected: true })], review: "approved" });
    await show();
    await user.click(screen.getByRole("button", { name: /^Schedule$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a date first.");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("books the approved asset on the date and channel given", async () => {
    const user = userEvent.setup();
    setData({ renders: [renderRow({ selected: true })], review: "approved" });
    const { onChanged } = await show();
    await user.type(screen.getByDisplayValue(""), "2026-10-01");
    await user.selectOptions(screen.getByDisplayValue("Organic"), "paid");
    await user.click(screen.getByRole("button", { name: /^Schedule$/ }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("schedule_asset", {
        p_asset_id: "asset-1",
        p_date: "2026-10-01",
        p_channel: "paid",
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  // The action bar offers the next step, not one already taken.
  it("reports a booking instead of offering to make it again", async () => {
    setData({
      renders: [renderRow({ selected: true })],
      review: "approved",
      scheduled: [{ asset_id: "asset-1", scheduled_for: "2026-10-01", channel: "organic" }],
    });
    await show();
    expect(screen.getByText(/Scheduled for/)).toBeInTheDocument();
    expect(screen.getByText("2026-10-01")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Schedule$/ })).not.toBeInTheDocument();
  });

  it("sends a rejected render back to the concept rather than to the calendar", async () => {
    setData({ renders: [renderRow({ selected: true })], review: "rejected" });
    await show();
    expect(screen.getByText(/rejected\. Edit the concept and render again/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });
});
