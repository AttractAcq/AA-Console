import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/supabase builds a real client at import time, so the fake has to be
// hoisted above the component import — the same shape lib/media.test.ts uses.
const { rpc, order, upload, createSignedUrl, useParams } = vi.hoisted(() => ({
  rpc: vi.fn(),
  order: vi.fn(),
  upload: vi.fn(),
  createSignedUrl: vi.fn(),
  useParams: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: () => ({ select: () => ({ in: () => ({ eq: () => ({ order }) }) }) }),
    rpc,
    storage: { from: () => ({ upload, createSignedUrl }) },
  },
}));

vi.mock("react-router-dom", () => ({ useParams }));

import { ApproveAndBuildModal } from "./ApproveAndBuildModal";

const MEMBERS = [
  { id: "ed-1", name: "Erin Editor", category: "editors" },
  { id: "ed-2", name: "Eli Editor", category: "editors" },
  { id: "av-1", name: "Ava Avatar", category: "avatars" },
];

type BriefArg = Parameters<typeof ApproveAndBuildModal>[0]["brief"];

function brief(over: Partial<NonNullable<BriefArg>> = {}): NonNullable<BriefArg> {
  return {
    id: "brief-1",
    title: "Spring whitening offer",
    body: "Lead with the guarantee.",
    media_type: "image",
    brief_ref: "BR-004",
    status: "approved",
    ...over,
  };
}

function show(over: Partial<NonNullable<BriefArg>> = {}, onDone = vi.fn(), onClose = vi.fn()) {
  const result = render(
    <ApproveAndBuildModal brief={brief(over)} open onClose={onClose} onDone={onDone} />,
  );
  return { ...result, onDone, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  order.mockResolvedValue({ data: MEMBERS });
  rpc.mockResolvedValue({ error: null });
});

describe("ApproveAndBuildModal — routing", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ApproveAndBuildModal brief={brief()} open={false} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the brief body, so nobody builds from a title alone", () => {
    show();
    expect(screen.getByText("Lead with the guarantee.")).toBeInTheDocument();
  });

  it("starts with no route chosen, so neither is submitted by accident", () => {
    show();
    expect(screen.getByRole("button", { name: /^Generate$/ })).toBeDisabled();
  });

  // The rule the whole modal exists to enforce: AI makes text and images.
  // Video is made by people.
  it("never offers the AI route for video", () => {
    show({ media_type: "video" });
    expect(screen.getByRole("button", { name: /AI/ })).toBeDisabled();
    expect(screen.getByText(/video is made by people/i)).toBeInTheDocument();
  });

  it("preselects the human route for video rather than leaving it unset", () => {
    show({ media_type: "video" });
    expect(screen.getByRole("heading", { name: /Send to/i })).toBeInTheDocument();
  });

  it("cannot be talked into an AI build for video by clicking the disabled card", async () => {
    const user = userEvent.setup();
    show({ media_type: "video" });
    await user.click(screen.getByRole("button", { name: /AI/ }));
    expect(screen.queryByRole("heading", { name: /^Quality$/i })).not.toBeInTheDocument();
  });
});

