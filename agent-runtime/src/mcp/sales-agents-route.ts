import { type Route, handleMcpContent } from './content-route.js';
import { UUID } from './http.js';

// Phase 11: reads (Alex CLEAR #5 / SEC_BAR #2 — sales_agents writes, test and
// deploy stayed stub/forbidden, not realized then).
// Phase 11b: the 5 factory writes below are realized (SEC_BAR #3);
// sales_agents.deploy deliberately has no route here and stays stub. Same
// posture as pipeline-route.ts: public mcp_* wrappers, require_active_bot +
// require_bot_client_grant in SQL, never can_access_client.

const ROLES = new Set([
  'inbound_qualifier', 'appointment_setter', 'nurture', 'reactivation', 'closer_assist',
]);

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
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function objectionsOf(body: Record<string, unknown>): unknown[] | undefined | false {
  const value = body.objections;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) return false;
  for (const o of value) {
    if (!isPlainObject(o) || Object.keys(o).length > 2) return false;
    const objection = o.objection;
    const response = o.response;
    if (typeof objection !== 'string' || objection.length < 1 || objection.length > 300) return false;
    if (typeof response !== 'string' || response.length < 1 || response.length > 2000) return false;
  }
  return value;
}
function qualificationOf(body: Record<string, unknown>): unknown[] | undefined | false {
  const value = body.qualification;
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return false;
  const optionalKeys = ['why', 'good_answer', 'disqualifier'];
  for (const q of value) {
    if (!isPlainObject(q)) return false;
    if (!Object.keys(q).every((k) => k === 'question' || optionalKeys.includes(k))) return false;
    if (typeof q.question !== 'string' || q.question.length < 1 || q.question.length > 300) return false;
    for (const k of optionalKeys) {
      if (q[k] === undefined || q[k] === null) continue;
      if (typeof q[k] !== 'string' || (q[k] as string).length < 1 || (q[k] as string).length > 300) return false;
    }
  }
  return value;
}
function transcriptOf(body: Record<string, unknown>): unknown[] | undefined | false {
  const value = body.transcript;
  if (!Array.isArray(value) || value.length < 1 || value.length > 60) return false;
  for (const turn of value) {
    if (!isPlainObject(turn) || Object.keys(turn).length !== 2) return false;
    if (turn.role !== 'lead' && turn.role !== 'agent') return false;
    if (typeof turn.text !== 'string' || turn.text.length < 1 || turn.text.length > 2000) return false;
  }
  return value;
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
  '/internal/mcp/sales-agents/generate-config': {
    rpc: 'mcp_generate_sales_agent_config',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const role = str(body, 'role');
      if (!client_id || !role || !ROLES.has(role) || !subset(body, ['client_id', 'role'])) return undefined;
      return { p_bot_id: null, p_client_id: client_id, p_role: role };
    },
  },
  '/internal/mcp/sales-agents/create': {
    rpc: 'mcp_create_sales_agent',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const role = str(body, 'role');
      const name = str(body, 'name');
      const purpose = str(body, 'purpose');
      if (!client_id || !role || !ROLES.has(role)
          || !name || name.trim().length < 1 || name.length > 200
          || !purpose || purpose.trim().length < 1 || purpose.length > 4000
          || !subset(body, ['client_id', 'role', 'name', 'purpose'])) {
        return undefined;
      }
      return { p_bot_id: null, p_client_id: client_id, p_role: role, p_name: name, p_purpose: purpose };
    },
  },
  '/internal/mcp/sales-agents/update-knowledge': {
    rpc: 'mcp_update_sales_agent_knowledge',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const sales_agent_id = uuid(body, 'sales_agent_id');
      const objections = objectionsOf(body);
      const guardrails = body.guardrails === undefined ? undefined : str(body, 'guardrails');
      const greeting = body.greeting === undefined ? undefined : str(body, 'greeting');
      if (!client_id || !sales_agent_id || objections === false
          || (body.guardrails !== undefined && (!guardrails || guardrails.length < 1 || guardrails.length > 4000))
          || (body.greeting !== undefined && (!greeting || greeting.length < 1 || greeting.length > 2000))
          || (objections === undefined && guardrails === undefined && greeting === undefined)
          || !subset(body, ['client_id', 'sales_agent_id', 'objections', 'guardrails', 'greeting'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_sales_agent_id: sales_agent_id,
        ...(objections === undefined ? {} : { p_objections: objections }),
        ...(guardrails === undefined ? {} : { p_guardrails: guardrails }),
        ...(greeting === undefined ? {} : { p_greeting: greeting }),
      };
    },
  },
  '/internal/mcp/sales-agents/update-qualification-rules': {
    rpc: 'mcp_update_sales_agent_qualification_rules',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const sales_agent_id = uuid(body, 'sales_agent_id');
      const qualification = qualificationOf(body);
      if (!client_id || !sales_agent_id || qualification === false
          || !subset(body, ['client_id', 'sales_agent_id', 'qualification'])) {
        return undefined;
      }
      return { p_bot_id: null, p_client_id: client_id, p_sales_agent_id: sales_agent_id, p_qualification: qualification };
    },
  },
  '/internal/mcp/sales-agents/test': {
    rpc: 'mcp_test_sales_agent',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const sales_agent_id = uuid(body, 'sales_agent_id');
      const transcript = transcriptOf(body);
      if (!client_id || !sales_agent_id || transcript === false
          || !subset(body, ['client_id', 'sales_agent_id', 'transcript'])) {
        return undefined;
      }
      return { p_bot_id: null, p_client_id: client_id, p_sales_agent_id: sales_agent_id, p_transcript: transcript };
    },
  },
};

export const handleMcpSalesAgents: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, ROUTES);
