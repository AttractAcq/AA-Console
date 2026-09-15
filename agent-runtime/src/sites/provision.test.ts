import { describe, expect, it, beforeEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { provisionSite, publishPage, syncInstallation, type SiteStore, type SiteRepoRecord, type PageRecord, type InstallationRecord } from "./provision.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP = { appId: "4932777", privateKey, installationId: null };
const SITE = { org: "AttractAcq-Sites", runtimeBase: "https://runtime.attractacq.com" };

/** An in-memory SiteStore that records what was written, and in what order. */
function store() {
  const writes: string[] = [];
  const state = {
    installation: null as InstallationRecord | null,
    repos: [] as SiteRepoRecord[],
    page: {
      id: "page-1",
      clientId: "client-1",
      title: "Agency Growth Partner",
      html: "<h1>Grow</h1>",
      siteRepositoryId: null,
      sitePath: null,
    } as PageRecord,
    pageStatus: "unpublished",
    pageError: null as string | null,
    published: null as { commit: string; url: string } | null,
  };

  const impl: SiteStore = {
    async upsertInstallation(record) {
      state.installation = record;
      writes.push("upsertInstallation");
      return "install-row-1";
    },
    async clientName() {
      return "Attract Acquisition";
    },
    async findRepo(_clientId, owner, repo) {
      return state.repos.find((r) => r.owner === owner && r.repo === repo) ?? null;
    },
    async readyRepoForClient(clientId) {
      return state.repos.find((r) => r.clientId === clientId && r.status === "ready") ?? null;
    },
    async repoById(id) {
      return state.repos.find((r) => r.id === id) ?? null;
    },
    async saveRepo(record) {
      writes.push("saveRepo");
      const row: SiteRepoRecord = {
        id: record.id ?? `repo-${state.repos.length + 1}`,
        clientId: record.clientId,
        owner: record.owner,
        repo: record.repo,
        defaultBranch: record.defaultBranch,
        pagesUrl: record.pagesUrl,
        status: record.status,
      };
      state.repos = state.repos.filter((r) => r.id !== row.id).concat(row);
      return row;
    },
    async loadPage() {
      return state.page;
    },
    async markPublishing(_pageId, repoId, path) {
      writes.push("markPublishing");
      state.pageStatus = "publishing";
      state.page = { ...state.page, siteRepositoryId: repoId, sitePath: path };
    },
    async markPublished(_pageId, fields) {
      writes.push("markPublished");
      state.pageStatus = "published";
      state.published = { commit: fields.commit, url: fields.url };
    },
    async markPublishFailed(_pageId, error) {
      writes.push("markPublishFailed");
      state.pageStatus = "failed";
      state.pageError = error;
    },
  };
  return { impl, state, writes };
}

const ORG_INSTALL = {
  id: 161987579,
  account: { login: "AttractAcq-Sites", type: "Organization" },
  repository_selection: "all",
  permissions: { administration: "write", contents: "write", pages: "write", metadata: "read" },
};

const REPO_BODY = {
  id: 987,
  name: "attract-acquisition-site",
  owner: { login: "AttractAcq-Sites" },
  default_branch: "main",
  html_url: "https://github.com/AttractAcq-Sites/attract-acquisition-site",
  private: false,
};

const PAGES_URL = "https://attractacq-sites.github.io/attract-acquisition-site";
const BASE = "/repos/AttractAcq-Sites/attract-acquisition-site";

type Route = { status?: number; body?: unknown };

function github(routes: Record<string, Route>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Auth, commit plumbing and a successful Pages build, shared by most tests. */
function baseRoutes(over: Record<string, Route> = {}, install = ORG_INSTALL): Record<string, Route> {
  return {
    "GET /app/installations": { body: [install] },
    "POST /app/installations/161987579/access_tokens": { body: { token: "ghs_x", expires_at: "" } },
    [`GET ${BASE}/git/ref/heads/main`]: { body: { object: { sha: "head1" } } },
    [`GET ${BASE}/git/commits/head1`]: { body: { tree: { sha: "tree1" } } },
    [`POST ${BASE}/git/blobs`]: { body: { sha: "blob1" } },
    [`POST ${BASE}/git/trees`]: { body: { sha: "tree2" } },
    [`POST ${BASE}/git/commits`]: { body: { sha: "commit2" } },
    [`PATCH ${BASE}/git/refs/heads/main`]: { body: {} },
    [`POST ${BASE}/pages`]: {
      status: 201,
      body: { status: "building", html_url: PAGES_URL, build_type: "legacy", source: { branch: "main", path: "/" } },
    },
    [`GET ${BASE}/pages/builds/latest`]: { body: { status: "built", commit: "commit2", error: {} } },
    ...over,
  };
}

const noSleep = async () => {};

describe("recording which installation AA acts through", () => {
  it("writes the row the console has been gating on", async () => {
    // The Sites tab asked this table and always got nothing, because nothing
    // ever wrote to it. This is the writer.
    const s = store();
    const { fetchImpl } = github(baseRoutes());
    const { rowId, record } = await syncInstallation(s.impl, APP, { fetchImpl });
    expect(rowId).toBe("install-row-1");
    expect(record).toEqual({
      installationId: 161987579,
      accountLogin: "AttractAcq-Sites",
      accountType: "Organization",
    });
  });
});

describe("provisioning a site", () => {
  it("creates the repo, commits the shell, enables Pages and records it", async () => {
    const s = store();
    const { fetchImpl, calls } = github(baseRoutes({ "POST /orgs/AttractAcq-Sites/repos": { status: 201, body: REPO_BODY } }));

    const result = await provisionSite(s.impl, APP, SITE, { clientId: "client-1", repo: "attract-acquisition-site" }, { fetchImpl, sleep: noSleep });

    expect(result.created).toBe(true);
    expect(result.pagesUrl).toBe(PAGES_URL);
    expect(result.repo.status).toBe("ready");
    expect(calls.some((c) => c.path === "/orgs/AttractAcq-Sites/repos")).toBe(true);
    expect(calls.some((c) => c.path === `${BASE}/pages` && c.method === "POST")).toBe(true);
    // The installation row must exist before the repo row that references it.
    expect(s.writes.indexOf("upsertInstallation")).toBeLessThan(s.writes.indexOf("saveRepo"));
  });

  it("commits the shell that makes Pages serve generated HTML untouched", async () => {
    const s = store();
    const { fetchImpl, calls } = github(baseRoutes({ "POST /orgs/AttractAcq-Sites/repos": { status: 201, body: REPO_BODY } }));
    await provisionSite(s.impl, APP, SITE, { clientId: "client-1", repo: "attract-acquisition-site" }, { fetchImpl, sleep: noSleep });

    const tree = calls.find((c) => c.path.endsWith("/git/trees"))?.body as { tree: { path: string }[] };
    const paths = tree.tree.map((t) => t.path);
    // Without .nojekyll, Pages runs generated HTML through Jekyll.
    expect(paths).toContain(".nojekyll");
    expect(paths).toContain("index.html");
  });

  it("adopts a repository that already exists instead of failing on the name", async () => {
    // A run that created the repo and then failed at Pages has to be fixable by
    // pressing the button again.
    const s = store();
    const { fetchImpl, calls } = github(baseRoutes({ [`GET ${BASE}`]: { body: REPO_BODY } }));
    const result = await provisionSite(s.impl, APP, SITE, { clientId: "client-1", repo: "attract-acquisition-site" }, { fetchImpl, sleep: noSleep });

    expect(result.created).toBe(false);
    expect(result.repo.status).toBe("ready");
    expect(calls.some((c) => c.path === "/orgs/AttractAcq-Sites/repos")).toBe(false);
  });

  it("updates the existing site row rather than adding a second", async () => {
    const s = store();
    const routes = baseRoutes({ [`GET ${BASE}`]: { body: REPO_BODY } });
    const { fetchImpl } = github(routes);
    const req = { clientId: "client-1", repo: "attract-acquisition-site" };
    await provisionSite(s.impl, APP, SITE, req, { fetchImpl, sleep: noSleep });
    await provisionSite(s.impl, APP, SITE, req, { fetchImpl, sleep: noSleep });
    expect(s.state.repos).toHaveLength(1);
  });

  it("treats Pages already being on as success", async () => {
    const s = store();
    const { fetchImpl } = github(baseRoutes({
      [`GET ${BASE}`]: { body: REPO_BODY },
      [`POST ${BASE}/pages`]: { status: 409 },
      [`GET ${BASE}/pages`]: { body: { status: "built", html_url: PAGES_URL, build_type: "legacy", source: { branch: "main", path: "/" } } },
    }));
    const result = await provisionSite(s.impl, APP, SITE, { clientId: "client-1", repo: "attract-acquisition-site" }, { fetchImpl, sleep: noSleep });
    expect(result.pagesUrl).toBe(PAGES_URL);
  });

  it("refuses a personal-account installation before writing anything", async () => {
    // A GitHub App cannot create a repository on a user account at all. Saying
    // so here beats a GitHub error from the middle of the sequence.
    const s = store();
    const { fetchImpl, calls } = github(baseRoutes({}, {
      ...ORG_INSTALL,
      account: { login: "AttractAcq", type: "User" },
    }));
    await expect(
      provisionSite(s.impl, APP, SITE, { clientId: "client-1", repo: "x" }, { fetchImpl, sleep: noSleep }),
    ).rejects.toThrow(/Organization installation/i);
    expect(s.state.repos).toHaveLength(0);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/repos"))).toBe(false);
  });
});

describe("publishing a page", () => {
  function provisioned(s: ReturnType<typeof store>) {
    s.state.repos = [{
      id: "repo-1", clientId: "client-1", owner: "AttractAcq-Sites",
      repo: "attract-acquisition-site", defaultBranch: "main", pagesUrl: PAGES_URL, status: "ready",
    }];
  }

  it("commits the page and reports the URL it is served at", async () => {
    const s = store();
    provisioned(s);
    const { fetchImpl, calls } = github(baseRoutes());
    const result = await publishPage(s.impl, APP, SITE, "page-1", { fetchImpl, sleep: noSleep });

    expect(result.url).toBe(`${PAGES_URL}/agency-growth-partner/`);
    expect(result.commit).toBe("commit2");
    expect(s.state.pageStatus).toBe("published");

    const tree = calls.find((c) => c.path.endsWith("/git/trees"))?.body as { tree: { path: string }[] };
    expect(tree.tree.map((t) => t.path)).toEqual(["agency-growth-partner/index.html"]);
  });

  it("marks the page publishing before it commits, so a crash is visible", async () => {
    const s = store();
    provisioned(s);
    const { fetchImpl } = github(baseRoutes());
    await publishPage(s.impl, APP, SITE, "page-1", { fetchImpl, sleep: noSleep });
    expect(s.writes.indexOf("markPublishing")).toBeLessThan(s.writes.indexOf("markPublished"));
  });

  it("does NOT call a page published when the Pages build failed", async () => {
    // The property that matters most here. A commit only means GitHub took the
    // bytes; a failed build means nobody can load the page.
    const s = store();
    provisioned(s);
    const { fetchImpl } = github(baseRoutes({
      [`GET ${BASE}/pages/builds/latest`]: {
        body: { status: "errored", commit: "commit2", error: { message: "Page build failed." } },
      },
    }));
    await expect(publishPage(s.impl, APP, SITE, "page-1", { fetchImpl, sleep: noSleep })).rejects.toThrow(/Page build failed/);
    expect(s.state.pageStatus).toBe("failed");
    expect(s.state.pageError).toMatch(/Page build failed/);
    expect(s.state.published).toBeNull();
  });

  it("does not accept a build of some earlier commit as proof", async () => {
    const s = store();
    provisioned(s);
    const { fetchImpl } = github(baseRoutes({
      [`GET ${BASE}/pages/builds/latest`]: { body: { status: "built", commit: "OLDER", error: {} } },
    }));
    await expect(publishPage(s.impl, APP, SITE, "page-1", { fetchImpl, sleep: noSleep })).rejects.toThrow(/did not finish building/i);
    expect(s.state.pageStatus).toBe("failed");
  });

  it("is a no-op when the page is already live as exactly these bytes", async () => {
    const s = store();
    provisioned(s);
    const { fetchImpl, calls } = github(baseRoutes({
      [`POST ${BASE}/git/trees`]: { body: { sha: "tree1" } },
      [`GET ${BASE}/pages/builds/latest`]: { body: { status: "built", commit: "head1", error: {} } },
    }));
    const result = await publishPage(s.impl, APP, SITE, "page-1", { fetchImpl, sleep: noSleep });
    expect(result.changed).toBe(false);
    expect(s.state.pageStatus).toBe("published");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("refuses a page with no built HTML", async () => {
    const s = store();
    provisioned(s);
    s.state.page = { ...s.state.page, html: null };
    const { fetchImpl } = github(baseRoutes());
    await expect(publishPage(s.impl, APP, SITE, "page-1", { fetchImpl, sleep: noSleep })).rejects.toThrow(/Page Builder/i);
  });

  it("refuses when the client has no repository yet", async () => {
    const s = store();
    const { fetchImpl } = github(baseRoutes());
    await expect(publishPage(s.impl, APP, SITE, "page-1", { fetchImpl, sleep: noSleep })).rejects.toThrow(/no website repository/i);
  });

  it("will not publish a page over the site shell", async () => {
    // A page slugged "index" would otherwise overwrite the homepage the shell
    // owns, on a repo where every other page links through it.
    const s = store();
    provisioned(s);
    s.state.page = { ...s.state.page, sitePath: "aa/config.json" };
    const { fetchImpl } = github(baseRoutes());
    await expect(publishPage(s.impl, APP, SITE, "page-1", { fetchImpl, sleep: noSleep })).rejects.toThrow(/shell owns/i);
  });

  it("keeps publishing to the path it first used, not a renamed title", async () => {
    // Changing a title must not silently strand the live URL and publish a
    // second copy somewhere else.
    const s = store();
    provisioned(s);
    s.state.page = { ...s.state.page, sitePath: "original-path/index.html", title: "A Completely New Title" };
    const { fetchImpl, calls } = github(baseRoutes());
    const result = await publishPage(s.impl, APP, SITE, "page-1", { fetchImpl, sleep: noSleep });
    const tree = calls.find((c) => c.path.endsWith("/git/trees"))?.body as { tree: { path: string }[] };
    expect(tree.tree.map((t) => t.path)).toEqual(["original-path/index.html"]);
    expect(result.url).toBe(`${PAGES_URL}/original-path/`);
  });
});
