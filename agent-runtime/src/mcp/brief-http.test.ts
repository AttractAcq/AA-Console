import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { handleMcpBrief } from './brief-route.js';
const rpc = vi.fn(() => ({ abortSignal: async () => ({ data: null, error: { code: 'XX000', message: 'secret stack trace' } }) }));
let server: http.Server;
let port: number;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    void handleMcpBrief(req, res, { rpc } as unknown as SupabaseClient, 'credential');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); });
function send(body: string, authorization: string | string[] = 'Bearer credential') {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/internal/mcp/content/generate-brief', headers: [
      'host', `127.0.0.1:${port}`, 'content-length', String(Buffer.byteLength(body)),
      ...[authorization].flat().flatMap(value => ['authorization', value]),
      'content-type', 'application/json', 'x-aa-bot-id', 'bot_production',
      'x-request-id', 'request', 'idempotency-key', 'execution',
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
it('flushes structured errors for oversized and malformed uploads over an actual socket', async () => {
  for (const body of ['x'.repeat(5000), '{bad']) {
    const result = await send(body);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('invalid_request');
  }
  expect(rpc).not.toHaveBeenCalled();
});
it('rejects duplicate Authorization headers even when Node discards one', async () => {
  expect((await send('{}', ['Bearer credential', 'Bearer wrong'])).status).toBe(401);
});
it('sanitizes unexpected database errors', async () => {
  const result = await send(JSON.stringify({ client_id: '11111111-1111-4111-8111-111111111111', idea_id: '33333333-3333-4333-8333-333333333333' }));
  expect(result.status).toBe(500);
  expect(result.body).toEqual({ error: { code: 'internal_error', message: 'Unable to process the request.' } });
  expect(JSON.stringify(result.body)).not.toContain('secret');
});

it('survives a client disconnect during an incomplete upload', async () => {
  await new Promise<void>(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', headers: {
      authorization: 'Bearer credential', 'content-type': 'application/json',
      'x-aa-bot-id': 'bot_production', 'x-request-id': 'aborted',
      'idempotency-key': 'aborted', 'content-length': '1000',
    } });
    req.on('error', () => { /* intentional disconnect */ });
    req.on('close', resolve);
    req.write('{');
    setTimeout(() => req.destroy(), 20);
  });
  const result = await send('{bad');
  expect(result.status).toBe(400);
});
