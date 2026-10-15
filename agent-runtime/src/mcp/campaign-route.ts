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

const routes: Record<string, Route> = {
  "/internal/mcp/campaign/list": {
    rpc: "mcp_campaign_execution",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const after = uuidOf(body, "after");
      const limit = limitOf(body);
      if (
        client_id === undefined ||
        client_id === false ||
        after === false ||
        limit === false ||
        !subset(body, ["client_id", "limit", "after"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        p_action: "list",
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(after ? { p_after: after } : {}),
      };
    },
  },
};

function campaignRead(action: string): Route {
  return {
    rpc: "mcp_campaign_execution",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const campaign_id = uuidOf(body, "campaign_id");
      if (
        client_id === undefined ||
        client_id === false ||
        campaign_id === undefined ||
        campaign_id === false ||
        !subset(body, ["client_id", "campaign_id"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        p_action: action,
        p_campaign_id: campaign_id,
      };
    },
  };
}
routes["/internal/mcp/campaign/get"] = campaignRead("get");
routes["/internal/mcp/campaign/get-status"] = campaignRead("get_status");
routes["/internal/mcp/campaign/get-readiness"] = campaignRead("get_readiness");

routes["/internal/mcp/campaign/create"] = {
  rpc: "mcp_campaign_execution",
  kind: "queue",
  parse(body) {
    const client_id = uuidOf(body, "client_id");
    const name = textOf(body, "name", 1, 200);
    const brief = textOf(body, "brief", 1, 4000);
    if (
      client_id === undefined ||
      client_id === false ||
      name === undefined ||
      name === false ||
      brief === undefined ||
      brief === false ||
      !subset(body, ["client_id", "name", "brief"])
    )
      return;
    return {
      p_bot_id: null,
      p_client_id: client_id,
      p_action: "create",
      p_name: name,
      p_brief: brief,
    };
  },
};

routes["/internal/mcp/campaign/create-v6"] = {
  rpc: "mcp_campaign_create_v6",
  kind: "queue",
  parse(body) {
    const client_id = uuidOf(body, "client_id");
    const name = textOf(body, "name", 1, 200);
    const brief = textOf(body, "brief", 1, 4000);
    const acquisition_mode = body.acquisition_mode;
    const paid_platform = body.paid_platform;
    if (client_id === undefined || client_id === false
      || name === undefined || name === false
      || brief === undefined || brief === false
      || (acquisition_mode !== "organic" && acquisition_mode !== "paid")
      || (acquisition_mode === "paid" && paid_platform !== "meta" && paid_platform !== "google")
      || (acquisition_mode === "organic" && paid_platform !== undefined)
      || !subset(body, ["client_id", "name", "brief", "acquisition_mode", "paid_platform"])) return;
    return {
      p_bot_id: null,
      p_client_id: client_id,
      p_name: name,
      p_brief: brief,
      p_acquisition_mode: acquisition_mode,
      p_paid_platform: acquisition_mode === "paid" ? paid_platform : null,
    };
  },
};

routes["/internal/mcp/campaign/list-v6"] = {
  rpc: "mcp_campaign_list_v6",
  kind: "read",
  parse(body) {
    const client_id = uuidOf(body, "client_id");
    const after = uuidOf(body, "after");
    const limit = limitOf(body);
    if (client_id === undefined || client_id === false || after === false || limit === false
      || !subset(body, ["client_id", "limit", "after"])) return;
    return {
      p_bot_id: null,
      p_client_id: client_id,
      ...(limit === undefined ? {} : { p_limit: limit }),
      ...(after ? { p_after: after } : {}),
    };
  },
};

routes["/internal/mcp/campaign/update"] = {
  rpc: "mcp_campaign_execution",
  kind: "write",
  parse(body) {
    const client_id = uuidOf(body, "client_id");
    const campaign_id = uuidOf(body, "campaign_id");
    const name = textOf(body, "name", 1, 200);
    const brief = textOf(body, "brief", 1, 4000);
    const status = body.status;
    if (
      client_id === undefined ||
      client_id === false ||
      campaign_id === undefined ||
      campaign_id === false ||
      name === false ||
      brief === false ||
      (status !== undefined && status !== "complete" && status !== "cancelled") ||
      (name === undefined && brief === undefined && status === undefined) ||
      !subset(body, ["client_id", "campaign_id", "name", "brief", "status"])
    )
      return;
    return {
      p_bot_id: null,
      p_client_id: client_id,
      p_action: "update",
      p_campaign_id: campaign_id,
      ...(name ? { p_name: name } : {}),
      ...(brief ? { p_brief: brief } : {}),
      ...(typeof status === "string" ? { p_status: status } : {}),
    };
  },
};

routes["/internal/mcp/campaign/request-approval"] = {
  rpc: "mcp_campaign_execution",
  kind: "write",
  parse(body) {
    const client_id = uuidOf(body, "client_id");
    const campaign_id = uuidOf(body, "campaign_id");
    const summary = textOf(body, "summary", 1, 4000);
    if (
      client_id === undefined ||
      client_id === false ||
      campaign_id === undefined ||
      campaign_id === false ||
      summary === false ||
      !subset(body, ["client_id", "campaign_id", "summary"])
    )
      return;
    return {
      p_bot_id: null,
      p_client_id: client_id,
      p_action: "request_approval",
      p_campaign_id: campaign_id,
      ...(summary ? { p_summary: summary } : {}),
    };
  },
};

function campaignWrite(action: string, kind: Route["kind"], extra: string[] = []): Route {
  return {
    rpc: "mcp_campaign_execution",
    kind,
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const campaign_id = uuidOf(body, "campaign_id");
      const extraVal: Record<string, unknown> = {};
      if (extra.includes("kind")) {
        const value = body.kind;
        if (value !== undefined && value !== "landing_page" && value !== "sales_agent") return;
        if (typeof value === "string") extraVal.p_kind = value;
      }
      if (
        client_id === undefined ||
        client_id === false ||
        campaign_id === undefined ||
        campaign_id === false ||
        !subset(body, ["client_id", "campaign_id", ...extra])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        p_action: action,
        p_campaign_id: campaign_id,
        ...extraVal,
      };
    },
  };
}
routes["/internal/mcp/campaign/plan"] = campaignWrite("plan", "queue");
routes["/internal/mcp/campaign/provision"] = campaignWrite("provision", "write", ["kind"]);
routes["/internal/mcp/campaign/launch"] = campaignWrite("launch", "write");

export const handleMcpCampaign: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, routes);
