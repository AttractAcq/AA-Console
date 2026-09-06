import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentActivityBar } from "./AgentActivityBar";
import type { LiveJob } from "../../lib/useAgentJobs";

function job(over: Partial<LiveJob> = {}): LiveJob {
  return {
    id: "job-1",
    agent_key: "creative_build",
    status: "failed",
    attempts: 1,
    error: "No image renderer is configured.",
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("AgentActivityBar", () => {
  it("renders nothing when there is no work and no failure", () => {
    const { container } = render(<AgentActivityBar inFlight={[]} failures={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the running agent rather than only counting it", () => {
    render(<AgentActivityBar inFlight={[job({ status: "running" })]} failures={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Agent running");
    expect(screen.getByRole("status")).toHaveTextContent("Creative Build");
  });

  it("pluralises the count for more than one agent", () => {
    render(
      <AgentActivityBar
        inFlight={[job({ id: "a", status: "running" }), job({ id: "b", status: "queued" })]}
        failures={[]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("2 agents running");
  });

  it("shows a queued job as queued rather than as an elapsed time", () => {
    render(<AgentActivityBar inFlight={[job({ status: "queued" })]} failures={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("queued");
  });

  it("surfaces the failure message, not just that it failed", () => {
    render(<AgentActivityBar inFlight={[]} failures={[job()]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Creative Build failed");
    expect(screen.getByRole("alert")).toHaveTextContent("No image renderer is configured.");
  });

  // attempts became truthful when non-retryable failures stopped inflating
  // it to the max. A single-attempt failure claiming "after 3 attempts" was
  // the visible half of that bug.
  it("does not claim retries that did not happen", () => {
    render(<AgentActivityBar inFlight={[]} failures={[job({ attempts: 1 })]} />);
    expect(screen.getByRole("alert")).not.toHaveTextContent("attempts");
  });

  it("reports retries that did happen", () => {
    render(<AgentActivityBar inFlight={[]} failures={[job({ attempts: 3 })]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("after 3 attempts");
  });

  it("dismisses one failure without touching the others", async () => {
    const user = userEvent.setup();
    render(
      <AgentActivityBar
        inFlight={[]}
        failures={[
          job({ id: "a", agent_key: "creative_build" }),
          job({ id: "b", agent_key: "ideation" }),
        ]}
      />,
    );
    await user.click(screen.getByLabelText("Dismiss the Creative Build failure"));
    expect(screen.queryByText(/Creative Build failed/)).not.toBeInTheDocument();
    expect(screen.getByText(/Ideation failed/)).toBeInTheDocument();
  });

  // The regression this file exists for. Dismissal lived in component state,
  // and the bar unmounts on every tab change, so a dismissed error came back
  // the moment you navigated away and returned.
  it("keeps a dismissal across an unmount, as a tab change causes", async () => {
    const user = userEvent.setup();
    const failures = [job()];
    const first = render(<AgentActivityBar inFlight={[]} failures={failures} />);
    await user.click(screen.getByLabelText("Dismiss the Creative Build failure"));
    first.unmount();

    const { container } = render(<AgentActivityBar inFlight={[]} failures={failures} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Dismissing by id, not by index: the list re-orders as jobs settle.
  it("still hides the dismissed job after the list re-orders", async () => {
    const user = userEvent.setup();
    const a = job({ id: "a", agent_key: "creative_build" });
    const b = job({ id: "b", agent_key: "ideation" });
    const first = render(<AgentActivityBar inFlight={[]} failures={[a, b]} />);
    await user.click(screen.getByLabelText("Dismiss the Creative Build failure"));
    first.unmount();

    render(<AgentActivityBar inFlight={[]} failures={[b, a]} />);
    expect(screen.queryByText(/Creative Build failed/)).not.toBeInTheDocument();
    expect(screen.getByText(/Ideation failed/)).toBeInTheDocument();
  });

  // Private windows and blocked site data throw on access. Dismissal then
  // lasts only as long as the component, which is the old behaviour — but
  // the bar must still render.
  it("survives sessionStorage being unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const user = userEvent.setup();
    render(<AgentActivityBar inFlight={[]} failures={[job()]} />);
    await user.click(screen.getByLabelText("Dismiss the Creative Build failure"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores a corrupt dismissal record rather than blanking the bar", () => {
    sessionStorage.setItem("aa:dismissed-agent-failures", "not json");
    render(<AgentActivityBar inFlight={[]} failures={[job()]} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
