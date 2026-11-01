import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { v6ModuleNodes } from "../config/navigation";

/**
 * Intelligence OS is one node rendered as two halves, and which half a tab
 * lands in is decided by a Set in Page.tsx rather than by the grouping in
 * navigation.ts:
 *
 *   strategyTabIds.has(tab.id) === (view === "strategy")
 *
 * So a tab can be grouped with Strategy in navigation and still render under
 * Intelligence, silently, which is exactly the state Offer Strategy was found
 * in. Two sources of truth for one decision, so this pins them together: if
 * someone adds a strategy tab to navigation and forgets the Set, this fails
 * instead of the tab quietly appearing on the wrong screen.
 */
describe("Page.tsx's strategyTabIds and navigation.ts agree", () => {
  it("lists the same strategy tabs in both places", () => {
    // Read from the repository root: import.meta.url is not a file URL under
    // the jsdom environment these tests run in.
    const source = readFileSync(resolve(process.cwd(), "src/pages/Page.tsx"), "utf8");
    const match = /const strategyTabIds = new Set\(\[([\s\S]*?)\]\);/.exec(source);
    expect(match, "strategyTabIds not found in Page.tsx").not.toBeNull();
    const inPage = [...match![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort();

    const tabs = v6ModuleNodes.find((node) => node.id === "intelligence-os")?.tabs ?? [];
    const strategyLike = tabs
      .map((tab) => tab.id)
      .filter((id) => id.endsWith("-strategy") || id === "content-pillars")
      .sort();

    expect(inPage).toEqual(strategyLike);
  });
});
