import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The build buttons phase 3 item 9 asks for.
 *
 * The notes want this module to become "a Sites table plus build buttons for
 * landing pages and offer pages". The property worth pinning is HOW: they move
 * the module to its builder rather than opening a second one here.
 *
 * PageBuilderPanel already creates the `client_pages` row and enqueues the
 * `landing_page` agent. A button on this page doing the same would be a second
 * write path for one act -- which is the duplication this module just lost a
 * whole tab for, when Results turned out to be Attribution OS's reporting
 * panel reached by a different route.
 *
 * So the assertion is on the search parameter, not on a page being created:
 * clicking must navigate and must NOT write.
 */
const { setSearchParams, from, rpc, insert } = vi.hoisted(() => ({
  setSearchParams: vi.fn(), from: vi.fn(), rpc: vi.fn(), insert: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ clientId: "client-1" }),
  useSearchParams: () => [new URLSearchParams(), setSearchParams],
}));
vi.mock("../../lib/supabase", () => ({
  supabase: {
    from: (...a: unknown[]) => from(...(a as [])),
    rpc: (...a: unknown[]) => rpc(...(a as [])),
  },
}));
vi.mock("../../lib/useGitHubStatus", () => ({
  useGitHubStatus: () => ({ status: null, loading: false }),
  provisionBlockerFromStatus: () => null,
}));
vi.mock("../../lib/callRuntime", () => ({ callRuntime: vi.fn() }));
vi.mock("../../components/sites/PublishButton", () => ({
  PublishButton: () => <p>publish</p>,
}));
vi.mock("../../components/sites/AttachAgentControl", () => ({
  AttachAgentControl: () => <p>attach</p>,
}));

import { SitesPanel } from "./SitesPanel";

/** Every read this panel makes returns nothing, which is a real empty client. */
function noRows() {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    insert: (...a: unknown[]) => { insert(...(a as [])); return chain; },
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
  });
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  from.mockImplementation(() => noRows());
});

describe("the Sites page is the way in to the builders", () => {
  it("sends you to the landing-page builder rather than building here", async () => {
    render(<SitesPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Build a landing page" }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: "landing-pages" });
  });

  it("sends you to the offer-page builder", async () => {
    render(<SitesPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Build an offer page" }));
    expect(setSearchParams).toHaveBeenCalledWith({ tab: "offer-pages" });
  });

  it("writes nothing when a build button is clicked", async () => {
    // The whole point: one write path for creating a page, and it is not here.
    // Reading client_pages is expected -- this panel lists them -- so the
    // assertion is on writing, not on touching the table.
    render(<SitesPanel />);
    await userEvent.click(await screen.findByRole("button", { name: "Build a landing page" }));
    expect(insert).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