describe("ApproveAndBuildModal — the AI route", () => {
  it("sends the brief, quality and shape that were chosen", async () => {
    const user = userEvent.setup();
    const { onDone, onClose } = show();
    await user.click(screen.getByRole("button", { name: /AI/ }));
    await user.click(screen.getByRole("button", { name: /High/ }));
    await user.click(screen.getByRole("button", { name: /Landscape/ }));
    await user.click(screen.getByRole("button", { name: /^Generate$/ }));

    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith("build_brief_with_ai", {
      p_brief_id: "brief-1",
      p_quality: "high",
      p_size: "1536x1024",
      p_reference_path: undefined,
    });
    expect(onDone).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("offers no shape or reference image for a text brief, and sends the default size", async () => {
    const user = userEvent.setup();
    show({ media_type: "text" });
    await user.click(screen.getByRole("button", { name: /AI/ }));
    expect(screen.queryByRole("heading", { name: /^Shape$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Start from an image/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Generate$/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_size: "1024x1536" });
  });

  it("passes the uploaded reference through to the build", async () => {
    upload.mockResolvedValue({ error: null });
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://signed/ref.png" } });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /AI/ }));

    const file = new File(["x"], "product.png", { type: "image/png" });
    await user.upload(screen.getByLabelText(/Upload a product shot/i), file);
    await waitFor(() => expect(screen.getByText("product.png")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^Generate$/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    const path = rpc.mock.calls[0][1].p_reference_path as string;
    // Storage RLS is written against the path prefix, so the client id has
    // to be the first segment or the upload is rejected at the policy.
    expect(path.startsWith("client-1/references/")).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
  });

  it("surfaces an upload failure instead of building from a reference that is not there", async () => {
    upload.mockResolvedValue({ error: { message: "Storage quota exceeded" } });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /AI/ }));
    await user.upload(
      screen.getByLabelText(/Upload a product shot/i),
      new File(["x"], "product.png", { type: "image/png" }),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Storage quota exceeded"));
    expect(screen.queryByText("product.png")).not.toBeInTheDocument();
  });

  it("lets a reference be removed again", async () => {
    upload.mockResolvedValue({ error: null });
    createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://signed/ref.png" } });
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /AI/ }));
    await user.upload(
      screen.getByLabelText(/Upload a product shot/i),
      new File(["x"], "product.png", { type: "image/png" }),
    );
    await waitFor(() => expect(screen.getByText("product.png")).toBeInTheDocument());

    await user.click(screen.getByLabelText("Remove reference image"));
    await user.click(screen.getByRole("button", { name: /^Generate$/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc.mock.calls[0][1].p_reference_path).toBeUndefined();
  });

  it("reports a failed build and neither closes nor claims success", async () => {
    rpc.mockResolvedValue({ error: { message: "No image renderer is configured." } });
    const user = userEvent.setup();
    const { onDone, onClose } = show();
    await user.click(screen.getByRole("button", { name: /AI/ }));
    await user.click(screen.getByRole("button", { name: /^Generate$/ }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("No image renderer is configured."),
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ApproveAndBuildModal — the human route", () => {
  async function pickHuman() {
    const user = userEvent.setup();
    const ctx = show();
    await user.click(screen.getByRole("button", { name: /Human/ }));
    return { user, ...ctx };
  }

  it("will not dispatch to nobody", async () => {
    const { user } = await pickHuman();
    expect(screen.getByRole("button", { name: /Send to/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /editors/i }));
    // A category on its own is still nobody.
    expect(screen.getByRole("button", { name: /Send to/ })).toBeDisabled();
  });

  it("shows only the categories that were turned on", async () => {
    const { user } = await pickHuman();
    await user.click(screen.getByRole("button", { name: /editors/i }));
    expect(screen.getByText("Erin Editor")).toBeInTheDocument();
    expect(screen.queryByText("Ava Avatar")).not.toBeInTheDocument();
  });

  it("dispatches the people actually ticked, with the due date and fee", async () => {
    const { user, onDone } = await pickHuman();
    await user.click(screen.getByRole("button", { name: /editors/i }));
    await user.click(screen.getByLabelText(/Erin Editor/));
    await user.type(screen.getByLabelText(/Due date/i), "2026-09-30");
    await user.type(screen.getByLabelText(/Compensation/i), "120.50");
    await user.click(screen.getByRole("button", { name: /Send to 1/ }));

    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith("dispatch_brief_to_members", {
      p_brief_id: "brief-1",
      p_member_ids: ["ed-1"],
      p_due_date: "2026-09-30",
      p_compensation: 120.5,
    });
    expect(onDone).toHaveBeenCalled();
  });

  // The RPC defaults both, so an omitted value has to be undefined rather
  // than null or the generated types reject the call.
  it("omits an unset due date and fee rather than sending empties", async () => {
    const { user } = await pickHuman();
    await user.click(screen.getByRole("button", { name: /editors/i }));
    await user.click(screen.getByLabelText(/Erin Editor/));
    await user.click(screen.getByRole("button", { name: /Send to 1/ }));

    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_due_date: undefined,
      p_compensation: undefined,
    });
  });

  // Otherwise the selection contains someone the operator can no longer
  // see, and the brief goes to a person they think they deselected.
  it("drops people whose category is switched back off", async () => {
    const { user } = await pickHuman();
    await user.click(screen.getByRole("button", { name: /editors/i }));
    await user.click(screen.getByRole("button", { name: /avatars/i }));
    await user.click(screen.getByLabelText(/Erin Editor/));
    await user.click(screen.getByLabelText(/Ava Avatar/));
    expect(screen.getByRole("button", { name: /Send to 2/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /editors/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Send to 1/ })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /Send to 1/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc.mock.calls[0][1].p_member_ids).toEqual(["av-1"]);
  });

  it("says so when a group has nobody active in it", async () => {
    order.mockResolvedValue({ data: [] });
    const { user } = await pickHuman();
    await user.click(screen.getByRole("button", { name: /editors/i }));
    expect(screen.getByText(/No active people in that group/i)).toBeInTheDocument();
  });
});

describe("ApproveAndBuildModal — reopening", () => {
  // A modal that remembers the last brief's choices is how the wrong
  // person gets sent the wrong work.
  it("forgets the previous brief's selection", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ApproveAndBuildModal brief={brief()} open onClose={vi.fn()} onDone={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /Human/ }));
    await user.click(screen.getByRole("button", { name: /editors/i }));
    await user.click(screen.getByLabelText(/Erin Editor/));
    expect(screen.getByRole("button", { name: /Send to 1/ })).toBeInTheDocument();

    rerender(
      <ApproveAndBuildModal
        brief={brief({ id: "brief-2", title: "Different brief" })}
        open
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^Generate$/ })).toBeDisabled();
    expect(screen.queryByText("Erin Editor")).not.toBeInTheDocument();
  });

  it("resets the quality a previous build had raised", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ApproveAndBuildModal brief={brief()} open onClose={vi.fn()} onDone={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /AI/ }));
    await user.click(screen.getByRole("button", { name: /High/ }));

    rerender(
      <ApproveAndBuildModal brief={brief({ id: "brief-2" })} open onClose={vi.fn()} onDone={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /AI/ }));
    await user.click(screen.getByRole("button", { name: /^Generate$/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_quality: "medium" });
  });
});
