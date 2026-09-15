import { type Route, handleMcpContent } from "./content-route.js";
import { UUID } from "./http.js";

function uuidOf(body: Record<string, unknown>, key: string): string | undefined | false {
  const value = body[key];
  if (value === undefined) return undefined;
  return typeof value === "string" && UUID.test(value) ? value : false;
}

function intOf(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined | false {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    return false;
  return value;
}

function subset(body: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k));
}

const routes: Record<string, Route> = {
  "/internal/mcp/attribution/get-conversion-funnel": {
    rpc: "mcp_attribution_conversion_funnel",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const days = intOf(body, "days", 1, 3650);
      if (
        client_id === undefined ||
        client_id === false ||
        days === false ||
        !subset(body, ["client_id", "days"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        ...(days === undefined ? {} : { p_days: days }),
      };
    },
  },
  "/internal/mcp/attribution/get-content-performance": {
    rpc: "mcp_attribution_content_performance",
    kind: "read",
    parse(body) {
      const client_id = uuidOf(body, "client_id");
      const limit = intOf(body, "limit", 1, 100);
      if (
        client_id === undefined ||
        client_id === false ||
        limit === false ||
        !subset(body, ["client_id", "limit"])
      )
        return;
      return {
        p_bot_id: null,
        p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
      };
    },
  },
};

export const handleMcpAttribution: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, routes);
