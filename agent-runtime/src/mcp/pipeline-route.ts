import { type Route, handleMcpContent } from './content-route.js';
import { UUID } from './http.js';

// Phase 11: these routes call public mcp_* wrappers only. Authorization is
// require_active_bot + require_bot_client_grant in SQL — never can_access_client.
// Gateway permission checks and client allowlist still run before this hop.

const ALL_STAGES = new Set([
  'lead', 'conversation', 'qualified_conversation', 'appointment',
  'qualified_appointment', 'shown', 'sale', 'cash', 'lost',
]);
// sale/cash excluded: money-adjacent, deferred to pipeline.record_sale (stub).
// Matches the gateway's registry/tools.ts field shape and the RPC's own
// hard-coded invalid_stage guard — three independent layers, not one.
const WRITABLE_STAGES = new Set([...ALL_STAGES].filter((s) => s !== 'sale' && s !== 'cash'));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  '/internal/mcp/pipeline/list-leads': {
    rpc: 'mcp_list_leads',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const limit = limitOf(body);
      const stage = body.stage === undefined ? undefined : str(body, 'stage');
      if (!client_id || limit === false || !subset(body, ['client_id', 'limit', 'stage'])
          || (stage !== undefined && !ALL_STAGES.has(stage))) return undefined;
      return {
        p_bot_id: null, p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(stage === undefined ? {} : { p_stage: stage }),
      };
    },
  },
  '/internal/mcp/pipeline/get-lead': {
    rpc: 'mcp_get_lead',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const lead_id = uuid(body, 'lead_id');
      if (!client_id || !lead_id || !subset(body, ['client_id', 'lead_id'])) return undefined;
      return { p_bot_id: null, p_client_id: client_id, p_lead_id: lead_id };
    },
  },
  '/internal/mcp/pipeline/get-stalled-leads': {
    rpc: 'mcp_get_stalled_leads',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const limit = limitOf(body);
      const days = body.days;
      if (!client_id || limit === false || !subset(body, ['client_id', 'limit', 'days'])
          || (days !== undefined && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365))) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(days === undefined ? {} : { p_days: days }),
      };
    },
  },
  '/internal/mcp/pipeline/get-pipeline-summary': {
    rpc: 'mcp_get_pipeline_summary',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      if (!client_id || !subset(body, ['client_id'])) return undefined;
      return { p_bot_id: null, p_client_id: client_id };
    },
  },
  '/internal/mcp/pipeline/update-stage': {
    rpc: 'mcp_update_lead_stage',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const lead_id = uuid(body, 'lead_id');
      const stage = str(body, 'stage');
      const note = body.note === undefined ? undefined : str(body, 'note');
      if (!client_id || !lead_id || !stage || !WRITABLE_STAGES.has(stage)
          || (note !== undefined && (note.length < 1 || note.length > 4000))
          || !subset(body, ['client_id', 'lead_id', 'stage', 'note'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_lead_id: lead_id, p_stage: stage,
        ...(note === undefined ? {} : { p_note: note }),
      };
    },
  },
  '/internal/mcp/pipeline/create-followup': {
    rpc: 'mcp_create_followup',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const lead_id = uuid(body, 'lead_id');
      const next_action = str(body, 'next_action');
      const next_action_due = body.next_action_due === undefined ? undefined : str(body, 'next_action_due');
      if (!client_id || !lead_id || !next_action || next_action.trim().length < 1 || next_action.length > 500
          || (next_action_due !== undefined && !DATE.test(next_action_due))
          || !subset(body, ['client_id', 'lead_id', 'next_action', 'next_action_due'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_lead_id: lead_id, p_next_action: next_action,
        ...(next_action_due === undefined ? {} : { p_next_action_due: next_action_due }),
      };
    },
  },
};

export const handleMcpPipeline: typeof handleMcpContent = (req, res, sb, secret) =>
  handleMcpContent(req, res, sb, secret, ROUTES);
