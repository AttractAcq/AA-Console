import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PostCopyEditor } from "./PostCopyEditor";
import { formatHashtags, parseHashtags } from "../lib/postCopy";

const rpc = vi.fn();
const eq = vi.fn();
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

vi.mock("../lib/supabase", () => ({ supabase: { from: (...a: unknown[]) => from(...(a as [])), rpc: (...a: unknown[]) => rpc(...(a as [])) } }));

beforeEach(() => {
  vi.clearAllMocks();
  eq.mockResolvedValue({ data: [], error: null });
  rpc.mockResolvedValue({ error: null });
});

const open = () => render(<PostCopyEditor open onClose={() => {}} scheduledPostId="sp1" title="The Chain" />);

describe("parseHashtags", () => {
  it("splits on spaces and commas and keeps the hash optional", () => {
    expect(parseHashtags(" #agency, content  #chain ")).toEqual(["#agency", "content", "#chain"]);
    expect(parseHashtags("")).toEqual([]);
  });

  it("round-trips what it formatted", () => {
    expect(parseHashtags(formatHashtags(["#a", "#b"]))).toEqual(["#a", "#b"]);
  });
});

describe("the copy editor", () => {
  it("writes the caption for the platform that is selected", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Caption"), "Five steps, one chain.");
    await userEvent.click(screen.getByRole("button", { name: /Save Instagram copy/ }));

    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "set_post_copy",
        expect.objectContaining({
          p_platform: "instagram",
          p_scheduled_post_id: "sp1",
          p_caption: "Five steps, one chain.",
        }),
      ),
    );
  });

  it("writes against the asset when there is no slot", async () => {
    render(<PostCopyEditor open onClose={() => {}} assetId="a1" />);
    await userEvent.type(screen.getByLabelText("Caption"), "Draft");
    await userEvent.click(screen.getByRole("button", { name: /Save Instagram copy/ }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "set_post_copy",
        expect.objectContaining({ p_asset_id: "a1", p_scheduled_post_id: undefined }),
      ),
    );
  });

  it("sends hashtags as an array, not the text that was typed", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Hashtags"), "#agency content");
    await userEvent.click(screen.getByRole("button", { name: /Save Instagram copy/ }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith(
        "set_post_copy",
        expect.objectContaining({ p_hashtags: ["#agency", "content"] }),
      ),
    );
  });

  it("counts down and will not save a caption the platform would refuse", async () => {
    open();
    const caption = screen.getByLabelText("Caption");
    // Instagram takes 2200. fireEvent-style set, because typing 2201 characters
    // one keystroke at a time is not worth the seconds.
    await userEvent.click(caption);
    await userEvent.paste("x".repeat(2201));

    expect(await screen.findByText(/1 over the Instagram limit/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Instagram copy/ })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("explains a link that would not be clickable rather than just refusing", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Link"), "https://attractacq.com");
    expect(await screen.findByText(/not clickable/)).toBeInTheDocument();

    // The same link is fine on LinkedIn, and the warning goes.
    await userEvent.click(screen.getByRole("tab", { name: /LinkedIn/ }));
    await waitFor(() => expect(screen.queryByText(/not clickable/)).not.toBeInTheDocument());
  });

  it("swaps the draft when the platform changes, instead of carrying it over", async () => {
    eq.mockResolvedValue({
      data: [
        { platform: "instagram", caption: "IG words", hashtags: [], alt_text: null, link_url: null, first_comment: null },
        { platform: "linkedin", caption: "LI words", hashtags: [], alt_text: null, link_url: null, first_comment: null },
      ],
      error: null,
    });
    open();
    expect(await screen.findByDisplayValue("IG words")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /LinkedIn/ }));
    expect(await screen.findByDisplayValue("LI words")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("IG words")).not.toBeInTheDocument();
  });

  it("marks which platforms already have copy", async () => {
    eq.mockResolvedValue({
      data: [{ platform: "linkedin", caption: "LI", hashtags: [], alt_text: null, link_url: null, first_comment: null }],
      error: null,
    });
    open();
    const linkedin = await screen.findByRole("tab", { name: /LinkedIn/ });
    expect(within(linkedin).getByLabelText("has copy")).toBeInTheDocument();
    expect(within(screen.getByRole("tab", { name: /TikTok/ })).queryByLabelText("has copy")).toBeNull();
  });

  it("surfaces a refusal from the database rather than looking saved", async () => {
    rpc.mockResolvedValue({ error: { message: "Not permitted for this client" } });
    open();
    await userEvent.type(screen.getByLabelText("Caption"), "Words");
    await userEvent.click(screen.getByRole("button", { name: /Save Instagram copy/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Not permitted/);
  });
});
