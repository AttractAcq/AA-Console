// What has to be true before a site can be provisioned, a page published, or an
// agent put in front of visitors.
//
// Pure and separate from the panel because every one of these is a reason a
// button is disabled, and a disabled button with no stated reason is the most
// annoying thing a tool can do. Each blocker is a sentence a person can act on.
//
// None of this is a security boundary — the database and the public runtime
// enforce the same rules independently. This exists so nobody has to press a
// button to discover why it will not work.

export type Installation = { id: string; account_login: string; status: string };

export type SiteRepo = {
  id: string;
  owner: string;
  repo: string;
  status: string;
  pages_url: string | null;
};

export type ApprovableAgent = {
  id: string;
  name: string;
  status: string;
  built_at: string | null;
  approved_at: string | null;
};

export type PublishablePage = {
  id: string;
  title: string;
  html: string | null;
  publish_status: string;
  published_url: string | null;
  site_repository_id: string | null;
};

/** Why a website repository cannot be created yet, or null. */
export function provisionBlocker(installations: Installation[]): string | null {
  const active = installations.filter((i) => i.status === "active");
  if (active.length === 0) {
    return "Connect the AA GitHub App before creating a website. Nothing can be published without it.";
  }
  return null;
}

/**
 * Why this page cannot be published, or null.
 *
 * Order matters: the earliest missing thing is the one to say. Telling someone
 * to pick a repository when the page has not been written yet sends them to the
 * wrong screen.
 */
export function publishBlocker(page: PublishablePage, repos: SiteRepo[]): string | null {
  if (!page.html) return "This page has not been built yet — run the page agent first.";
  const ready = repos.filter((r) => r.status === "ready");
  if (ready.length === 0) return "No website is ready for this client yet.";
  return null;
}

/**
 * Why this agent cannot be put in front of visitors, or null.
 *
 * Approval is deliberately separate from being live. Being live is an
 * intention; being approved is a person having read what the agent will say and
 * accepted it. The public runtime re-checks both, so this is a courtesy rather
 * than the gate itself.
 */
export function deployBlocker(agent: ApprovableAgent, page: PublishablePage): string | null {
  if (!agent.built_at) return "This agent has not been built yet.";
  if (!agent.approved_at) return "Approve this agent for public use first — read what it will say.";
  if (agent.status !== "live") return "This agent is not live.";
  if (page.publish_status !== "published" || !page.published_url) {
    return "Publish the page before attaching an agent to it.";
  }
  return null;
}

/** Agents a person could choose from, with the reason any of them cannot be chosen. */
export function deployableAgents(
  agents: ApprovableAgent[],
  page: PublishablePage,
): Array<{ agent: ApprovableAgent; blocker: string | null }> {
  return agents.map((agent) => ({ agent, blocker: deployBlocker(agent, page) }));
}

/**
 * The origin a deployment on this page must accept.
 *
 * Derived from the published URL rather than typed by a person: a typo in an
 * allowed origin is a widget that silently never works, and the published URL
 * is already the truth.
 */
export function originForPage(publishedUrl: string | null): string | null {
  if (!publishedUrl) return null;
  try {
    const url = new URL(publishedUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** A short, honest description of where a repository has got to. */
export function repoStateLabel(repo: SiteRepo): string {
  switch (repo.status) {
    case "provisioning":
      return "Being created";
    case "ready":
      return repo.pages_url ? "Live" : "Created, Pages not configured";
    case "failed":
      return "Failed";
    case "archived":
      return "Archived";
    default:
      return repo.status;
  }
}
