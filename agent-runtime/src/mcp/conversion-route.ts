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
function textOf(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): string | undefined | false {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length < min || value.length > max) return false;
  return value;
}

function findingIdsOf(body: Record<string, unknown>): string[] | undefined | false {
  const value = body.finding_ids;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return false;
  if (value.some((id) => typeof id !== "string" || !UUID.test(id))) return false;
  return value as string[];
}

const routes: Record<string, Route> = {
  "/internal/mcp/conversion/list-pages": {
    rpc: "mcp_conversion",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const after = uuidOf(body, "after");
      const limit = limitOf(body);
      const page_type = body.page_type;
      if (
        client_id === undefined ||
        client_id === false ||
        after === false ||
        limit === false ||
        (page_type !== undefined && page_type !== "landing" && page_type !== "offer") ||
        !subset(body, ["client_id", "limit", "after", "page_type"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        p_action: "list_pages",
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(after ? { p_after: after } : {}),
        ...(typeof page_type === "string" ? { p_page_type: page_type } : {}),
      };
    },
  },
};

function pageRead(action: string, extra: string[] = []): Route {
  return {
    rpc: "mcp_conversion",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const page_id = uuidOf(body, "page_id");
      if (
        client_id === undefined ||
        client_id === false ||
        page_id === undefined ||
        page_id === false ||
        !subset(body, ["client_id", "page_id", ...extra])
      )
        return;
      return { p_bot_id: null, p_client_id: client_id, p_action: action, p_page_id: page_id };
    },
  };
}

routes["/internal/mcp/conversion/get-page"] = pageRead("get_page");
routes["/internal/mcp/conversion/get-performance"] = pageRead("get_performance");

function pageQueue(action: string): Route {
  return {
    rpc: "mcp_conversion",
    kind: "queue",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const page_id = uuidOf(body, "page_id");
      if (
        client_id === undefined ||
        client_id === false ||
        page_id === undefined ||
        page_id === false ||
        !subset(body, ["client_id", "page_id"])
      )
        return;
      return { p_bot_id: null, p_client_id: client_id, p_action: action, p_page_id: page_id };
    },
  };
}
routes["/internal/mcp/conversion/generate-structure"] = pageQueue("generate_structure");
routes["/internal/mcp/conversion/generate-copy"] = pageQueue("generate_copy");
routes["/internal/mcp/conversion/audit-page"] = pageQueue("audit_page");

routes["/internal/mcp/conversion/create-page"] = {
  rpc: "mcp_conversion",
  kind: "queue",
  parse(body) {
    const client_id = uuidOf(body, "client_id");
    const title = textOf(body, "title", 1, 200);
    const brief = textOf(body, "brief", 1, 4000);
    const campaign_id = uuidOf(body, "campaign_id");
    const page_type = body.page_type;
    if (
      client_id === undefined ||
      client_id === false ||
      title === undefined ||
      title === false ||
      brief === undefined ||
      brief === false ||
      campaign_id === false ||
      (page_type !== undefined && page_type !== "landing" && page_type !== "offer") ||
      !subset(body, ["client_id", "title", "brief", "page_type", "campaign_id"])
    )
      return;
    return {
      p_bot_id: null,
      p_client_id: client_id,
      p_action: "create_page",
      p_title: title,
      p_brief: brief,
      ...(typeof page_type === "string" ? { p_page_type: page_type } : {}),
      ...(campaign_id ? { p_campaign_id: campaign_id } : {}),
    };
  },
};

routes["/internal/mcp/conversion/request-approval"] = {
  rpc: "mcp_conversion",
  kind: "write",
  parse(body) {
    const client_id = uuidOf(body, "client_id");
    const page_id = uuidOf(body, "page_id");
    const summary = textOf(body, "summary", 1, 4000);
    if (
      client_id === undefined ||
      client_id === false ||
      page_id === undefined ||
      page_id === false ||
      summary === false ||
      !subset(body, ["client_id", "page_id", "summary"])
    )
      return;
    return {
      p_bot_id: null,
      p_client_id: client_id,
      p_action: "request_approval",
      p_page_id: page_id,
      ...(summary ? { p_summary: summary } : {}),
    };
  },
};

routes["/internal/mcp/conversion/revise-page"] = {
  rpc: "mcp_conversion",
  kind: "queue",
  parse(body) {
    const client_id = uuidOf(body, "client_id");
    const page_id = uuidOf(body, "page_id");
    const finding_ids = findingIdsOf(body);
    if (
      client_id === undefined ||
      client_id === false ||
      page_id === undefined ||
      page_id === false ||
      finding_ids === undefined ||
      finding_ids === false ||
      !subset(body, ["client_id", "page_id", "finding_ids"])
    )
      return;
    return {
      p_bot_id: null,
      p_client_id: client_id,
      p_action: "revise_page",
      p_page_id: page_id,
      p_finding_ids: finding_ids,
    };
  },
};

routes["/internal/mcp/conversion/revert-page"] = {
  rpc: "mcp_conversion",
  kind: "write",
  parse(body) {
    const client_id = uuidOf(body, "client_id");
    const page_id = uuidOf(body, "page_id");
    const revision_number = body.revision_number;
    if (
      client_id === undefined ||
      client_id === false ||
      page_id === undefined ||
      page_id === false ||
      typeof revision_number !== "number" ||
      !Number.isInteger(revision_number) ||
      revision_number < 1 ||
      !subset(body, ["client_id", "page_id", "revision_number"])
    )
      return;
    return {
      p_bot_id: null,
      p_client_id: client_id,
      p_action: "revert_page",
      p_page_id: page_id,
      p_revision_number: revision_number,
    };
  },
};

export const handleMcpConversion: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, routes);
