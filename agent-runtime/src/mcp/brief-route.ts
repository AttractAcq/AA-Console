import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function fail(res: ServerResponse, code: string): void {
  const [status, message] = ERRORS[code] ?? [500, 'Unable to process the request.'];
  json(res, status, { error: { code, message } });
}
function header(req: IncomingMessage, name: string): string | undefined {
  // Node combines some duplicates and discards others (including Authorization).
  // Refuse both forms rather than trusting whichever header survived parsing.
  const count = (req.rawHeaders ?? []).filter((_, i, all) => i % 2 === 0 && (all[i] ?? '').toLowerCase() === name).length;
  const value = req.headers[name];
  return count > 1 || typeof value !== 'string' ? undefined : value;
}
function authenticated(req: IncomingMessage, secret: string | null | undefined): boolean {
  if (!secret) return false;
  const value = header(req, 'authorization');
  if (!value || !/^Bearer [^\s]+$/i.test(value)) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(value.slice(7)), digest(secret));
}

export async function handleMcpBrief(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
  secret: string | null | undefined,
): Promise<void> {
  if (!authenticated(req, secret)) return fail(res, 'unauthorized');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: { code: 'invalid_request', message: 'POST required.' } });
  }
  const bot = header(req, 'x-aa-bot-id');
  if (!bot || !SUPPORTED_BOTS.has(bot)) return fail(res, 'invalid_bot');
  const requestId = header(req, 'x-request-id');
  const executionId = header(req, 'idempotency-key');
  if (!requestId || !ID.test(requestId) || !executionId || !ID.test(executionId)
      || !/^application\/json(?:\s*;.*)?$/i.test(header(req, 'content-type') ?? '')) {
    return fail(res, 'invalid_request');
  }

  let body: Record<string, unknown>;
  try {
    // Use events rather than an async iterator: breaking an iterator destroys
    // IncomingMessage (and its socket), preventing a structured 400 response.
    const value = await new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const cleanup = () => {
        clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onError);
      };
      const onError = () => {
        cleanup();
        // An aborted IncomingMessage can emit ECONNRESET after 'aborted'.
        // Keep a listener while Node finishes tearing down the rejected upload.
        req.on('error', () => { /* already rejected */ });
        req.pause();
        reject(new Error('invalid_request'));
      };
      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 4096) return onError();
        chunks.push(buffer);
      };
      const onEnd = () => {
        cleanup();
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('invalid_request')); }
      };
      const timer = setTimeout(onError, 10_000);
      timer.unref();
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onError);
    });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
    body = value as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'client_id,idea_id'
        || typeof body.client_id !== 'string' || !UUID.test(body.client_id)
        || typeof body.idea_id !== 'string' || !UUID.test(body.idea_id)) throw new Error('invalid_request');
  } catch {
    // Let Node close the socket gracefully after flushing the JSON response.
    // Destroying IncomingMessage on 'finish' can discard queued response bytes.
    res.setHeader('Connection', 'close');
    return fail(res, 'invalid_request');
  }

  try {
    const { data, error } = await sb.rpc('enqueue_mcp_brief', {
      p_bot_id: bot, p_request_id: requestId, p_execution_id: executionId,
      p_client_id: body.client_id, p_idea_id: body.idea_id,
    }).abortSignal(AbortSignal.timeout(12_000));
    if (error) {
      // Only documented database error codes/messages cross the HTTP boundary.
      return fail(res, error.code === 'P0001' && Object.hasOwn(ERRORS, error.message)
        ? error.message : 'internal_error');
    }
    if (!data || typeof data.job_id !== 'string' || !UUID.test(data.job_id)
        || data.client_id !== (body.client_id as string).toLowerCase()
        || typeof data.replayed !== 'boolean') return fail(res, 'internal_error');
    json(res, data.replayed ? 200 : 202, { job_id: data.job_id, client_id: data.client_id });
  } catch {
    fail(res, 'internal_error');
  }
}
