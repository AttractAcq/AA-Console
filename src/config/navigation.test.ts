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
    // Three tabs are archived rather than deleted, per Alex on 31 October:
    // the notes call Placements and Rights "not as important ... both need to
    // be discontinued", and Opt-ins "isnt necissary to track". Their panels
    // still compile; only the route in is gone. Pinned here so a reinstated
    // tab is a deliberate act rather than a merge artefact.
    expect(v6ModuleNodes.find((node) => node.id === "lead-magnet-studio")?.tabs?.map((tab) => tab.id))
      .toEqual(["magnets", "build", "delivery"]);
    expect(v6ModuleNodes.find((node) => node.id === "proof-distribution")?.tabs?.map((tab) => tab.id))
      .toEqual(["destinations"]);
  });
});

describe("Offer Strategy belongs to Strategy, not Offer Studio", () => {
  it("is a tab of Intelligence OS and not of Offer Studio", () => {
    // The notes: "the offer strategy tab needs to be moved back to under the
    // strategy module as its own tab."
    const intelligence = v6ModuleNodes.find((node) => node.id === "intelligence-os");
    const offerStudio = v6ModuleNodes.find((node) => node.id === "offer-studio");
    expect(intelligence?.tabs?.map((tab) => tab.id)).toContain("offer-strategy");
    expect(offerStudio?.tabs?.map((tab) => tab.id)).not.toContain("offer-strategy");
    expect(offerStudio?.tabs?.map((tab) => tab.id)).toEqual(["live-use", "offers"]);
  });
});

describe("the Strategy half of Intelligence OS", () => {
  it("contains exactly the four strategy tabs, in product order", () => {
    // Page.tsx splits Intelligence OS with
    //   strategyTabIds.has(tab.id) === (view === "strategy")
    // so a tab absent from that set lands under Intelligence no matter how it
    // is grouped here. This asserts the grouping; Page.tsx's own set is kept in
    // step by the test below.
    const strategyIds = ["branding-strategy", "content-pillars", "offer-strategy", "money-model-strategy"];
    const tabs = v6ModuleNodes.find((node) => node.id === "intelligence-os")?.tabs ?? [];
    const ids = tabs.map((tab) => tab.id);
    // Present, and after the intelligence tabs rather than interleaved.
    expect(ids.filter((id) => strategyIds.includes(id))).toEqual(strategyIds);
    expect(ids.slice(-4)).toEqual(strategyIds);
  });
});
