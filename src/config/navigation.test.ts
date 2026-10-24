import { describe, expect, it } from "vitest";
import { clientNavGroups, legacyDeliveryNodes, v6ModuleNodes } from "./navigation";

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
    for (const id of ["campaign-factory", "proof-production-factory", "content-production-factory",
      "content-distribution", "meta-ads-studio", "meta-profile", "offer-studio", "website-studio", "sales-os"]) {
      expect(v6ModuleNodes.find((node) => node.id === id)?.sidebarViews?.map((view) => view.id))
        .toEqual(["v1", "v2"]);
    }
    expect(v6ModuleNodes.find((node) => node.id === "intelligence-os")?.sidebarViews?.map((view) => view.id))
      .toEqual(["intelligence", "strategy"]);
  });

  it("keeps every replaced v5 Delivery route available during migration", () => {
    expect(legacyDeliveryNodes.map((node) => node.path)).toEqual([
      "intelligence", "strategy", "proof-bank", "ideation", "create", "edit-repurpose",
      "approvals", "media", "distribution", "reporting", "campaign-execution",
      "conversion", "sales", "prospects-leads", "economics",
    ]);
    expect(v6ModuleNodes.find((node) => node.id === "content-production-factory")?.tabs?.map((tab) => tab.id))
      .toEqual(["generation", "briefs", "create", "edit", "image-library", "video-library",
        "reel-shots", "copy-library", "story-library", "carousel-library"]);
    // Proof Distribution left this list when it got its three tabs, Lead
    // Magnet Studio when it got its four, and Google Profile when it got the
    // location, reviews and posts surfaces. Google Ads is the last one with
    // no console surface at all.
    expect(v6ModuleNodes.filter((node) => node.capability === "planned").map((node) => node.id))
      .toEqual(["google-ads-studio"]);
    expect(v6ModuleNodes.find((node) => node.id === "google-profile")?.tabs?.map((tab) => tab.id))
      .toEqual(["location", "reviews", "posts", "metrics"]);
    expect(v6ModuleNodes.find((node) => node.id === "lead-magnet-studio")?.tabs?.map((tab) => tab.id))
      .toEqual(["magnets", "build", "delivery", "optins"]);
    expect(v6ModuleNodes.find((node) => node.id === "proof-distribution")?.tabs?.map((tab) => tab.id))
      .toEqual(["destinations", "placements", "rights"]);
  });
});
