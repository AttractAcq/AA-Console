import { type Route, handleMcpContent } from "./content-route.js";
import { UUID } from "./http.js";

function uuidOf(body: Record<string, unknown>, key: string): string | undefined | false {
  const value = body[key];
  if (value === undefined) return undefined;
  return typeof value === "string" && UUID.test(value) ? value : false;
}

function limitOf(body: Record<string, unknown>): number | undefined | false {
  const limit = body.limit;
  if (limit === undefined) return undefined;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
    return false;
  return limit;
}

function subset(body: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k));
}

const routes: Record<string, Route> = {
  "/internal/mcp/engineering/create-issue": {
    rpc: "mcp_engineering_create_issue",
    kind: "write",
    maxBodyBytes: 16384,
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const title = body.title;
      const notes = body.notes;
      if (
        client_id === undefined ||
        client_id === false ||
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 200 ||
        (notes !== null && (typeof notes !== "string" || notes.length > 2000)) ||
        !subset(body, ["client_id", "title", "notes"])
      )
        return;
      return { p_bot_id: null, p_client_id: client_id, p_title: title, p_notes: notes };
    },
  },
  "/internal/mcp/engineering/get-issue": {
    rpc: "mcp_engineering_get_issue",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const issue_id = uuidOf(body, "issue_id");
      if (
        client_id === undefined ||
        client_id === false ||
        issue_id === undefined ||
        issue_id === false ||
        !subset(body, ["client_id", "issue_id"])
      )
        return;
      return { p_bot_id: null, p_client_id: client_id, p_issue_id: issue_id };
    },
  },
  "/internal/mcp/engineering/get-release-status": {
    rpc: "mcp_engineering_get_release_status",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const after = uuidOf(body, "after");
      const page_id = uuidOf(body, "page_id");
      const limit = limitOf(body);
      if (
        client_id === undefined ||
        client_id === false ||
        after === false ||
        page_id === false ||
        limit === false ||
        !subset(body, ["client_id", "limit", "after", "page_id"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(after ? { p_after: after } : {}),
        ...(page_id ? { p_page_id: page_id } : {}),
      };
    },
  },
  "/internal/mcp/engineering/get-deployment-status": {
    rpc: "mcp_engineering_get_deployment_status",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const after = uuidOf(body, "after");
      const job_id = uuidOf(body, "job_id");
      const limit = limitOf(body);
      if (
        client_id === undefined ||
        client_id === false ||
        after === false ||
        job_id === false ||
        limit === false ||
        !subset(body, ["client_id", "limit", "after", "job_id"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(after ? { p_after: after } : {}),
        ...(job_id ? { p_job_id: job_id } : {}),
      };
    },
  },
};

export const handleMcpEngineering: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, routes);
