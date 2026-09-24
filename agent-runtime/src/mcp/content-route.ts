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
  /** Explicit per-route bound; legacy routes retain the 4 KiB default. */
  maxBodyBytes?: number;
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
  '/internal/mcp/content/assign-production': {
    rpc: 'mcp_assign_production',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const brief_id = uuid(body, 'brief_id');
      const route = str(body, 'route');
      const member_ids = body.member_ids;
      const due_date = body.due_date === undefined ? undefined : str(body, 'due_date');
      const compensation = body.compensation;
      const quality = body.quality === undefined ? undefined : str(body, 'quality');
      const size = body.size === undefined ? undefined : str(body, 'size');
      const brief_role = body.brief_role === undefined ? undefined : str(body, 'brief_role');
      if (!client_id || !brief_id || (route !== 'ai' && route !== 'human')
          || (brief_role !== undefined && brief_role !== 'avatar' && brief_role !== 'editor' && brief_role !== 'full')
          || (due_date !== undefined && !DATE.test(due_date))
          || (compensation !== undefined && (typeof compensation !== 'number' || compensation < 0 || compensation > 1_000_000))
          || (quality !== undefined && quality !== 'low' && quality !== 'medium' && quality !== 'high')
          || (size !== undefined && size !== '1024x1536' && size !== '1024x1024' && size !== '1536x1024')
          || (member_ids !== undefined && (!Array.isArray(member_ids) || member_ids.length < 1 || member_ids.length > 20
            || member_ids.some((m) => typeof m !== 'string' || !UUID.test(m))))
          || (route === 'human' && (!Array.isArray(member_ids) || member_ids.length < 1))
          || !subset(body, ['client_id', 'brief_id', 'route', 'member_ids', 'due_date', 'compensation', 'quality', 'size', 'brief_role'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_brief_id: brief_id, p_route: route,
        ...(member_ids === undefined ? {} : { p_member_ids: member_ids }),
        ...(due_date === undefined ? {} : { p_due_date: due_date }),
        ...(compensation === undefined ? {} : { p_compensation: compensation }),
        ...(quality === undefined ? {} : { p_quality: quality }),
        ...(size === undefined ? {} : { p_size: size }),
        ...(brief_role === undefined ? {} : { p_brief_role: brief_role }),
      };
    },
  },
  '/internal/mcp/content/create-upload-url': {
    rpc: 'mcp_create_upload_url',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const brief_id = uuid(body, 'brief_id');
      const content_type = str(body, 'content_type');
      const filename = body.filename === undefined ? undefined : str(body, 'filename');
      const byte_size = body.byte_size;
      const types = new Set(['image/png', 'image/jpeg', 'image/webp']);
      if (!client_id || !brief_id || !content_type || !types.has(content_type)
          || (filename !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/.test(filename))
          || (byte_size !== undefined && (typeof byte_size !== 'number' || !Number.isInteger(byte_size) || byte_size < 1 || byte_size > 26_214_400))
          || !subset(body, ['client_id', 'brief_id', 'content_type', 'filename', 'byte_size'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_brief_id: brief_id, p_content_type: content_type,
        ...(filename === undefined ? {} : { p_filename: filename }),
        ...(byte_size === undefined ? {} : { p_byte_size: byte_size }),
      };
    },
  },
  '/internal/mcp/content/submit-asset': {
    rpc: 'mcp_submit_uploaded_asset',
    kind: 'write',
    parse: (body) => {
      const client_id = uuid(body, 'client_id');
      const storage_path = body.storage_path === undefined ? undefined : str(body, 'storage_path');
      const pending_asset_id = body.pending_asset_id === undefined ? undefined : uuid(body, 'pending_asset_id');
      const asset_id = body.asset_id === undefined ? undefined : uuid(body, 'asset_id');
      const media_type = str(body, 'media_type');
      const brief_id = body.brief_id === undefined ? undefined : uuid(body, 'brief_id');
      const assignment_id = body.assignment_id === undefined ? undefined : uuid(body, 'assignment_id');
      const title = body.title === undefined ? undefined : str(body, 'title');
      const reserved_id = pending_asset_id ?? asset_id;
      if (!client_id || (!storage_path && !reserved_id)
          || (storage_path !== undefined && (storage_path.length < 1 || storage_path.length > 500))
          || (body.pending_asset_id !== undefined && !pending_asset_id)
          || (body.asset_id !== undefined && !asset_id)
          || (pending_asset_id && asset_id && pending_asset_id !== asset_id)
          || (media_type !== 'image' && media_type !== 'video' && media_type !== 'text')
          || (!brief_id && !assignment_id)
          || (body.brief_id !== undefined && !brief_id)
          || (body.assignment_id !== undefined && !assignment_id)
          || (title !== undefined && (title.length < 1 || title.length > 200))
          || !subset(body, ['client_id', 'storage_path', 'pending_asset_id', 'asset_id', 'media_type', 'brief_id', 'assignment_id', 'title'])) {
        return undefined;
      }
      return {
        p_bot_id: null, p_client_id: client_id, p_media_type: media_type,
        ...(storage_path === undefined ? {} : { p_storage_path: storage_path }),
        ...(reserved_id === undefined ? {} : { p_pending_asset_id: reserved_id }),
        ...(brief_id === undefined ? {} : { p_brief_id: brief_id }),
        ...(assignment_id === undefined ? {} : { p_assignment_id: assignment_id }),
        ...(title === undefined ? {} : { p_title: title }),
      };
    },
  },
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function asIso(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return undefined;
}

/** Mint the signed PUT URL with the runtime service role. Never return one to CoS. */
export async function attachSignedUpload(
  sb: SupabaseClient,
  record: Record<string, unknown>,
  bot: string,
): Promise<Record<string, unknown>> {
  if (bot !== 'bot_production' || record.read_check === true) {
    const clientId = typeof record.client_id === 'string' ? record.client_id : '';
    const briefId = typeof record.brief_id === 'string' ? record.brief_id : '';
    const briefStatus = typeof record.brief_status === 'string' ? record.brief_status : '';
    if (!UUID.test(clientId) || !UUID.test(briefId) || !briefStatus
        || record.eligible !== true || record.read_check !== true) {
      throw new Error('sign_failed');
    }
    return {
      client_id: clientId,
      brief_id: briefId,
      brief_status: briefStatus,
      eligible: true,
      read_check: true,
    };
  }
  const clientId = typeof record.client_id === 'string' ? record.client_id : '';
  const briefId = typeof record.brief_id === 'string' ? record.brief_id : '';
  const pendingId = typeof record.pending_asset_id === 'string' ? record.pending_asset_id : '';
  const storagePath = typeof record.storage_path === 'string' ? record.storage_path : '';
  const contentType = typeof record.content_type === 'string' ? record.content_type : '';
  const expiresAt = asIso(record.expires_at);
  if (!UUID.test(clientId) || !UUID.test(briefId) || !UUID.test(pendingId) || !expiresAt
      || !IMAGE_TYPES.has(contentType)
      || !storagePath.startsWith(`${clientId}/`)
      || storagePath.includes('..')
      || storagePath.includes('\\')
      || storagePath.includes('//')) {
    throw new Error('sign_failed');
  }
  const signed = await sb.storage.from('client-media').createSignedUploadUrl(storagePath, { upsert: false });
  const uploadUrl = signed.data?.signedUrl ?? '';
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(uploadUrl);
  } catch {
    throw new Error('sign_failed');
  }
  if ((parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:')
      || uploadUrl.toLowerCase().includes('service_role')) {
    throw new Error('sign_failed');
  }
  return {
    client_id: clientId,
    brief_id: briefId,
    pending_asset_id: pendingId,
    storage_path: storagePath,
    upload_url: uploadUrl,
    expires_at: expiresAt,
    content_type: contentType,
    headers: {
      'content-type': contentType,
      'cache-control': 'max-age=3600',
    },
    ...(typeof record.replayed === 'boolean' ? { replayed: record.replayed } : {}),
    ...(record.filename === undefined ? {} : { filename: record.filename }),
    ...(record.byte_size === undefined ? {} : { byte_size: record.byte_size }),
  };
}

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
    const body = await readJsonBody(req, route.maxBodyBytes);
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
    if (req.url === '/internal/mcp/content/create-upload-url') {
      try {
        const minted = await attachSignedUpload(sb, record, bot);
        return json(res, 200, minted);
      } catch {
        return fail(res, 'internal_error');
      }
    }
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
