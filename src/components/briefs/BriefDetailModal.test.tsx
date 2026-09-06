import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tables, signPaths, rpc } = vi.hoisted(() => ({
  tables: new Map<string, unknown>(),
  signPaths: vi.fn(),
  rpc: vi.fn(),
}));

// Expanding a build mounts ConceptWorkspace, which reads three more tables,
// so this fake has to serve both components.
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const many = () => Promise.resolve(tables.get(table) ?? { data: [] });
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve(tables.get(table) ?? { data: null }), order: many }),
          in: many,
        }),
      };
    },
    rpc,
  },
}));

vi.mock("../../lib/media", () => ({ signPaths }));

import { BriefDetailModal } from "./BriefDetailModal";

type BriefArg = NonNullable<Parameters<typeof BriefDetailModal>[0]["brief"]>;

function brief(over: Partial<BriefArg> = {}): BriefArg {
  return {
    id: "brief-1",
    client_id: "client-1",
    title: "Spring whitening offer",
    body: "**Hook:** lead with the guarantee.",
    media_type: "image",
    brief_ref: "BR-004",
    status: "in_production",
    source_idea_id: null,
    created_at: "2026-09-04T09:00:00Z",
    ...over,
  };
}

function show(over: Partial<BriefArg> = {}, onClose = vi.fn()) {
  const result = render(<BriefDetailModal brief={brief(over)} open onClose={onClose} />);
  return { ...result, onClose };
}

const GENERATION = {
  id: "gen-1",
  stage: "done",
  concept: { headline: "Straighter teeth by summer" },
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
};

beforeEach(() => {
  vi.clearAllMocks();
  tables.clear();
  rpc.mockResolvedValue({ error: null });
  signPaths.mockResolvedValue(new Map());
});

