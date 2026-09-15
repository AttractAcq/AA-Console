import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { insert } = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock("../../lib/supabase", () => ({
  supabase: { from: () => ({ insert }) },
}));

import { AttachAgentControl } from "./AttachAgentControl";
import type { ApprovableAgent, PublishablePage } from "../../pages/sites/readiness";

const PAGE: PublishablePage = {
  id: "page-1",
  title: "Winter Offer",
  html: "<html></html>",
  publish_status: "published",
  published_url: "https://attractacq.github.io/hd-site/winter-offer/",
  site_repository_id: "repo-1",
};

const ready = (over: Partial<ApprovableAgent> = {}): ApprovableAgent => ({
  id: "a1",
  name: "Consult Qualifier",
  status: "live",
  built_at: "2026-09-10T00:00:00Z",
  approved_at: "2026-09-11T00:00:00Z",
  ...over,
});

function show(
  over: {
    page?: PublishablePage;
    agents?: ApprovableAgent[];
    attachedAgentIds?: string[];
    onAttached?: () => void;
  } = {},
) {
  return render(
    <AttachAgentControl
      clientId="client-1"
      page={over.page ?? PAGE}
      agents={over.agents ?? [ready()]}
      attachedAgentIds={over.attachedAgentIds ?? []}
      onAttached={over.onAttached ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockResolvedValue({ error: null });
});

describe("who can be attached", () => {
  it("offers agents that are not already on this page", () => {
    show({
      agents: [ready(), ready({ id: "a2", name: "Nurture" })],
      attachedAgentIds: ["a2"],
    });
    const select = screen.getByLabelText(/attach a sales agent/i);
    expect(select).toHaveTextContent("Consult Qualifier");
    expect(select).not.toHaveTextContent("Nurture");
  });

  it("disables an agent that is not approved, rather than hiding why", () => {
    show({ agents: [ready({ approved_at: null })] });
    const option = screen.getByRole("option", { name: /consult qualifier/i });
    expect(option).toBeDisabled();
    expect(option).toHaveTextContent(/approve this agent/i);
    expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
  });

  it("disables an agent that is not live", () => {
    show({ agents: [ready({ status: "draft" })] });
    expect(screen.getByRole("option", { name: /consult qualifier/i })).toBeDisabled();
    expect(screen.getByRole("option", { name: /consult qualifier/i })).toHaveTextContent(/not live/i);
  });

  it("disables an agent that has not been built", () => {
    show({ agents: [ready({ built_at: null })] });
    expect(screen.getByRole("option", { name: /consult qualifier/i })).toHaveTextContent(
      /not been built/i,
    );
  });

  it("requires the page to be published, because a widget needs an origin", () => {
    show({
      page: { ...PAGE, publish_status: "unpublished", published_url: null },
    });
    expect(screen.getByRole("option", { name: /consult qualifier/i })).toHaveTextContent(
      /publish the page/i,
    );
    expect(screen.getByRole("button", { name: "Attach" })).toBeDisabled();
  });
});

describe("origin is derived, never typed", () => {
  it("shows the origin the agent will answer on, taken from the published URL", () => {
    show();
    expect(screen.getByText(/it will answer on https:\/\/attractacq\.github\.io/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("attaching", () => {
  it("writes a disabled deployment and says so, because attach is not go-live", async () => {
    const onAttached = vi.fn();
    show({ onAttached });

    await userEvent.selectOptions(screen.getByLabelText(/attach a sales agent/i), "a1");
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));

    expect(insert).toHaveBeenCalledWith({
      client_id: "client-1",
      sales_agent_id: "a1",
      page_id: "page-1",
      site_repository_id: "repo-1",
      allowed_origin: "https://attractacq.github.io",
      enabled: false,
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/switched off/i);
    expect(onAttached).toHaveBeenCalled();
    expect(screen.getByLabelText(/attach a sales agent/i)).toHaveValue("");
  });

  it("does not insert when the chosen agent is blocked", async () => {
    show({ agents: [ready({ approved_at: null })] });
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(insert).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("surfaces the database refusal rather than going quiet", async () => {
    insert.mockResolvedValue({ error: { message: "new row violates row-level security" } });
    show();
    await userEvent.selectOptions(screen.getByLabelText(/attach a sales agent/i), "a1");
    await userEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/row-level security/i);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says when every agent is already on this page", () => {
    show({ attachedAgentIds: ["a1"] });
    expect(screen.getByText(/already attached/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach" })).not.toBeInTheDocument();
  });

  it("says when this client has no agents yet", () => {
    show({ agents: [] });
    expect(screen.getByText(/sales tab first/i)).toBeInTheDocument();
  });
});
