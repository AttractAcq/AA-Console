import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { maybeSingle, upsert, useParams } = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  upsert: vi.fn(),
  useParams: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }), upsert }),
  },
}));
vi.mock("react-router-dom", () => ({ useParams }));

import { BrandPanel } from "./BrandPanel";

const FULL = {
  client_id: "client-1",
  colour_primary: "#0064EB",
  colour_secondary: "#0A2540",
  colour_accent: "#FF8800",
  colour_background: null,
  colour_text: null,
  font_heading: "Inter",
  font_body: "Inter",
  imagery_style: "Documentary photography",
  lighting: "Natural window light",
  mood: null,
  composition_notes: null,
  never_do: "No stock handshakes",
  custom_css: null,
};

function show(row: Record<string, unknown> | null = FULL) {
  maybeSingle.mockResolvedValue({ data: row });
  return render(<BrandPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  upsert.mockResolvedValue({ error: null });
});

describe("BrandPanel — what a build will actually use", () => {
  it("counts the palette rather than just saying it exists", async () => {
    show();
    expect(await screen.findByText(/3\/5 colours set/)).toBeInTheDocument();
  });

  // The consequence, in the client's terms, not a generic "incomplete".
  it("says plainly when nothing is on file", async () => {
    show(null);
    expect(await screen.findByText(/every build invents its own look/i)).toBeInTheDocument();
  });

  // A blank colour is the reason the next asset picks its own, so it is shown.
  it("shows unset colours instead of hiding them", async () => {
    show();
    await screen.findByText(/3\/5 colours set/);
    expect(screen.getByText("Background")).toBeInTheDocument();
    expect(screen.getAllByText(/Not set —/).length).toBe(2);
  });

  it("shows the hex so it can be checked against a brand guide", async () => {
    show();
    expect(await screen.findByText("#0064EB")).toBeInTheDocument();
  });

  it("shows the brand's own bans and where they are applied", async () => {
    show();
    expect(await screen.findByText("No stock handshakes")).toBeInTheDocument();
    expect(screen.getByText(/concept and the render/i)).toBeInTheDocument();
  });

  // Saying so beats implying it works.
  it("states that the CSS is stored but unused", async () => {
    show();
    expect(await screen.findByText(/Nothing consumes it today/i)).toBeInTheDocument();
  });
});

describe("BrandPanel — saving", () => {
  async function openEditor() {
    const user = userEvent.setup();
    show(FULL);
    await screen.findByText(/3\/5 colours set/);
    await user.click(screen.getByRole("button", { name: /Edit brand/ }));
    return user;
  }

  // The database has a check constraint; this makes the failure a sentence
  // rather than a raw constraint violation.
  it("refuses a colour that is not six-digit hex, before it reaches the database", async () => {
    const user = await openEditor();
    const primary = await screen.findByDisplayValue("#0064EB");
    await user.clear(primary);
    await user.type(primary, "blue");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(await screen.findByText(/must be a six-digit hex colour/i)).toBeInTheDocument();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("saves a valid palette, writing blanks as null rather than empty strings", async () => {
    const user = await openEditor();
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(upsert).toHaveBeenCalledOnce());
    const [payload, opts] = upsert.mock.calls[0];
    expect(opts).toEqual({ onConflict: "client_id" });
    expect(payload).toMatchObject({
      client_id: "client-1",
      colour_primary: "#0064EB",
      colour_background: null,
      mood: null,
    });
  });
});
