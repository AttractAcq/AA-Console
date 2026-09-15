import { type Route, handleMcpContent } from "./content-route.js";
import { UUID } from "./http.js";

const routes: Record<string, Route> = {
  "/internal/mcp/brand/get-profile": {
    rpc: "mcp_brand_get_profile",
    kind: "read",
    parse(body) {
      const client_id = body.client_id;
      if (
        typeof client_id !== "string" ||
        !UUID.test(client_id) ||
        Object.keys(body).join(",") !== "client_id"
      )
        return;
      return { p_bot_id: null, p_client_id: client_id };
    },
  },
};

export const handleMcpBrand: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, routes);
