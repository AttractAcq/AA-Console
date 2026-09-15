// Provisioning a site, and publishing a page onto it.
//
// This is the part Phase 10 exists for: AA creating the repository and putting
// a page live, rather than a person doing it by hand and calling the
// infrastructure proven. Everything outward-facing it needs lives in
// github/repos.ts; everything it must remember lives behind SiteStore.
//
// The database is an interface rather than a Supabase client because what is
// worth testing here is the ORDER and the RECOVERY — that a failed Pages build
// is not recorded as published, that a second publish of the same bytes is not
// a second commit, that a repository is never created twice. Those are
// properties of the sequence, and a sequence is only testable when the IO
// around it can be replaced.
//
// Every step is written to survive being run again. Provisioning is how a
// half-finished site gets finished: it looks before it creates, commits a shell
// that may already be identical, and treats Pages already being on as success.

import type { GitHubAppConfig } from "../github/app-auth.js";
import { mintInstallationToken, resolveInstallation } from "../github/app-auth.js";
import {
  commitFiles,
  createOrgRepo,
  enablePages,
  getRepo,
  latestPagesBuild,
} from "../github/repos.js";
import { shellFiles, shellPaths } from "./shell.js";
import { pagePath, publicUrl, embedSnippet, injectWidget } from "./paths.js";

export interface InstallationRecord {
  installationId: number;
  accountLogin: string;
  accountType: string;
}

export interface SiteRepoRecord {
  id: string;
  clientId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  pagesUrl: string | null;
  status: string;
}

export interface PageRecord {
  id: string;
  clientId: string;
  title: string;
  html: string | null;
  siteRepositoryId: string | null;
  sitePath: string | null;
}

/** A deployment row as stored. The store does not pick which one to embed. */
export interface PageDeploymentRecord {
  publicId: string;
  enabled: boolean;
  createdAt: string;
}

/** What provisioning and publishing need to remember. */
export interface SiteStore {
  upsertInstallation(record: InstallationRecord): Promise<string>;
  clientName(clientId: string): Promise<string>;
  findRepo(clientId: string, owner: string, repo: string): Promise<SiteRepoRecord | null>;
  readyRepoForClient(clientId: string): Promise<SiteRepoRecord | null>;
  repoById(id: string): Promise<SiteRepoRecord | null>;
  saveRepo(record: {
    id: string | null;
    clientId: string;
    installationRowId: string;
    githubRepositoryId: number;
    owner: string;
    repo: string;
    defaultBranch: string;
    pagesUrl: string | null;
    status: string;
    lastError: string | null;
  }): Promise<SiteRepoRecord>;
  loadPage(pageId: string): Promise<PageRecord | null>;
  /** Deployments for this page, as stored. Newest-first is typical; the caller decides. */
  deploymentsForPage(pageId: string): Promise<PageDeploymentRecord[]>;
  markPublishing(pageId: string, repoId: string, path: string): Promise<void>;
  markPublished(pageId: string, fields: { commit: string; url: string; at: Date }): Promise<void>;
  markPublishFailed(pageId: string, error: string): Promise<void>;
}

export interface SiteConfig {
  /** The organisation AA provisions client repositories into. */
  org: string;
  /** Canonical public runtime host, written into every repo's shell. */
  runtimeBase: string;
}

export interface Deps {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Pauses between Pages build polls; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Record which installation AA is acting through.
 *
 * The console gates on this row, and until now nothing wrote it — so the Sites
 * tab asked a table that was always empty while the Settings tab asked GitHub
 * and got the truth. One of them had to become the other; this is the writer
 * that makes the row a fact rather than a placeholder.
 */
export async function syncInstallation(
  store: SiteStore,
  app: GitHubAppConfig,
  deps: Deps = {},
): Promise<{ rowId: string; record: InstallationRecord }> {
  const info = await resolveInstallation(app, deps.fetchImpl ?? fetch);
  const record: InstallationRecord = {
    installationId: info.installationId,
    accountLogin: info.account,
    accountType: info.targetType,
  };
  const rowId = await store.upsertInstallation(record);
  return { rowId, record };
}

export interface ProvisionResult {
  repo: SiteRepoRecord;
  /** False when the repository already existed and was adopted. */
  created: boolean;
  pagesUrl: string | null;
}

/**
 * Create — or adopt — a client's site repository and make it Pages-ready.
 *
 * Adoption matters as much as creation. A run that created the repository and
 * then failed at Pages must be fixable by pressing the button again, and a
 * second create would fail on the name and strand the first attempt forever.
 */
export async function provisionSite(
  store: SiteStore,
  app: GitHubAppConfig,
  site: SiteConfig,
  request: { clientId: string; repo: string },
  deps: Deps = {},
): Promise<ProvisionResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { rowId, record } = await syncInstallation(store, app, deps);

  // A GitHub App cannot create a repository on a personal account, so this is
  // refused before anything is written rather than failing mid-sequence with a
  // GitHub error nobody can act on.
  if (record.accountType !== "Organization") {
    throw new Error(
      `The GitHub App is installed on ${record.accountLogin}, which is a ${record.accountType} account. Creating repositories needs an Organization installation.`,
    );
  }

  const token = (await mintInstallationToken(app, record.installationId, fetchImpl)).token;
  const clientName = await store.clientName(request.clientId);

  const existing = await getRepo(token, site.org, request.repo, fetchImpl);
  const repo = existing ?? (await createOrgRepo(
    token, site.org, request.repo, `${clientName} — website, managed by AA Console`, fetchImpl,
  ));

