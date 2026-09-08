import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { handleMcpAuth } from './auth-route.js';

const HASH = 'ab'.repeat(32);
const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: { found: false }, error: null }) }));
let server: http.Server;
let port: number;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    void handleMcpAuth(req, res, { rpc } as unknown as SupabaseClient, 'credential');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); });

function send(path: string, body: string, authorization: string | string[] = 'Bearer credential') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: [
      'host', `127.0.0.1:${port}`, 'content-length', String(Buffer.byteLength(body)),
      ...[authorization].flat().flatMap(value => ['authorization', value]),
      'content-type', 'application/json',
    ] }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(text) }); }
        catch { reject(new Error(`Non-JSON HTTP ${res.statusCode} response`)); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

it('resolves by hash and never echoes the hash on errors', async () => {
  const result = await send('/internal/mcp/auth/resolve', JSON.stringify({ token_hash: HASH }));
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ found: false });
  expect(rpc).toHaveBeenCalledWith('mcp_resolve_bot_token', { p_token_hash: HASH });
  const denied = await send('/internal/mcp/auth/resolve', JSON.stringify({ token_hash: HASH }), 'Bearer wrong');
  expect(denied.status).toBe(401);
  expect(JSON.stringify(denied.body)).not.toContain(HASH);
});

it('rejects malformed resolve bodies without calling RPC', async () => {
  rpc.mockClear();
  const result = await send('/internal/mcp/auth/resolve', JSON.stringify({ token_hash: 'nope' }));
  expect(result.status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});
