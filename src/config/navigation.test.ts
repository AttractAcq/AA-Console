import { describe, expect, it } from "vitest";
import { clientNavGroups, legacyDeliveryNodes, legacyDeliveryRedirects, v6ModuleNodes } from "./navigation";

describe("client delivery navigation", () => {
  it("shows every acquisition module as its own Delivery page with the agreed utilities", () => {
    expect(clientNavGroups[0]?.children?.map((node) => node.label)).toEqual([
      // Market Opportunities sits between intelligence and campaigns: it is
      // the commercial reason a campaign should exist.
      "Dashboard", "Approval Inbox", "Intelligence OS", "Market Opportunities", "Campaign Factory",
      "Proof Production Factory", "Content Production Factory", "Proof Distribution",
      "Organic Content Distribution", "Google Ads Studio", "Meta Ads Studio", "Google Profile",
      "Meta Profile", "Offer Studio", "Website Studio", "Lead Magnet Studio",
      "Sales OS", "Attribution OS", "Motion Design", "Archive",
    ]);
    expect(v6ModuleNodes).toHaveLength(16);
    expect(new Set(clientNavGroups[0]?.children?.map((node) => node.path)).size).toBe(20);
    // v1 is archived, so no page offers a version to choose between. The
    // ten that did are now simply the page, and Intelligence OS keeps the
    // only `?view=` there is: two halves of one module, not two versions.
    expect(clientNavGroups[0]?.children?.filter((node) =>
      node.sidebarViews?.some((view) => view.id === "v1" || view.id === "v2")))
      .toEqual([]);
    expect(v6ModuleNodes.find((node) => node.id === "intelligence-os")?.sidebarViews?.map((view) => view.id))
      .toEqual(["intelligence", "strategy"]);
  });

  it("sends every replaced v5 Delivery route to the page that took over its work", () => {
    // The migration these were kept available for is over: each one is a
    // redirect now, and this is what stops one being archived with nowhere
    // to send the links that still point at it.
    expect(legacyDeliveryNodes.map((node) => node.path)).toEqual([
      "intelligence", "strategy", "proof-bank", "ideation", "create", "edit-repurpose",
      "approvals", "media", "distribution", "reporting", "campaign-execution",
      "conversion", "sales", "prospects-leads", "economics",
    ]);
    for (const node of legacyDeliveryNodes) {
      expect(legacyDeliveryRedirects[node.path]).toBeDefined();
    }
    // And every destination is a page that exists.
    const live = new Set(clientNavGroups.flatMap((group) =>
      (group.children ?? []).map((child) => child.path)));
    for (const target of Object.values(legacyDeliveryRedirects)) {
      expect(live).toContain(target.split("?")[0]);
    }
    expect(v6ModuleNodes.find((node) => node.id === "content-production-factory")?.tabs?.map((tab) => tab.id))
      .toEqual(["generation", "briefs", "create", "edit", "assets"]);
    // This list is now empty, and that is the point: every one of the fifteen
    // modules has a console surface. Google Ads was the last to leave it, with
    // a build sheet rather than an adapter — `capability: "expanding"` says
    // there is something real here and that it is not finished, which for
    // Google Ads means a sheet and no way to spend money.
    expect(v6ModuleNodes.filter((node) => node.capability === "planned").map((node) => node.id))
      .toEqual([]);
    expect(v6ModuleNodes.find((node) => node.id === "google-profile")?.tabs?.map((tab) => tab.id))
      .toEqual(["location", "reviews", "posts", "metrics"]);
    expect(v6ModuleNodes.find((node) => node.id === "google-ads-studio")?.tabs?.map((tab) => tab.id))
      .toEqual(["sheet", "account", "build"]);
    // Every module has tabs, bar Campaign Factory, which is one table and
    // had no tab bar in v2 either. A node with an empty tab list would
    // render a bar with nothing in it.
    expect(v6ModuleNodes.filter((node) => node.tabs?.length === 0)).toEqual([]);
    expect(v6ModuleNodes.filter((node) => !node.tabs).map((node) => node.id))
      .toEqual(["campaign-factory"]);
    expect(v6ModuleNodes.find((node) => node.id === "lead-magnet-studio")?.tabs?.map((tab) => tab.id))
      .toEqual(["magnets", "build", "delivery", "optins"]);
    expect(v6ModuleNodes.find((node) => node.id === "proof-distribution")?.tabs?.map((tab) => tab.id))
      .toEqual(["destinations", "placements", "rights"]);
  });
});
