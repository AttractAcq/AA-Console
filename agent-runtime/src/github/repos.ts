// The GitHub operations a site repository needs.
//
// Everything here takes a short-lived installation token as its first argument
// and nothing here stores one. Minting is cheap; a stored token turns a
// one-hour exposure into a permanent one, and that rule does not bend just
// because a call site would be more convenient.
//
// ONE LIMITATION SHAPES THIS MODULE. A GitHub App cannot create a repository on
// a personal user account: POST /user/repos accepts OAuth and classic PATs
// only, and no other endpoint gives an App that power. Creation therefore goes
// through POST /orgs/{org}/repos and requires the App to be installed on an
// ORGANISATION. Everything else — committing, Pages, verification — works on a
// user installation perfectly well, which is why creation is the only function
// here that cares who owns the account.
//
// Commits go through the Git Data API rather than the Contents API because a
// site is written as a set: shell plus page. Blob, tree, commit, ref is one
// atomic change; the Contents API is one request per file, and a failure
// halfway leaves a repository holding half a site.

import { GitHubApiError } from "./app-auth.js";

const API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "AA-Console-Sites",
    "Content-Type": "application/json",
  };
}

/**
 * One GitHub call.
 *
 * `allow` lists statuses the caller treats as answers rather than failures —
 * 404 for "does it exist", 409 for "Pages was already on". Anything else
 * becomes a GitHubApiError carrying the status and never the body, which
 * echoes request detail.
 */
async function gh(
  token: string,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
  allow: number[] = [],
): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  if (!res.ok && !allow.includes(res.status)) {
    throw new GitHubApiError(res.status, `GitHub refused ${method} ${path} (HTTP ${res.status}).`);
  }
  return { status: res.status, body: parsed };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface RepoInfo {
  id: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  htmlUrl: string;
  private: boolean;
}

function toRepoInfo(body: unknown): RepoInfo {
  const r = (body ?? {}) as Record<string, unknown>;
  const owner = (r.owner as Record<string, unknown> | undefined) ?? {};
  return {
    id: Number(r.id),
    owner: String(owner.login ?? ""),
    repo: String(r.name ?? ""),
    defaultBranch: String(r.default_branch ?? "main"),
    htmlUrl: String(r.html_url ?? ""),
    private: r.private === true,
  };
}

