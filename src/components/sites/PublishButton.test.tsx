import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callRuntime } = vi.hoisted(() => ({ callRuntime: vi.fn() }));
vi.mock("../../lib/callRuntime", () => ({ callRuntime }));

import { PublishButton } from "./PublishButton";
import type { SiteRepo } from "../../pages/sites/readiness";

const READY: SiteRepo[] = [
  { id: "repo-1", owner: "AttractAcq-Sites", repo: "aa-offers", status: "ready", pages_url: "https://attractacq-sites.github.io/aa-offers/" },
];

const page = (over: Record<string, unknown> = {}) => ({
  id: "3f1c2b4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b",
  title: "Agency Growth Partner",
  html: "<h1>Grow</h1>",
  publish_status: "unpublished",
  published_url: null,
  site_repository_id: null,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("publishing a page", () => {
  it("sends the page to the runtime and reports where it went live", async () => {
    callRuntime.mockResolvedValue({
      url: "https://attractacq-sites.github.io/aa-offers/agency-growth-partner/",
      commit: "abc123",
      changed: true,
    });
    const onPublished = vi.fn();
    render(<PublishButton page={page()} repos={READY} onPublished={onPublished} />);

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(callRuntime).toHaveBeenCalledWith("/admin/sites/publish", {
      pageId: "3f1c2b4e-5a6d-4e7f-8a9b-0c1d2e3f4a5b",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/agency-growth-partner/);
    // The caller has to refetch, or the card keeps showing the old state.
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
  });

  it("says plainly when a republish changed nothing", async () => {
    // The common case when pressing it twice, and silence would read as failure.
    callRuntime.mockResolvedValue({ url: "https://x.github.io/y/p/", commit: "abc", changed: false });
    render(<PublishButton page={page()} repos={READY} onPublished={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/nothing had changed/i);
  });

  it("shows the runtime's refusal, because it names what to fix", async () => {
    callRuntime.mockRejectedValue(new Error("That page has no built HTML yet. Run the Page Builder first."));
    render(<PublishButton page={page()} repos={READY} onPublished={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Page Builder first/);
  });

  it("does not report success when publishing failed", async () => {
    callRuntime.mockRejectedValue(new Error("GitHub Pages did not build this page."));
    const onPublished = vi.fn();
    render(<PublishButton page={page()} repos={READY} onPublished={onPublished} />);
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onPublished).not.toHaveBeenCalled();
  });
});

describe("when a page cannot go live", () => {
  it("will not publish a page that has not been built", async () => {
    render(<PublishButton page={page({ html: null })} repos={READY} onPublished={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByText(/has not been built yet/i)).toBeInTheDocument();
    expect(callRuntime).not.toHaveBeenCalled();
  });

  it("will not publish when the client has no site yet", () => {
    render(<PublishButton page={page()} repos={[]} onPublished={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByText(/No website is ready/i)).toBeInTheDocument();
  });

  it("does not count a site that is still being provisioned", () => {
    const provisioning: SiteRepo[] = [{ ...READY[0]!, status: "provisioning" }];
    render(<PublishButton page={page()} repos={provisioning} onPublished={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
  });
});

describe("a page that is already live", () => {
  const live = page({
    publish_status: "published",
    published_url: "https://attractacq-sites.github.io/aa-offers/agency-growth-partner/",
    site_repository_id: "repo-1",
  });

  it("offers a republish rather than a second publish", () => {
    render(<PublishButton page={live} repos={READY} onPublished={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Republish" })).toBeEnabled();
  });

  it("links to the live page so it can actually be looked at", () => {
    render(<PublishButton page={live} repos={READY} onPublished={vi.fn()} />);
    const link = screen.getByRole("link", { name: /agency-growth-partner/ });
    expect(link).toHaveAttribute("href", live.published_url);
    // Opening a client's live site must not navigate the console away.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
