import { type Route, handleMcpContent } from './content-route.js';
import { UUID } from './http.js';

const ROUTES: Record<string, Route> = {};

for (const action of ['list_clients', 'get_client', 'get_status', 'get_blockers', 'get_next_action', 'get_plan', 'get_client_health', 'create_task']) {
  ROUTES[`/internal/mcp/delivery/${action.replaceAll('_', '-')}`] = {
    rpc: action === 'list_clients' ? 'mcp_delivery_list_clients' : action === 'create_task' ? 'mcp_delivery_create_task' : 'mcp_delivery_read',
    kind: action === 'create_task' ? 'write' : 'read',
    parse(body) {
      const allowed = action === 'list_clients' ? ['limit', 'after'] : action === 'create_task'
        ? ['client_id', 'title', 'summary', 'due_date', 'brief_id'] : ['client_id'];
      if (Object.keys(body).some(k => !allowed.includes(k))) return undefined;
      if (action === 'list_clients') {
        if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 100)) return undefined;
        if (body.after !== undefined && (typeof body.after !== 'string' || !UUID.test(body.after))) return undefined;
        return { p_limit: body.limit ?? 25, p_after: body.after ?? null };
      }
      if (typeof body.client_id !== 'string' || !UUID.test(body.client_id)) return undefined;
      if (action !== 'create_task') return { p_client_id: body.client_id, p_view: action };
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200
          || (body.summary !== undefined && (typeof body.summary !== 'string' || body.summary.length > 4000))
          || (body.brief_id !== undefined && (typeof body.brief_id !== 'string' || !UUID.test(body.brief_id)))) return undefined;
      if (body.due_date !== undefined) {
        if (typeof body.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) return undefined;
        const date = new Date(body.due_date);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== body.due_date) return undefined;
      }
      return { p_client_id: body.client_id, p_title: body.title, p_summary: body.summary ?? null,
        p_due_date: body.due_date ?? null, p_brief_id: body.brief_id ?? null };
    },
  };
}
export const handleMcpDelivery: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, ROUTES);
