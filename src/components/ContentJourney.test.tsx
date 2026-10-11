import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ContentJourney } from "./ContentJourney";

describe("ContentJourney", () => {
  it("marks the current stage and keeps brief links in the client delivery route", () => {
    render(<MemoryRouter><ContentJourney clientId="client-1" current="edit" briefId="brief-1" /></MemoryRouter>);
    expect(screen.getByText("Edit / Repurpose")).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("link", { name: "Brief" })).toHaveAttribute(
      "href", "/clients/client-1/delivery/ideation?tab=briefs&brief=brief-1",
    );
    expect(screen.getByRole("link", { name: "Approval" })).toHaveAttribute(
      "href", "/clients/client-1/delivery/approvals?tab=assets",
    );
  });

  it("routes engine approval to its own inbox", () => {
    render(<MemoryRouter><ContentJourney clientId="client-1" current="edit" engineApproval /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Approval" })).toHaveAttribute(
      "href", "/clients/client-1/delivery/approvals?tab=engine-inbox",
    );
  });

  it("routes human footage back to the video library", () => {
    render(<MemoryRouter><ContentJourney clientId="client-1" current="edit" briefId="brief-1" humanVideo /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Create" })).toHaveAttribute(
      "href", "/clients/client-1/delivery/media?tab=video-library&brief=brief-1",
    );
  });
});