/** The repository, or null when there is not one. */
export async function getRepo(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoInfo | null> {
  const { status, body } = await gh(token, "GET", `/repos/${owner}/${repo}`, undefined, fetchImpl, [404]);
  if (status === 404) return null;
  return toRepoInfo(body);
}

/**
 * Create a site repository in an organisation.
 *
 * `auto_init` matters: branch-based Pages needs a branch, and a repository with
 * no commits has none. Initialising here means the first real commit has a
 * parent and the ordinary commit path works from the start.
 *
 * Public, deliberately. GitHub Pages does not serve a private repository on a
 * free plan, and a site nobody can load is not a published site.
 */
export async function createOrgRepo(
  token: string,
  org: string,
  repo: string,
  description: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RepoInfo> {
  const { body } = await gh(
    token,
    "POST",
    `/orgs/${org}/repos`,
    { name: repo, description, private: false, auto_init: true, has_issues: false, has_wiki: false },
    fetchImpl,
  );
  return toRepoInfo(body);
}

export interface RepoFile {
  path: string;
  content: string;
}

export interface CommitResult {
  /** The commit the branch now points at. */
  commit: string;
  /** False when the tree already matched, so nothing was written. */
  changed: boolean;
}

/**
 * Write a set of files as one commit.
 *
 * Returns `changed: false` when the resulting tree is identical to the one
 * already on the branch. That is what makes publishing safe to retry: a repeat
 * of a publish that already succeeded is a no-op rather than an empty commit,
 * and the caller can tell the difference.
 */
export async function commitFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  files: RepoFile[],
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CommitResult> {
  if (files.length === 0) throw new Error("A commit needs at least one file.");
  const base = `/repos/${owner}/${repo}`;

  const ref = await gh(token, "GET", `${base}/git/ref/heads/${branch}`, undefined, fetchImpl);
  const headSha = String(((ref.body as Record<string, unknown>)?.object as Record<string, unknown>)?.sha ?? "");
  if (!headSha) throw new GitHubApiError(null, "The branch has no commit to build on.");

  const headCommit = await gh(token, "GET", `${base}/git/commits/${headSha}`, undefined, fetchImpl);
  const baseTree = String(((headCommit.body as Record<string, unknown>)?.tree as Record<string, unknown>)?.sha ?? "");

  // Base64 so a page's bytes survive exactly — accented copy, symbols, any of it.
  const blobs = await Promise.all(
    files.map(async (file) => {
      const created = await gh(
        token,
        "POST",
        `${base}/git/blobs`,
        { content: Buffer.from(file.content, "utf8").toString("base64"), encoding: "base64" },
        fetchImpl,
      );
      return { path: file.path, sha: String((created.body as Record<string, unknown>)?.sha ?? "") };
    }),
  );

  const tree = await gh(
    token,
    "POST",
    `${base}/git/trees`,
    {
      base_tree: baseTree,
      tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
    },
    fetchImpl,
  );
  const treeSha = String((tree.body as Record<string, unknown>)?.sha ?? "");

  if (treeSha === baseTree) return { commit: headSha, changed: false };

  const commit = await gh(
    token,
    "POST",
    `${base}/git/commits`,
    { message, tree: treeSha, parents: [headSha] },
    fetchImpl,
  );
  const commitSha = String((commit.body as Record<string, unknown>)?.sha ?? "");

  await gh(token, "PATCH", `${base}/git/refs/heads/${branch}`, { sha: commitSha }, fetchImpl);
  return { commit: commitSha, changed: true };
}

export interface PagesInfo {
  /** GitHub's own word: building, built, errored. */
  status: string | null;
  url: string | null;
  buildType: string | null;
  sourceBranch: string | null;
  sourcePath: string | null;
}

function toPagesInfo(body: unknown): PagesInfo {
  const p = (body ?? {}) as Record<string, unknown>;
  const source = (p.source as Record<string, unknown> | undefined) ?? {};
  return {
    status: p.status === null || p.status === undefined ? null : String(p.status),
    url: p.html_url ? String(p.html_url) : null,
    buildType: p.build_type ? String(p.build_type) : null,
    sourceBranch: source.branch ? String(source.branch) : null,
    sourcePath: source.path ? String(source.path) : null,
  };
}

/** The Pages site, or null when Pages has never been turned on. */
export async function getPages(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PagesInfo | null> {
  const { status, body } = await gh(token, "GET", `/repos/${owner}/${repo}/pages`, undefined, fetchImpl, [404]);
  if (status === 404) return null;
  return toPagesInfo(body);
}

/**
 * Turn Pages on, serving the branch root.
 *
 * `build_type: "legacy"` is the branch-based build, and the reason this whole
 * path needs no Actions workflow — and therefore no `workflows` permission on
 * the App. A 409 means somebody already enabled it, which is a success for our
 * purposes: the site exists, so read it back and carry on.
 */
export async function enablePages(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PagesInfo> {
  const { status, body } = await gh(
    token,
    "POST",
    `/repos/${owner}/${repo}/pages`,
    { build_type: "legacy", source: { branch, path: "/" } },
    fetchImpl,
    [409],
  );
  if (status === 409) {
    const existing = await getPages(token, owner, repo, fetchImpl);
    if (!existing) throw new GitHubApiError(409, "GitHub says Pages exists and will not describe it.");
    return existing;
  }
  return toPagesInfo(body);
}

export interface PagesBuild {
  status: string | null;
  error: string | null;
  commit: string | null;
}

/**
 * The most recent Pages build.
 *
 * This is the difference between "we pushed a commit" and "the site is live".
 * A commit only means GitHub accepted the bytes; a page is not published until
 * a build has run and succeeded, and builds do fail.
 */
export async function latestPagesBuild(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PagesBuild | null> {
  const { status, body } = await gh(
    token,
    "GET",
    `/repos/${owner}/${repo}/pages/builds/latest`,
    undefined,
    fetchImpl,
    [404],
  );
  if (status === 404) return null;
  const b = (body ?? {}) as Record<string, unknown>;
  const error = (b.error as Record<string, unknown> | undefined) ?? {};
  return {
    status: b.status ? String(b.status) : null,
    error: error.message ? String(error.message) : null,
    commit: b.commit ? String(b.commit) : null,
  };
}
