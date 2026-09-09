import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BOT, ID, MCP_ERRORS, UUID, authenticated, fail, header, json, readJsonBody,
} from './http.js';

// Sec Phase 5: these routes call public mcp_* wrappers only. Authorization is
// require_active_bot + require_bot_client_grant in SQL — never can_access_client.
// Gateway permission checks and client allowlist still run before this hop.

const FORMATS = new Set([
  'reel', 'short', 'carousel', 'quote_graphic',
  'text_post', 'email', 'ad_variation', 'story_clips',
]);
const STATUSES = new Set(['draft', 'approved', 'rejected', 'briefed']);
const CHANNELS = new Set(['organic', 'paid']);
const PUBLICATION_STATUSES = new Set(['published', 'failed']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Kind = 'read' | 'write' | 'queue';
export type Route = {
  rpc: string;
  kind: Kind;
  parse: (body: Record<string, unknown>) => Record<string, unknown> | undefined;
};

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}
function uuid(body: Record<string, unknown>, key: string): string | undefined {
  const value = str(body, key);
  return value && UUID.test(value) ? value : undefined;
}
function keysOf(body: Record<string, unknown>): string {
  return Object.keys(body).sort().join(',');
}
function subset(body: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k));
}

const ROUTES: Record<string, Route> = {
  '/internal/mcp/content/list-ideas': {
    rpc: 'mcp_list_ideas',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      if (!client_id || !subset(body, ['client_id', 'limit', 'status'])) return undefined;
      const limit = body.limit === undefined ? undefined : body.limit;
      if (limit !== undefined && (
        typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100
      )) return undefined;
      const status = body.status === undefined ? undefined : str(body, 'status');
      if (status !== undefined && !STATUSES.has(status)) return undefined;
      return {
        p_bot_id: null, p_client_id: client_id,
        ...(limit === undefined ? {} : { p_limit: limit }),
        ...(status === undefined ? {} : { p_status: status }),
      };
    },
  },
  '/internal/mcp/content/get-idea': {
    rpc: 'mcp_get_idea',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const idea_id = uuid(body, 'idea_id');
      if (!client_id || !idea_id || keysOf(body) !== 'client_id,idea_id') return undefined;
      return { p_bot_id: null, p_client_id: client_id, p_idea_id: idea_id };
    },
  },
  '/internal/mcp/content/select-idea': {
    rpc: 'mcp_approve_idea',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const idea_id = uuid(body, 'idea_id');
      if (!client_id || !idea_id || keysOf(body) !== 'client_id,idea_id') return undefined;
      return { p_bot_id: null, p_client_id: client_id, p_idea_id: idea_id };
    },
  },
  '/internal/mcp/content/approve-asset': {
    rpc: 'mcp_approve_asset',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const asset_id = uuid(body, 'asset_id');
      const decision = str(body, 'decision');
      const reason = body.summary === undefined ? undefined : str(body, 'summary');
      if (!client_id || !asset_id || (decision !== 'approved' && decision !== 'rejected')
          || (reason !== undefined && (reason.length < 1 || reason.length > 4000))
          || !subset(body, ['client_id', 'asset_id', 'decision', 'summary'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_asset_id: asset_id, p_decision: decision,
        ...(reason === undefined ? {} : { p_reason: reason }),
      };
    },
  },
  '/internal/mcp/content/get-brief': {
    rpc: 'mcp_get_brief',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const brief_id = body.brief_id === undefined ? undefined : uuid(body, 'brief_id');
      const idea_id = body.idea_id === undefined ? undefined : uuid(body, 'idea_id');
      if (!client_id || (!brief_id && !idea_id) || !subset(body, ['client_id', 'brief_id', 'idea_id'])) {
        return undefined;
      }
      if ((body.brief_id !== undefined && !brief_id) || (body.idea_id !== undefined && !idea_id)) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id,
        ...(brief_id ? { p_brief_id: brief_id } : {}),
        ...(idea_id ? { p_idea_id: idea_id } : {}),
      };
    },
  },
  '/internal/mcp/content/get-production-status': {
    rpc: 'mcp_get_production_status',
    kind: 'read',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const idea_id = body.idea_id === undefined ? undefined : uuid(body, 'idea_id');
      const brief_id = body.brief_id === undefined ? undefined : uuid(body, 'brief_id');
      const asset_id = body.asset_id === undefined ? undefined : uuid(body, 'asset_id');
      if (!client_id || (!idea_id && !brief_id && !asset_id)
          || !subset(body, ['client_id', 'idea_id', 'brief_id', 'asset_id'])) return undefined;
      if ((body.idea_id !== undefined && !idea_id)
          || (body.brief_id !== undefined && !brief_id)
          || (body.asset_id !== undefined && !asset_id)) return undefined;
      return {
        p_bot_id: null, p_client_id: client_id,
        ...(idea_id ? { p_idea_id: idea_id } : {}),
        ...(brief_id ? { p_brief_id: brief_id } : {}),
        ...(asset_id ? { p_asset_id: asset_id } : {}),
      };
    },
  },
  '/internal/mcp/content/request-revision': {
    rpc: 'mcp_request_revision',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const summary = str(body, 'summary');
      const idea_id = body.idea_id === undefined ? undefined : uuid(body, 'idea_id');
      const brief_id = body.brief_id === undefined ? undefined : uuid(body, 'brief_id');
      const asset_id = body.asset_id === undefined ? undefined : uuid(body, 'asset_id');
      if (!client_id || !summary || summary.length < 1 || summary.length > 4000
          || (!idea_id && !brief_id && !asset_id)
          || !subset(body, ['client_id', 'idea_id', 'brief_id', 'asset_id', 'summary'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_summary: summary,
        p_idea_id: idea_id ?? null, p_brief_id: brief_id ?? null, p_asset_id: asset_id ?? null,
      };
    },
  },
  '/internal/mcp/content/request-approval': {
    rpc: 'mcp_request_approval',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const summary = body.summary === undefined ? undefined : str(body, 'summary');
      const idea_id = body.idea_id === undefined ? undefined : uuid(body, 'idea_id');
      const brief_id = body.brief_id === undefined ? undefined : uuid(body, 'brief_id');
      const asset_id = body.asset_id === undefined ? undefined : uuid(body, 'asset_id');
      if (!client_id || (!idea_id && !brief_id && !asset_id)
          || (summary !== undefined && (summary.length < 1 || summary.length > 4000))
          || !subset(body, ['client_id', 'idea_id', 'brief_id', 'asset_id', 'summary'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id,
        p_idea_id: idea_id ?? null, p_brief_id: brief_id ?? null, p_asset_id: asset_id ?? null,
        ...(summary === undefined ? {} : { p_summary: summary }),
      };
    },
  },
  '/internal/mcp/content/queue-distribution': {
    rpc: 'mcp_queue_distribution',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const asset_id = uuid(body, 'asset_id');
      const scheduled_for = str(body, 'scheduled_for');
      const channel = body.channel === undefined ? undefined : str(body, 'channel');
      if (!client_id || !asset_id || !scheduled_for || !DATE.test(scheduled_for)
          || (channel !== undefined && !CHANNELS.has(channel))
          || !subset(body, ['client_id', 'asset_id', 'scheduled_for', 'channel'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_asset_id: asset_id,
        p_scheduled_for: scheduled_for,
        ...(channel === undefined ? {} : { p_channel: channel }),
      };
    },
  },
  '/internal/mcp/content/record-publication': {
    rpc: 'mcp_record_publication',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const schedule_id = uuid(body, 'schedule_id');
      const status = str(body, 'status');
      const external_id = body.external_id === undefined ? undefined : str(body, 'external_id');
      const failure_reason = body.failure_reason === undefined ? undefined : str(body, 'failure_reason');
      if (!client_id || !schedule_id || !status || !PUBLICATION_STATUSES.has(status)
          || (external_id !== undefined && (external_id.length < 1 || external_id.length > 200))
          || (failure_reason !== undefined && (failure_reason.length < 1 || failure_reason.length > 4000))
          || !subset(body, ['client_id', 'schedule_id', 'status', 'external_id', 'failure_reason'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_schedule_id: schedule_id, p_status: status,
        ...(external_id === undefined ? {} : { p_external_id: external_id }),
        ...(failure_reason === undefined ? {} : { p_failure_reason: failure_reason }),
      };
    },
  },
  '/internal/mcp/content/create-repurpose-plan': {
    rpc: 'mcp_create_repurpose_plan',
    kind: 'queue',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const asset_id = uuid(body, 'asset_id');
      const formats = body.formats;
      const approval = body.approval_execution_id;
      if (!client_id || !asset_id || !Array.isArray(formats)
          || formats.length < 1 || formats.length > 6
          || !subset(body, ['asset_id', 'client_id', 'formats', 'approval_execution_id'])
          || (approval !== undefined && (typeof approval !== 'string' || !ID.test(approval)))
          || formats.some((f) => typeof f !== 'string' || !FORMATS.has(f))) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_asset_id: asset_id,
        p_formats: formats as string[],
        ...(approval === undefined ? {} : { p_approval_execution_id: approval }),
      };
    },
  },
};

export async function handleMcpContent(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
  secret: string | null | undefined,
  routes: Record<string, Route> = ROUTES,
): Promise<void> {
  if (!authenticated(req, secret)) return fail(res, 'unauthorized');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: { code: 'invalid_request', message: 'POST required.' } });
  }
  const route = routes[req.url ?? ''];
  if (!route) return json(res, 404, { error: { code: 'not_found', message: 'Unknown content route.' } });
  const bot = header(req, 'x-aa-bot-id');
  if (!bot || !BOT.test(bot)) return fail(res, 'invalid_bot');
  const requestId = header(req, 'x-request-id');
  const executionId = header(req, 'idempotency-key');
  if (!requestId || !ID.test(requestId) || !executionId || !ID.test(executionId)
      || !/^application\/json(?:\s*;.*)?$/i.test(header(req, 'content-type') ?? '')) {
    return fail(res, 'invalid_request');
  }

  let parsed: Record<string, unknown> | undefined;
  try {
    const body = await readJsonBody(req);
    parsed = route.parse(body);
    if (!parsed) throw new Error('invalid_request');
    parsed.p_bot_id = bot;
    if (route.kind !== 'read') {
      parsed.p_request_id = requestId;
      parsed.p_execution_id = executionId;
    }
  } catch {
    res.setHeader('Connection', 'close');
    return fail(res, 'invalid_request');
  }

  try {
    const { data, error } = await sb.rpc(parsed.p_approval_execution_id === undefined ? route.rpc : 'mcp_resume_approval', parsed).abortSignal(AbortSignal.timeout(12_000));
    if (error) {
      return fail(res, error.code === 'P0001' && Object.hasOwn(MCP_ERRORS, error.message)
        ? error.message : 'internal_error');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail(res, 'internal_error');
    const record = data as Record<string, unknown>;
    const clientId = typeof record.client_id === 'string' ? record.client_id.toLowerCase() : '';
    if (req.url === '/internal/mcp/delivery/list-clients') {
      if (!Array.isArray(record.clients) || record.clients.length > 100
          || record.clients.some((c: any) => !c || typeof c.id !== 'string' || !UUID.test(c.id))
          || (record.next_cursor !== null && (typeof record.next_cursor !== 'string' || !UUID.test(record.next_cursor)))) return fail(res, 'internal_error');
      return json(res, 200, record);
    }
    if (clientId !== String(parsed.p_client_id).toLowerCase() || !UUID.test(clientId)) return fail(res, 'internal_error');
    if (route.kind === 'queue') {
      if (typeof record.job_id !== 'string' || !UUID.test(record.job_id)
          || typeof record.replayed !== 'boolean') return fail(res, 'internal_error');
      const { replayed, ...rest } = record;
      json(res, replayed ? 200 : 202, rest);
      return;
    }
    json(res, 200, record);
  } catch {
    fail(res, 'internal_error');
  }
}
