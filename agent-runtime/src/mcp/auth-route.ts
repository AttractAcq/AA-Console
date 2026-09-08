import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';

const HEX64 = /^[0-9a-f]{64}$/;
const BOT = /^bot_[a-z0-9_]{1,60}$/;
const ACTOR = /^[\x20-\x7E]{1,100}$/;
const ERRORS: Record<string, [number, string]> = {
  unauthorized: [401, 'Service authentication required.'],
  invalid_request: [400, 'Valid JSON fields are required.'],
  invalid_bot: [400, 'Bot identity is not supported.'],
  not_found: [404, 'Token is not present.'],
  bot_not_active: [409, 'Bot is not active.'],
  token_revoked: [409, 'Token is revoked.'],
  hash_conflict: [409, 'Token hash already exists.'],
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

type Action = 'resolve' | 'issue' | 'rotate' | 'revoke' | 'suspend';
const ROUTES: Record<string, Action> = {
  '/internal/mcp/auth/resolve': 'resolve',
  '/internal/mcp/auth/issue': 'issue',
  '/internal/mcp/auth/rotate': 'rotate',
  '/internal/mcp/auth/revoke': 'revoke',
  '/internal/mcp/auth/suspend': 'suspend',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function str(body: Record<string, unknown>, key: string, pattern: RegExp): string | undefined {
  const value = body[key];
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

export async function handleMcpAuth(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
  secret: string | null | undefined,
): Promise<void> {
  if (!authenticated(req, secret)) return fail(res, 'unauthorized');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: { code: 'invalid_request', message: 'POST required.' } });
  }
  const action = ROUTES[req.url ?? ''];
  if (!action) return json(res, 404, { error: { code: 'not_found', message: 'Unknown auth route.' } });
  if (!/^application\/json(?:\s*;.*)?$/i.test(header(req, 'content-type') ?? '')) {
    return fail(res, 'invalid_request');
  }

  let body: Record<string, unknown>;
  try {
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
    const record = asRecord(value);
    if (!record) throw new Error('invalid_request');
    body = record;
  } catch {
    res.setHeader('Connection', 'close');
    return fail(res, 'invalid_request');
  }

  let rpc: string;
  let args: Record<string, unknown>;
  if (action === 'resolve') {
    const token_hash = str(body, 'token_hash', HEX64);
    if (!token_hash || Object.keys(body).join(',') !== 'token_hash') return fail(res, 'invalid_request');
    rpc = 'mcp_resolve_bot_token';
    args = { p_token_hash: token_hash };
  } else if (action === 'issue') {
    const bot_id = str(body, 'bot_id', BOT);
    const token_hash = str(body, 'token_hash', HEX64);
    const actor = str(body, 'actor', ACTOR);
    const label = body.label === undefined ? undefined : str(body, 'label', /^[\x20-\x7E]{1,100}$/);
    if (!bot_id || !token_hash || !actor || (body.label !== undefined && !label)) return fail(res, 'invalid_request');
    rpc = 'mcp_issue_bot_token';
    args = { p_bot_id: bot_id, p_token_hash: token_hash, p_actor: actor, p_label: label ?? null };
  } else if (action === 'rotate') {
    const old_token_hash = str(body, 'old_token_hash', HEX64);
    const new_token_hash = str(body, 'new_token_hash', HEX64);
    const actor = str(body, 'actor', ACTOR);
    const label = body.label === undefined ? undefined : str(body, 'label', /^[\x20-\x7E]{1,100}$/);
    if (!old_token_hash || !new_token_hash || !actor || (body.label !== undefined && !label)) {
      return fail(res, 'invalid_request');
    }
    rpc = 'mcp_rotate_bot_token';
    args = { p_old_token_hash: old_token_hash, p_new_token_hash: new_token_hash, p_actor: actor, p_label: label ?? null };
  } else if (action === 'revoke') {
    const token_hash = str(body, 'token_hash', HEX64);
    const actor = str(body, 'actor', ACTOR);
    const reason = body.reason === undefined ? undefined : str(body, 'reason', /^[\x20-\x7E]{1,200}$/);
    if (!token_hash || !actor || (body.reason !== undefined && !reason)) return fail(res, 'invalid_request');
    rpc = 'mcp_revoke_bot_token';
    args = { p_token_hash: token_hash, p_actor: actor, p_reason: reason ?? null };
  } else {
    const bot_id = str(body, 'bot_id', BOT);
    const actor = str(body, 'actor', ACTOR);
    const reason = body.reason === undefined ? undefined : str(body, 'reason', /^[\x20-\x7E]{1,200}$/);
    if (!bot_id || !actor || (body.reason !== undefined && !reason)) return fail(res, 'invalid_request');
    rpc = 'mcp_suspend_bot';
    args = { p_bot_id: bot_id, p_actor: actor, p_reason: reason ?? null };
  }

  try {
    const { data, error } = await sb.rpc(rpc, args).abortSignal(AbortSignal.timeout(12_000));
    if (error) {
      return fail(res, error.code === 'P0001' && Object.hasOwn(ERRORS, error.message)
        ? error.message : 'internal_error');
    }
    if (action === 'resolve') {
      if (!data || typeof data !== 'object' || typeof (data as { found?: unknown }).found !== 'boolean') {
        return fail(res, 'internal_error');
      }
      return json(res, 200, data);
    }
    json(res, 200, data);
  } catch {
    fail(res, 'internal_error');
  }
}
