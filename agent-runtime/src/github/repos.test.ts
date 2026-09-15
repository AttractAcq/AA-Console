import { describe, expect, it } from "vitest";
import {
  commitFiles,
  createOrgRepo,
  enablePages,
  getPages,
  getRepo,
  latestPagesBuild,
} from "./repos.js";
import { GitHubApiError } from "./app-auth.js";

type Route = { status?: number; body?: unknown };

/**
 * A stand-in GitHub that records what it was asked.
 *
 * Routes are keyed "METHOD /path". Anything unrouted 404s, which is itself a
 * useful assertion: a call to an endpoint the test did not expect fails loudly
 * rather than quietly passing.
 */
function github(routes: Record<string, Route>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const REPO_BODY = {
  id: 987,
  name: "attract-acquisition-site",
  owner: { login: "AttractAcqSites" },
  default_branch: "main",
  html_url: "https://github.com/AttractAcqSites/attract-acquisition-site",
  private: false,
};

describe("finding a repository", () => {
  it("returns null rather than throwing when it does not exist", async () => {
    // "Does this exist" is a question, not a failure.
    const { fetchImpl } = github({});
    expect(await getRepo("t", "AttractAcqSites", "nope", fetchImpl)).toBeNull();
  });

  it("reads back only the fields a site record needs", async () => {
    const { fetchImpl } = github({
      "GET /repos/AttractAcqSites/attract-acquisition-site": { body: REPO_BODY },
    });
    const repo = await getRepo("t", "AttractAcqSites", "attract-acquisition-site", fetchImpl);
    expect(repo).toEqual({
      id: 987,
      owner: "AttractAcqSites",
      repo: "attract-acquisition-site",
      defaultBranch: "main",
      htmlUrl: "https://github.com/AttractAcqSites/attract-acquisition-site",
      private: false,
    });
  });

  it("raises a real failure instead of reporting no repository", async () => {
    // A 500 must never read as "it isn't there" — that would have the caller
    // create a second repository over a first one it could not see.
    const { fetchImpl } = github({
      "GET /repos/AttractAcqSites/x": { status: 500 },
    });
    await expect(getRepo("t", "AttractAcqSites", "x", fetchImpl)).rejects.toBeInstanceOf(GitHubApiError);
  });
});

describe("creating a repository", () => {
  it("creates it in the organisation, initialised and public", async () => {
    const { fetchImpl, calls } = github({
      "POST /orgs/AttractAcqSites/repos": { status: 201, body: REPO_BODY },
    });
    const repo = await createOrgRepo(
      "t", "AttractAcqSites", "attract-acquisition-site", "Client site", fetchImpl,
    );
    expect(repo.id).toBe(987);

    const sent = calls[0]?.body as Record<string, unknown>;
    // auto_init: branch publishing needs a branch, and a repo with no commits
    // has none.
    expect(sent.auto_init).toBe(true);
    // Pages does not serve a private repo on a free plan.
    expect(sent.private).toBe(false);
    expect(sent.name).toBe("attract-acquisition-site");
  });

  it("uses the organisation endpoint, never the user one", async () => {
    // POST /user/repos does not accept an installation token at all, so an App
    // that tried it would fail every time.
    const { fetchImpl, calls } = github({
      "POST /orgs/Org/repos": { status: 201, body: REPO_BODY },
    });
    await createOrgRepo("t", "Org", "r", "d", fetchImpl);
    expect(calls.map((c) => c.path)).toEqual(["/orgs/Org/repos"]);
    expect(calls.some((c) => c.path === "/user/repos")).toBe(false);
  });
});

const BASE = "/repos/AttractAcqSites/attract-acquisition-site";

function commitRoutes(baseTree: string, newTree: string): Record<string, Route> {
  return {
    [`GET ${BASE}/git/ref/heads/main`]: { body: { object: { sha: "head1" } } },
    [`GET ${BASE}/git/commits/head1`]: { body: { tree: { sha: baseTree } } },
    [`POST ${BASE}/git/blobs`]: { body: { sha: "blob1" } },
    [`POST ${BASE}/git/trees`]: { body: { sha: newTree } },
    [`POST ${BASE}/git/commits`]: { body: { sha: "commit2" } },
    [`PATCH ${BASE}/git/refs/heads/main`]: { body: {} },
  };
}

describe("committing a site", () => {
  const files = [
    { path: "index.html", content: "<h1>Hi</h1>" },
    { path: ".nojekyll", content: "" },
  ];

  it("writes every file as one commit and moves the branch", async () => {
    const { fetchImpl, calls } = github(commitRoutes("tree1", "tree2"));
    const result = await commitFiles(
      "t", "AttractAcqSites", "attract-acquisition-site", "main", files, "Publish", fetchImpl,
    );
    expect(result).toEqual({ commit: "commit2", changed: true });

    // One blob per file, one tree, one commit, one ref move — not a request per
    // file racing to leave half a site behind.
    expect(calls.filter((c) => c.path.endsWith("/git/blobs"))).toHaveLength(2);
    expect(calls.filter((c) => c.path.endsWith("/git/trees"))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("builds on the existing tree, so publishing one page keeps the rest", async () => {
    const { fetchImpl, calls } = github(commitRoutes("tree1", "tree2"));
    await commitFiles("t", "AttractAcqSites", "attract-acquisition-site", "main", files, "m", fetchImpl);
    const tree = calls.find((c) => c.path.endsWith("/git/trees"))?.body as Record<string, unknown>;
    expect(tree.base_tree).toBe("tree1");
  });

  it("sends bytes that survive the round trip exactly", async () => {
    const { fetchImpl, calls } = github(commitRoutes("tree1", "tree2"));
    await commitFiles(
      "t", "AttractAcqSites", "attract-acquisition-site", "main",
      [{ path: "index.html", content: "Céad míle fáilte — £20" }], "m", fetchImpl,
    );
    const blob = calls.find((c) => c.path.endsWith("/git/blobs"))?.body as { content: string; encoding: string };
    expect(Buffer.from(blob.content, "base64").toString("utf8")).toBe("Céad míle fáilte — £20");
    expect(blob.encoding).toBe("base64");
  });

  it("does nothing when the site is already exactly this", async () => {
    // The property that makes publishing safe to retry: a repeat of a publish
    // that already succeeded is a no-op, not an empty commit.
    const { fetchImpl, calls } = github(commitRoutes("same", "same"));
    const result = await commitFiles(
      "t", "AttractAcqSites", "attract-acquisition-site", "main", files, "m", fetchImpl,
    );
    expect(result).toEqual({ commit: "head1", changed: false });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/git/commits") && c.method === "POST")).toBe(false);
  });

  it("refuses a branch with nothing on it rather than committing into the void", async () => {
    const { fetchImpl } = github({
      [`GET ${BASE}/git/ref/heads/main`]: { body: { object: {} } },
    });
    const err = await commitFiles(
      "t", "AttractAcqSites", "attract-acquisition-site", "main", files, "m", fetchImpl,
    ).catch((e) => e);
    // The prose lives on safeMessage; Error.message is a fixed token so that a
    // caller who renders it by accident cannot leak anything.
    expect((err as GitHubApiError).safeMessage).toMatch(/no commit to build on/i);
  });
});

describe("GitHub Pages", () => {
  it("asks for the branch build, which needs no Actions workflow", async () => {
    const { fetchImpl, calls } = github({
      [`POST ${BASE}/pages`]: {
        status: 201,
        body: { status: "building", html_url: "https://x.github.io/y/", build_type: "legacy", source: { branch: "main", path: "/" } },
      },
    });
    const pages = await enablePages("t", "AttractAcqSites", "attract-acquisition-site", "main", fetchImpl);
    expect(pages.buildType).toBe("legacy");
    expect(pages.sourcePath).toBe("/");

    const sent = calls[0]?.body as Record<string, unknown>;
    // The reason the App needs no `workflows` permission.
    expect(sent.build_type).toBe("legacy");
    expect(sent.source).toEqual({ branch: "main", path: "/" });
  });

  it("treats already-enabled as success and reads the site back", async () => {
    // Re-provisioning must not fail on a site that is already live.
    const { fetchImpl } = github({
      [`POST ${BASE}/pages`]: { status: 409 },
      [`GET ${BASE}/pages`]: {
        body: { status: "built", html_url: "https://x.github.io/y/", build_type: "legacy", source: { branch: "main", path: "/" } },
      },
    });
    const pages = await enablePages("t", "AttractAcqSites", "attract-acquisition-site", "main", fetchImpl);
    expect(pages.status).toBe("built");
    expect(pages.url).toBe("https://x.github.io/y/");
  });

  it("reports no site rather than failing when Pages was never turned on", async () => {
    const { fetchImpl } = github({});
    expect(await getPages("t", "AttractAcqSites", "attract-acquisition-site", fetchImpl)).toBeNull();
  });

  it("reads the build, which is what 'published' actually means", async () => {
    // A commit means GitHub took the bytes. Only a successful build means the
    // page is being served.
    const { fetchImpl } = github({
      [`GET ${BASE}/pages/builds/latest`]: {
        body: { status: "built", commit: "commit2", error: { message: null } },
      },
    });
    const build = await latestPagesBuild("t", "AttractAcqSites", "attract-acquisition-site", fetchImpl);
    expect(build).toEqual({ status: "built", commit: "commit2", error: null });
  });

  it("surfaces a failed build instead of calling it published", async () => {
    const { fetchImpl } = github({
      [`GET ${BASE}/pages/builds/latest`]: {
        body: { status: "errored", commit: "commit2", error: { message: "Page build failed." } },
      },
    });
    const build = await latestPagesBuild("t", "AttractAcqSites", "attract-acquisition-site", fetchImpl);
    expect(build?.status).toBe("errored");
    expect(build?.error).toBe("Page build failed.");
  });
});

describe("what a failure tells the caller", () => {
  it("carries the status and never the response body", async () => {
    // GitHub echoes request detail into error bodies, and detail about a
    // request made with an installation token is not for a browser.
    const { fetchImpl } = github({
      "POST /orgs/Org/repos": { status: 422, body: { message: "name already exists on this account", token: "ghs_leak" } },
    });
    const err = await createOrgRepo("t", "Org", "r", "d", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(422);
    // Assert on the sentence a caller would actually show, not on the token —
    // checking Error.message would pass whatever the body contained.
    const shown = (err as GitHubApiError).safeMessage;
    expect(shown).toContain("422");
    expect(shown).not.toContain("ghs_leak");
    expect(shown).not.toContain("already exists on this account");
    expect(JSON.stringify(err)).not.toContain("ghs_leak");
  });
});
