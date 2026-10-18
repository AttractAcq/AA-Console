import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { LandingPage } from "./LandingPage";
import { STEPS } from "./landingContent";

function show() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

describe("what the landing page leads with", () => {
  it("names the positioning before anything else", () => {
    show();
    expect(
      screen.getByRole("heading", { level: 1, name: /content that can prove it/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/proof-based content for service businesses/i)).toBeInTheDocument();
  });

  it("sends both calls to action to the same place a visitor can act", () => {
    show();
    // Several CTAs, one destination — a page with two competing next steps
    // converts worse than one with a single one repeated.
    const ctas = screen.getAllByRole("link", { name: /book a proof audit/i });
    expect(ctas.length).toBeGreaterThan(1);
    for (const cta of ctas) expect(cta).toHaveAttribute("href", "#start");
  });
});

describe("the claims the page makes", () => {
  it("labels the console figures as a sample rather than a client result", () => {
    // The page argues that no claim should appear without evidence. Mocked
    // numbers presented as real would break that argument on the page that
    // makes it.
    show();
    expect(screen.getByText(/sample workspace/i)).toBeInTheDocument();
  });

  it("marks the proof record as an example", () => {
    show();
    expect(screen.getByText(/example record/i)).toBeInTheDocument();
  });
});

describe("the pipeline the page describes", () => {
  it("shows every stage, in the order the work moves through them", () => {
    show();
    const stages = within(
      screen.getByRole("list", { name: /pipeline, in order/i }),
    ).getAllByRole("listitem");

    expect(stages).toHaveLength(STEPS.length);
    stages.forEach((stage, i) => {
      expect(stage).toHaveTextContent(STEPS[i].n);
      expect(stage).toHaveTextContent(STEPS[i].label);
    });
  });
});

describe("the footer", () => {
  it("offers no link to a page that does not exist", () => {
    // Privacy and terms are not written yet, and linking them to the admin
    // login is how a public page leaks an internal one.
    show();
    expect(screen.queryByRole("link", { name: /privacy/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /terms/i })).not.toBeInTheDocument();
  });

  it("points the console links at their own sign-in", () => {
    show();
    expect(screen.getByRole("link", { name: /client console/i })).toHaveAttribute(
      "href",
      "/client/login",
    );
  });
});
