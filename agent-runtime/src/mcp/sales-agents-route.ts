import { type Route, handleMcpContent } from './content-route.js';
import { UUID } from './http.js';

// Phase 11: reads only (Alex CLEAR #5 / SEC_BAR #2 — sales_agents writes,
// test and deploy stay stub/forbidden, not realized here). Same posture as
// pipeline-route.ts: public mcp_* wrappers, require_active_bot +
// require_bot_client_grant in SQL, never can_access_client.

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}
function uuid(body: Record<string, unknown>, key: string): string | undefined {
  const value = str(body, key);
  return value && UUID.test(value) ? value : undefined;
}
function subset(body: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k));
}
function limitOf(body: Record<string, unknown>): number | undefined | false {
  const limit = body.limit;
  if (limit === undefined) return undefined;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) return false;
  return limit;
}

const ROUTES: Record<string, Route> = {
  '/internal/mcp/sales-agents/list': {
    rpc: 'mcp_list_sales_agents',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const limit = limitOf(body);
      if (!client_id || limit === false || !subset(body, ['client_id', 'limit'])) return undefined;
      return {
        p_bot_id: null, p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
      };
    },
  },
  '/internal/mcp/sales-agents/get': {
    rpc: 'mcp_get_sales_agent',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const sales_agent_id = uuid(body, 'sales_agent_id');
      if (!client_id || !sales_agent_id || !subset(body, ['client_id', 'sales_agent_id'])) return undefined;
      return { p_bot_id: null, p_client_id: client_id, p_sales_agent_id: sales_agent_id };
    },
  },
  '/internal/mcp/sales-agents/get-conversations': {
    rpc: 'mcp_get_sales_agent_conversations',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const limit = limitOf(body);
      const sales_agent_id = body.sales_agent_id === undefined ? undefined : uuid(body, 'sales_agent_id');
      if (!client_id || limit === false || !subset(body, ['client_id', 'sales_agent_id', 'limit'])
          || (body.sales_agent_id !== undefined && !sales_agent_id)) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id,
        ...(sales_agent_id === undefined ? {} : { p_sales_agent_id: sales_agent_id }),
        ...(limit === undefined ? {} : { p_limit: limit }),
      };
    },
  },
};

export const handleMcpSalesAgents: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, ROUTES);