describe("BriefDetailModal — the brief", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<BriefDetailModal brief={brief()} open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without a brief", () => {
    const { container } = render(<BriefDetailModal brief={null} open onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("heads the modal with the reference, type and status", () => {
    show();
    expect(screen.getByRole("heading", { name: "Spring whitening offer" })).toBeInTheDocument();
    expect(screen.getByText(/BR-004/)).toBeInTheDocument();
    expect(screen.getByText("in production")).toBeInTheDocument();
  });

  // The body is the agent's own structured markdown. Dumping it as plain
  // text leaves ** on screen, which is what the Master AI chat did first.
  it("renders the brief markdown rather than showing its markers", () => {
    show();
    expect(screen.getByText("Hook:")).toBeInTheDocument();
    expect(screen.queryByText(/\*\*Hook/)).not.toBeInTheDocument();
  });

  it("says a brief has no detail rather than showing an empty box", () => {
    show({ body: null });
    expect(screen.getByText(/no detail beyond its title/i)).toBeInTheDocument();
  });

  it("closes from the backdrop and the button", async () => {
    const user = userEvent.setup();
    const { onClose } = show();
    // Two ways out on purpose: the backdrop and the header button.
    const exits = screen.getAllByRole("button", { name: "Close" });
    expect(exits).toHaveLength(2);
    for (const exit of exits) await user.click(exit);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("BriefDetailModal — where it came from", () => {
  it("traces the brief back to the idea and the buyer question", async () => {
    tables.set("client_ideas", {
      data: {
        title: "Why whitening fades",
        body: null,
        source_question: "Will it last?",
        strategic_reason: "Handles the objection before the consult",
        content_territory: "Education",
        source: "ideation",
      },
    });
    show({ source_idea_id: "idea-1" });
    expect(await screen.findByText("Why whitening fades")).toBeInTheDocument();
    expect(screen.getByText("Will it last?")).toBeInTheDocument();
    expect(screen.getByText("Handles the objection before the consult")).toBeInTheDocument();
  });

  it("shows no provenance section for a brief with no source idea", async () => {
    show({ source_idea_id: null });
    await waitFor(() => expect(screen.queryByText("Loading history…")).not.toBeInTheDocument());
    expect(screen.queryByText("Where this came from")).not.toBeInTheDocument();
  });
});

describe("BriefDetailModal — build history", () => {
  it("says plainly when nothing has happened yet", async () => {
    show();
    expect(await screen.findByText(/Nothing has been built or sent/i)).toBeInTheDocument();
  });

  it("lists the builds with what each one cost", async () => {
    tables.set("creative_generations", { data: [GENERATION] });
    show();
    expect(await screen.findByText("Builds (1)")).toBeInTheDocument();
    expect(screen.getByText(/\$0\.115/)).toBeInTheDocument();
  });

  it("notes a build that started from a reference image", async () => {
    tables.set("creative_generations", {
      data: [{ ...GENERATION, reference_path: "client-1/references/x.png" }],
    });
    show();
    expect(await screen.findByText(/from a reference image/)).toBeInTheDocument();
  });

  it("shows why a build failed without opening it", async () => {
    tables.set("creative_generations", {
      data: [{ ...GENERATION, stage: "failed", error: "No image renderer is configured." }],
    });
    show();
    expect(await screen.findByText("No image renderer is configured.")).toBeInTheDocument();
  });

  // The concept is expensive and the list is a summary; the workspace only
  // mounts when asked for.
  it("keeps the concept collapsed until it is opened", async () => {
    tables.set("creative_generations", { data: [GENERATION] });
    show();
    await screen.findByText("Builds (1)");
    expect(screen.queryByText("Straighter teeth by summer")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Open/ }));
    expect(await screen.findByText("Straighter teeth by summer")).toBeInTheDocument();
  });

  it("collapses again on a second click", async () => {
    tables.set("creative_generations", { data: [GENERATION] });
    const user = userEvent.setup();
    show();
    await screen.findByText("Builds (1)");
    await user.click(screen.getByRole("button", { name: /Open/ }));
    await screen.findByText("Straighter teeth by summer");
    await user.click(screen.getByRole("button", { name: /Hide/ }));
    expect(screen.queryByText("Straighter teeth by summer")).not.toBeInTheDocument();
  });

  it("opens one build at a time", async () => {
    tables.set("creative_generations", {
      data: [GENERATION, { ...GENERATION, id: "gen-2", concept: { headline: "Second concept" } }],
    });
    const user = userEvent.setup();
    show();
    await screen.findByText("Builds (2)");
    await user.click(screen.getAllByRole("button", { name: /Open/ })[0]);
    await screen.findByText("Straighter teeth by summer");
    await user.click(screen.getByRole("button", { name: /Open/ }));
    expect(await screen.findByText("Second concept")).toBeInTheDocument();
    expect(screen.queryByText("Straighter teeth by summer")).not.toBeInTheDocument();
  });
});

describe("BriefDetailModal — who it was sent to", () => {
  function dispatch(over: Record<string, unknown> = {}) {
    return {
      id: "d-1",
      email_status: "sent",
      email_error: null,
      emailed_at: "2026-09-05T10:00:00Z",
      created_at: "2026-09-05T10:00:00Z",
      team_members: { name: "Erin Editor", category: "editors" },
      ...over,
    };
  }

  it("names the people the brief went to", async () => {
    tables.set("brief_dispatches", { data: [dispatch()] });
    show();
    expect(await screen.findByText(/Erin Editor/)).toBeInTheDocument();
    expect(screen.getByText("email sent")).toBeInTheDocument();
  });

  // A skipped email is a completed dispatch, not a failure: the assignment
  // is the work and the email is only the heads-up.
  it("reads a skipped email as configuration, not as failure", async () => {
    tables.set("brief_dispatches", { data: [dispatch({ email_status: "skipped" })] });
    show();
    expect(await screen.findByText("no email configured")).toBeInTheDocument();
    expect(screen.getByText(/on their dashboard either way/i)).toBeInTheDocument();
  });

  it("shows a failed email without hiding the assignment", async () => {
    tables.set("brief_dispatches", {
      data: [dispatch({ email_status: "failed", email_error: "Domain not verified" })],
    });
    show();
    expect(await screen.findByText("email failed")).toBeInTheDocument();
    expect(screen.getByText(/Erin Editor/)).toBeInTheDocument();
  });

  it("does not blank the row when the member record is gone", async () => {
    tables.set("brief_dispatches", { data: [dispatch({ team_members: null })] });
    show();
    expect(await screen.findByText(/Unknown/)).toBeInTheDocument();
  });
});
