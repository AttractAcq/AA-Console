import { describe, expect, it } from "vitest";
import { clientNavGroups } from "./navigation";

describe("client delivery navigation", () => {
  it("follows the production journey before supporting modules", () => {
    expect(clientNavGroups[0]?.children?.map((node) => node.label)).toEqual([
      "Dashboard", "Intelligence", "Strategy", "Proof Bank", "Ideation", "Create",
      "Edit / Repurpose", "Approvals", "Media", "Distribution", "Reporting", "Campaigns",
      "Page Builder", "Motion Design", "Sales Agents", "Prospects & Leads", "Economics", "Archive",
    ]);
  });
});
