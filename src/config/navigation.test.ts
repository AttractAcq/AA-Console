import { describe, expect, it } from "vitest";
import { clientNavGroups, legacyDeliveryNodes, v6ModuleNodes } from "./navigation";

describe("client delivery navigation", () => {
  it("shows every acquisition module as its own Delivery page with the agreed utilities", () => {
    expect(clientNavGroups[0]?.children?.map((node) => node.label)).toEqual([
      "Dashboard", "Approval Inbox", "Intelligence OS", "Campaign Factory",
      "Proof Production Factory", "Content Production Factory", "Proof Distribution",
      "Content Distribution", "Google Ads Studio", "Meta Ads Studio", "Google Profile",
      "Meta Profile", "Offer Studio", "Website Studio", "Lead Magnet Studio",
      "Sales OS", "Attribution OS", "Motion Design", "Archive",
    ]);
    expect(v6ModuleNodes).toHaveLength(15);
    expect(new Set(clientNavGroups[0]?.children?.map((node) => node.path)).size).toBe(19);
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
    expect(v6ModuleNodes.filter((node) => node.capability === "planned").map((node) => node.id))
      .toEqual(["proof-distribution", "google-ads-studio", "google-profile", "lead-magnet-studio"]);
  });
});
