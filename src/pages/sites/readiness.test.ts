import { describe, expect, it } from "vitest";
import {
  deployBlocker,
  deployableAgents,
  originForPage,
  provisionBlocker,
  publishBlocker,
  repoStateLabel,
  type ApprovableAgent,
  type PublishablePage,
  type SiteRepo,
} from "./readiness";

const repo = (over: Partial<SiteRepo> = {}): SiteRepo => ({
  id: "r1", owner: "AttractAcq", repo: "hd-site", status: "ready",
  pages_url: "https://attractacq.github.io/hd-site/", ...over,
});

const page = (over: Partial<PublishablePage> = {}): PublishablePage => ({
  id: "p1", title: "Winter Offer", html: "<html></html>",
  publish_status: "published", published_url: "https://attractacq.github.io/hd-site/winter-offer/",
  site_repository_id: "r1", ...over,
});

const agent = (over: Partial<ApprovableAgent> = {}): ApprovableAgent => ({
  id: "a1", name: "Consult Qualifier", status: "live",
  built_at: "2026-09-10T00:00:00Z", approved_at: "2026-09-11T00:00:00Z", ...over,
});

describe("provisionBlocker", () => {
  it("blocks until the GitHub App is connected, and says why", () => {
    expect(provisionBlocker([])).toMatch(/connect the aa github app/i);
  });
  it("does not count a suspended or revoked installation", () => {
    expect(provisionBlocker([{ id: "i", account_login: "AttractAcq", status: "suspended" }])).not.toBeNull();
    expect(provisionBlocker([{ id: "i", account_login: "AttractAcq", status: "revoked" }])).not.toBeNull();
  });
  it("clears once an active installation exists", () => {
    expect(provisionBlocker([{ id: "i", account_login: "AttractAcq", status: "active" }])).toBeNull();
  });
});

describe("publishBlocker", () => {
  it("sends you to the page agent when the page was never built", () => {
    // Telling someone to pick a repository here would send them to the wrong screen.
    expect(publishBlocker(page({ html: null }), [repo()])).toMatch(/not been built/i);
  });
  it("blocks when no website is ready", () => {
    expect(publishBlocker(page(), [])).toMatch(/no website is ready/i);
    expect(publishBlocker(page(), [repo({ status: "provisioning" })])).toMatch(/no website is ready/i);
    expect(publishBlocker(page(), [repo({ status: "failed" })])).toMatch(/no website is ready/i);
  });
  it("clears when the page is built and a website is ready", () => {
    expect(publishBlocker(page(), [repo()])).toBeNull();
  });
  it("reports the earliest problem first", () => {
    expect(publishBlocker(page({ html: null }), [])).toMatch(/not been built/i);
  });
});

describe("deployBlocker", () => {
  it("requires a human approval, not merely a live status", () => {
    // Being live is an intention; being approved is a signature.
    expect(deployBlocker(agent({ approved_at: null }), page())).toMatch(/approve this agent/i);
  });
  it("requires the agent to be built", () => {
    expect(deployBlocker(agent({ built_at: null }), page())).toMatch(/not been built/i);
  });
  it("requires the agent to be live", () => {
    expect(deployBlocker(agent({ status: "draft" }), page())).toMatch(/not live/i);
    expect(deployBlocker(agent({ status: "retired" }), page())).toMatch(/not live/i);
  });
  it("requires the page to be published, because a widget needs an origin", () => {
    expect(deployBlocker(agent(), page({ publish_status: "unpublished" }))).toMatch(/publish the page/i);
    expect(deployBlocker(agent(), page({ published_url: null }))).toMatch(/publish the page/i);
  });
  it("clears when everything is true", () => {
    expect(deployBlocker(agent(), page())).toBeNull();
  });
  it("reports the unbuilt agent before the approval, since approving an unbuilt agent is meaningless", () => {
    expect(deployBlocker(agent({ built_at: null, approved_at: null }), page())).toMatch(/not been built/i);
  });
});

describe("deployableAgents", () => {
  it("returns every agent with its own reason rather than hiding the unusable ones", () => {
    const out = deployableAgents([agent(), agent({ id: "a2", approved_at: null })], page());
    expect(out).toHaveLength(2);
    expect(out[0]?.blocker).toBeNull();
    expect(out[1]?.blocker).toMatch(/approve/i);
  });
});

describe("originForPage", () => {
  it("derives the origin from the published URL rather than trusting typing", () => {
    // A typo in an allowed origin is a widget that silently never works.
    expect(originForPage("https://attractacq.github.io/hd-site/winter-offer/")).toBe(
      "https://attractacq.github.io",
    );
  });
  it("handles a custom domain", () => {
    expect(originForPage("https://offers.harbourdental.co.za/winter/")).toBe(
      "https://offers.harbourdental.co.za",
    );
  });
  it("returns null rather than a guess when there is no URL", () => {
    expect(originForPage(null)).toBeNull();
    expect(originForPage("not a url")).toBeNull();
  });
});

describe("repoStateLabel", () => {
  it("distinguishes created-but-not-serving from live", () => {
    expect(repoStateLabel(repo({ status: "ready", pages_url: null }))).toMatch(/pages not configured/i);
    expect(repoStateLabel(repo())).toBe("Live");
  });
  it("names the other states plainly", () => {
    expect(repoStateLabel(repo({ status: "provisioning" }))).toBe("Being created");
    expect(repoStateLabel(repo({ status: "failed" }))).toBe("Failed");
  });
});
