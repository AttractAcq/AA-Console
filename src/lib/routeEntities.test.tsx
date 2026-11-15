import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { TEAM_CATEGORIES } from "../data/team";
import { useRouteScope } from "./routeEntities";

function ScopeProbe() {
  return <pre data-testid="scope">{JSON.stringify(useRouteScope())}</pre>;
}

function scopeAt(path: string) {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <ScopeProbe />
    </MemoryRouter>,
  );
  const scope = JSON.parse(screen.getByTestId("scope").textContent ?? "{}") as Record<string, string>;
  view.unmount();
  return scope;
}

describe("team member routes", () => {
  it("resolves a creative director the same way as the other roster categories", () => {
    for (const category of TEAM_CATEGORIES) {
      expect(scopeAt(`/team/${category}/member-1/overview`)).toEqual({
        category,
        memberId: "member-1",
      });
    }
  });

  it("does not treat a team tab that is not a roster category as a member", () => {
    expect(scopeAt("/team/chat/member-1")).toEqual({});
    expect(scopeAt("/team/agents/copywriter/overview")).toEqual({ agentId: "copywriter" });
  });
});
