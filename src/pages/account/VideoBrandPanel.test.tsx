import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { maybeSingle, upsert } = vi.hoisted(() => ({ maybeSingle: vi.fn(), upsert: vi.fn() }));
vi.mock("../../lib/supabase", () => ({
  supabase: { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle }) }), upsert,
  }) },
}));

import { VideoBrandPanel } from "./VideoBrandPanel";

beforeEach(() => {
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({ data: null, error: null });
  upsert.mockResolvedValue({ error: null });
});

describe("Video brand settings", () => {
  it("shows the recorded AA palette and a readable caption contrast", async () => {
    render(<VideoBrandPanel clientId="client-1" />);
    expect(await screen.findByText(/primary: #142B23/)).toBeInTheDocument();
    expect(screen.getByText(/Caption contrast:/)).toBeInTheDocument();
  });

  it("rejects unknown or invalid override values before saving", async () => {
    const user = userEvent.setup();
    render(<VideoBrandPanel clientId="client-1" />);
    await user.click(await screen.findByRole("button", { name: "Edit video brand" }));
    const editor = screen.getByRole("textbox", { name: /Video token overrides/ });
    fireEvent.change(editor, { target: { value: '{"colours":{"primary":"blue"}}' } });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Invalid video tokens at colours.primary/)).toBeInTheDocument();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("saves only validated overrides and the narrator selection", async () => {
    const user = userEvent.setup();
    render(<VideoBrandPanel clientId="client-1" />);
    await user.click(await screen.findByRole("button", { name: "Edit video brand" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Video token overrides/ }),
      { target: { value: '{"colours":{"primary":"#123456"}}' } });
    await user.type(screen.getByRole("textbox", { name: /Narrator voice ID/ }), "voice-1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(upsert).toHaveBeenCalledWith({
      client_id: "client-1", video_tokens: { colours: { primary: "#123456" } },
      narrator_voice_id: "voice-1", video_rulebook_notes: null,
    }, { onConflict: "client_id" }));
  });
});
