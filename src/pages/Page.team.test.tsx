import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./operations/TeamCategoryPanel", () => ({
  TeamCategoryPanel: ({ category }: { category: string }) => <p>team-category:{category}</p>,
}));
vi.mock("./team/ChatPanel", () => ({ ChatPanel: () => <p>chat-panel</p> }));
vi.mock("./team/AgentsPanel", () => ({ AgentsPanel: () => <p>agents-panel</p> }));
vi.mock("./operations/RecruitmentPanel", () => ({ RecruitmentPanel: () => <p>recruitment-panel</p> }));
vi.mock("./team/RecruitmentPagesPanel", () => ({
  RecruitmentPagesPanel: () => <p>recruitment-pages-panel</p>,
}));
vi.mock("./team/RecruitmentDistributionPanel", () => ({
  RecruitmentDistributionPanel: () => <p>recruitment-distribution-panel</p>,
}));

import { agencyNav } from "../config/navigation";
import { Page } from "./Page";

const team = agencyNav.find((node) => node.id === "team")!;

function renderTeamTab(tabId: string) {
  render(
    <MemoryRouter initialEntries={[`/team?tab=${tabId}`]}>
      <Page node={team} />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("Team tab panels", () => {
  it("renders Creative Directors with TeamCategoryPanel for creative_director", () => {
    renderTeamTab("creative_director");
    expect(screen.getByRole("tab", { name: "Creative Directors", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("team-category:creative_director");
  });

  it("maps every Team nav tab to a Page panel", () => {
    // An unmapped tab falls through to EmptyState, whose text is the tab
    // label and nothing else. A mapped tab renders its panel instead.
    const missing: string[] = [];
    for (const tab of team.tabs ?? []) {
      renderTeamTab(tab.id);
      if (screen.getByRole("tabpanel").textContent === tab.label) missing.push(tab.id);
      cleanup();
    }
    expect(missing).toEqual([]);
  });
});
