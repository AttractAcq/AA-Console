import { type Route, handleMcpContent } from "./content-route.js";
import { UUID } from "./http.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateOf(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DATE.test(value) || !Number.isFinite(Date.parse(value)))
    return false;
  return new Date(value).toISOString().slice(0, 10) === value ? value : false;
}

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

function parseWindow(body: Record<string, unknown>, extra: string[]) {
  const client_id = uuidOf(body, "client_id");
  const campaign_id = extra.includes("campaign_id") ? uuidOf(body, "campaign_id") : undefined;
  const start_date = dateOf(body.start_date);
  const end_date = dateOf(body.end_date);
  const limit = extra.includes("limit") ? limitOf(body) : undefined;
  if (
    client_id === undefined || client_id === false
    || campaign_id === false
    || start_date === false
    || end_date === false
    || limit === false
    || !subset(body, ["client_id", ...extra, "start_date", "end_date"])
  ) {
    return undefined;
  }
  return {
    p_bot_id: null,
    p_client_id: client_id,
    ...(campaign_id ? { p_campaign_id: campaign_id } : {}),
    ...(start_date ? { p_start_date: start_date } : {}),
    ...(end_date ? { p_end_date: end_date } : {}),
    ...(limit === undefined ? {} : { p_limit: limit }),
  };
}

const routes: Record<string, Route> = {};
for (const action of [
  "get_client_economics",
  "get_campaign_economics",
  "get_costs",
  "get_revenue",
  "get_roi",
]) {
  const extra = action === "get_campaign_economics" ? ["campaign_id", "limit"] : [];
  routes[`/internal/mcp/economics/${action.replaceAll("_", "-")}`] = {
    rpc: "mcp_economics_read",
    kind: "read",
    parse(body) {
      const parsed = parseWindow(body, extra);
      if (!parsed) return undefined;
      return { ...parsed, p_action: action };
    },
  };
}
routes["/internal/mcp/attribution/get-revenue-attribution"] = {
  rpc: "mcp_attribution_revenue",
  kind: "read",
  parse(body) {
    return parseWindow(body, ["campaign_id", "limit"]);
  },
};

export const handleMcpEconomics: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, routes);
