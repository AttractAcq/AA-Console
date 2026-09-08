import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  UUID, ID, authenticated, fail, header, json, readJsonBody,
} from './http.js';

// Adding a bot here enables its identity, never its client scope. Grants live
// in mcp_bot_clients and are checked transactionally by enqueue_mcp_brief.
const SUPPORTED_BOTS = new Set(['bot_production']);
const ERRORS: Record<string, [number, string]> = {
  unauthorized: [401, 'Service authentication required.'],
  invalid_bot: [403, 'Bot identity is not supported.'],
  invalid_request: [400, 'Valid headers and exactly client_id and idea_id UUIDs are required.'],
  idea_not_found: [404, 'Idea not found.'],
  client_mismatch: [403, 'Idea does not belong to the requested client.'],
  client_forbidden: [403, 'Bot is not permitted for this client.'],
  bot_not_active: [403, 'Bot is not active.'],
  invalid_idea_status: [409, 'Idea must already be approved for brief generation.'],
  idempotency_conflict: [409, 'Execution key was already used for a different request.'],
  brief_agent_unavailable: [503, 'Brief agent is unavailable.'],
  queue_failure: [500, 'Unable to queue brief generation.'],
  internal_error: [500, 'Unable to process the request.'],
};

export async function handleMcpBrief(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
  secret: string | null | undefined,
): Promise<void> {
  if (!authenticated(req, secret)) return fail(res, 'unauthorized', ERRORS);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: { code: 'invalid_request', message: 'POST required.' } });
  }
  const bot = header(req, 'x-aa-bot-id');
  if (!bot || !SUPPORTED_BOTS.has(bot)) return fail(res, 'invalid_bot', ERRORS);
  const requestId = header(req, 'x-request-id');
  const executionId = header(req, 'idempotency-key');
  if (!requestId || !ID.test(requestId) || !executionId || !ID.test(executionId)
      || !/^application\/json(?:\s*;.*)?$/i.test(header(req, 'content-type') ?? '')) {
    return fail(res, 'invalid_request', ERRORS);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
    if (Object.keys(body).sort().join(',') !== 'client_id,idea_id'
        || typeof body.client_id !== 'string' || !UUID.test(body.client_id)
        || typeof body.idea_id !== 'string' || !UUID.test(body.idea_id)) throw new Error('invalid_request');
  } catch {
    res.setHeader('Connection', 'close');
    return fail(res, 'invalid_request', ERRORS);
  }

  try {
    const { data, error } = await sb.rpc('enqueue_mcp_brief', {
      p_bot_id: bot, p_request_id: requestId, p_execution_id: executionId,
      p_client_id: body.client_id, p_idea_id: body.idea_id,
    }).abortSignal(AbortSignal.timeout(12_000));
    if (error) {
      return fail(res, error.code === 'P0001' && Object.hasOwn(ERRORS, error.message)
        ? error.message : 'internal_error', ERRORS);
    }
    if (!data || typeof data.job_id !== 'string' || !UUID.test(data.job_id)
        || data.client_id !== (body.client_id as string).toLowerCase()
        || typeof data.replayed !== 'boolean') return fail(res, 'internal_error', ERRORS);
    json(res, data.replayed ? 200 : 202, { job_id: data.job_id, client_id: data.client_id });
  } catch {
    fail(res, 'internal_error', ERRORS);
  }
}