  // The shell is committed on every provision. When it is already exactly this,
  // commitFiles reports no change and writes nothing.
  await commitFiles(
    token,
    repo.owner,
    repo.repo,
    repo.defaultBranch,
    shellFiles({ clientName, repo: repo.repo, runtimeBase: site.runtimeBase }),
    "Set up the AA site shell",
    fetchImpl,
  );

  const pages = await enablePages(token, repo.owner, repo.repo, repo.defaultBranch, fetchImpl);

  const known = await store.findRepo(request.clientId, repo.owner, repo.repo);
  const saved = await store.saveRepo({
    id: known?.id ?? null,
    clientId: request.clientId,
    installationRowId: rowId,
    githubRepositoryId: repo.id,
    owner: repo.owner,
    repo: repo.repo,
    defaultBranch: repo.defaultBranch,
    pagesUrl: pages.url,
    status: "ready",
    lastError: null,
  });

  return { repo: saved, created: existing === null, pagesUrl: pages.url };
}

export interface PublishResult {
  url: string;
  commit: string;
  /** False when the page was already live as exactly these bytes. */
  changed: boolean;
}

/**
 * Put an approved page live.
 *
 * "Live" is deliberately strict: the commit being accepted is not publication,
 * because a Pages build can still fail. The page is only recorded as published
 * once a build has run and succeeded, and a failure is written to the row with
 * its reason rather than left as a status nobody can explain.
 */
export async function publishPage(
  store: SiteStore,
  app: GitHubAppConfig,
  site: SiteConfig,
  pageId: string,
  deps: Deps = {},
): Promise<PublishResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const page = await store.loadPage(pageId);
  if (!page) throw new Error("That page no longer exists.");
  if (!page.html || page.html.trim().length === 0) {
    throw new Error("That page has no built HTML yet. Run the Page Builder first.");
  }

  const { record } = await syncInstallation(store, app, deps);

  const repo = page.siteRepositoryId
    ? await store.repoById(page.siteRepositoryId)
    : await store.readyRepoForClient(page.clientId);
  if (!repo) throw new Error("This client has no website repository yet. Create one first.");
  if (!repo.pagesUrl) throw new Error("That repository has no Pages URL yet. Provision it again.");

  // Derived from the title, never taken raw: a path out of user input could
  // escape its directory or land on top of the shell.
  const path = page.sitePath ?? pagePath(page.title);
  if (!path) throw new Error("That page's title does not make a usable URL. Rename it.");
  if (shellPaths().includes(path) && path !== "index.html") {
    throw new Error(`A page cannot be published over ${path}, which the site shell owns.`);
  }

  await store.markPublishing(pageId, repo.id, path);

  try {
    const token = (await mintInstallationToken(app, record.installationId, fetchImpl)).token;
    const html = await htmlToPublish(store, site, pageId, page.html);
    const commit = await commitFiles(
      token, repo.owner, repo.repo, repo.defaultBranch,
      [{ path, content: html }],
      `Publish ${page.title}`,
      fetchImpl,
    );

    const build = await waitForPagesBuild(token, repo.owner, repo.repo, commit.commit, deps);
    if (build.status !== "built") {
      throw new Error(build.error ?? `GitHub Pages did not build this page (${build.status ?? "no build"}).`);
    }

    const url = publicUrl(repo.pagesUrl, path);
    await store.markPublished(pageId, { commit: commit.commit, url, at: now() });
    return { url, commit: commit.commit, changed: commit.changed };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publishing failed.";
    await store.markPublishFailed(pageId, message);
    throw error;
  }
}

/**
 * Page HTML as it should go into the commit: original bytes, plus the widget
 * if this page has a sales-agent deployment.
 *
 * Prefers the enabled deployment — that is the agent visitors will actually
 * reach. Otherwise the most recent attachment, so attach-then-republish still
 * embeds the public_id while Enable stays a separate switch. The runtime
 * refuses a disabled deployment on every request.
 */
async function htmlToPublish(
  store: SiteStore,
  site: SiteConfig,
  pageId: string,
  html: string,
): Promise<string> {
  const deployments = await store.deploymentsForPage(pageId);
  const publicId = publicIdToEmbed(deployments);
  if (!publicId) return html;
  return injectWidget(html, embedSnippet(publicId, site.runtimeBase));
}

export function publicIdToEmbed(deployments: PageDeploymentRecord[]): string | null {
  if (deployments.length === 0) return null;
  const enabled = deployments.find((d) => d.enabled);
  if (enabled) return enabled.publicId;
  const newest = [...deployments].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return newest[0]?.publicId ?? null;
}

/**
 * Wait for the Pages build that carries this commit.
 *
 * Bounded, because a build that never arrives must eventually be reported as a
 * failure rather than holding a page in `publishing` forever. A build for an
 * older commit is not this one, so it is not accepted as an answer.
 */
async function waitForPagesBuild(
  token: string,
  owner: string,
  repo: string,
  commit: string,
  deps: Deps,
): Promise<{ status: string | null; error: string | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts = 20;

  for (let i = 0; i < attempts; i++) {
    const build = await latestPagesBuild(token, owner, repo, fetchImpl);
    if (build && build.commit === commit && build.status !== "building") {
      return { status: build.status, error: build.error };
    }
    await sleep(3000);
  }
  return { status: "timed out", error: "GitHub Pages did not finish building in time." };
}
