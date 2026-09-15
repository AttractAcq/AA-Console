// The SiteStore, against the real database.
//
// Deliberately thin: every method is one statement and no method decides
// anything. All the judgement — what order to do things in, when a page counts
// as published, whether to create or adopt — lives in provision.ts, where it
// can be tested without a database.
//
// The runtime holds the service-role key, so these run past RLS. That is the
// same trust the rest of the runtime already has, and the reason each method
// takes explicit ids rather than filtering on anything ambient.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  InstallationRecord,
  PageRecord,
  SiteRepoRecord,
  SiteStore,
} from "./provision.js";

function repoRow(row: Record<string, unknown>): SiteRepoRecord {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    owner: String(row.owner),
    repo: String(row.repo),
    defaultBranch: String(row.default_branch ?? "main"),
    pagesUrl: row.pages_url ? String(row.pages_url) : null,
    status: String(row.status),
  };
}

const REPO_COLUMNS = "id, client_id, owner, repo, default_branch, pages_url, status";

export function supabaseSiteStore(sb: SupabaseClient): SiteStore {
  return {
    async upsertInstallation(record: InstallationRecord): Promise<string> {
      // Keyed on GitHub's own installation id: reinstalling produces a new one,
      // and the old row should stay as the history of a site already published.
      const { data, error } = await sb
        .from("github_app_installations")
        .upsert(
          {
            installation_id: record.installationId,
            account_login: record.accountLogin,
            account_type: record.accountType,
            status: "active",
            last_checked_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "installation_id" },
        )
        .select("id")
        .single();
      if (error) throw new Error(`Could not record the GitHub installation: ${error.message}`);
      return String(data.id);
    },

    async clientName(clientId: string): Promise<string> {
      const { data } = await sb.from("clients").select("name").eq("id", clientId).maybeSingle();
      return (data?.name as string | undefined) ?? "this business";
    },

    async findRepo(clientId, owner, repo) {
      const { data } = await sb
        .from("client_site_repositories")
        .select(REPO_COLUMNS)
        .eq("client_id", clientId)
        .eq("owner", owner)
        .eq("repo", repo)
        .maybeSingle();
      return data ? repoRow(data as Record<string, unknown>) : null;
    },

    async readyRepoForClient(clientId) {
      const { data } = await sb
        .from("client_site_repositories")
        .select(REPO_COLUMNS)
        .eq("client_id", clientId)
        .eq("status", "ready")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data ? repoRow(data as Record<string, unknown>) : null;
    },

    async repoById(id) {
      const { data } = await sb
        .from("client_site_repositories")
        .select(REPO_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      return data ? repoRow(data as Record<string, unknown>) : null;
    },

    async saveRepo(record) {
      const fields = {
        client_id: record.clientId,
        installation_id: record.installationRowId,
        github_repository_id: record.githubRepositoryId,
        owner: record.owner,
        repo: record.repo,
        default_branch: record.defaultBranch,
        pages_path: "/",
        pages_url: record.pagesUrl,
        status: record.status,
        last_error: record.lastError,
        provisioned_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const query = record.id
        ? sb.from("client_site_repositories").update(fields).eq("id", record.id)
        : sb.from("client_site_repositories").insert(fields);
      const { data, error } = await query.select(REPO_COLUMNS).single();
      if (error) throw new Error(`Could not record the site repository: ${error.message}`);
      return repoRow(data as Record<string, unknown>);
    },

    async loadPage(pageId): Promise<PageRecord | null> {
      const { data } = await sb
        .from("client_pages")
        .select("id, client_id, title, html, site_repository_id, site_path")
        .eq("id", pageId)
        .maybeSingle();
      if (!data) return null;
      const row = data as Record<string, unknown>;
      return {
        id: String(row.id),
        clientId: String(row.client_id),
        title: String(row.title ?? ""),
        html: row.html ? String(row.html) : null,
        siteRepositoryId: row.site_repository_id ? String(row.site_repository_id) : null,
        sitePath: row.site_path ? String(row.site_path) : null,
      };
    },

    async markPublishing(pageId, repoId, path) {
      // The path is written here, before the commit, which is what makes it
      // stable: every later publish of this page goes to the same URL even if
      // somebody renames the page.
      const { error } = await sb
        .from("client_pages")
        .update({
          site_repository_id: repoId,
          site_path: path,
          publish_status: "publishing",
          publish_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pageId);
      if (error) throw new Error(`Could not start publishing: ${error.message}`);
    },

    async markPublished(pageId, fields) {
      const { error } = await sb
        .from("client_pages")
        .update({
          publish_status: "published",
          published_url: fields.url,
          published_commit: fields.commit,
          published_at: fields.at.toISOString(),
          publish_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pageId);
      if (error) throw new Error(`Could not record the publish: ${error.message}`);
    },

    async markPublishFailed(pageId, message) {
      // Recorded rather than thrown away: "Publish failed" with no reason is
      // the least actionable thing a screen can say.
      await sb
        .from("client_pages")
        .update({
          publish_status: "failed",
          publish_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pageId);
    },
  };
}
