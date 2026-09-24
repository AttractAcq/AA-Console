import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { handleMcpContent } from './content-route.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const BRIEF = '44444444-4444-4444-8444-444444444444';
const PENDING = '55555555-5555-4555-8555-555555555555';
const SECRET = 'test-only-service-credential';

function call(body: unknown, bot = 'bot_production', sb?: SupabaseClient) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${SECRET}`,
    'x-aa-bot-id': bot,
    'x-request-id': 'request-1',
    'idempotency-key': 'execution-1',
    'content-type': 'application/json',
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flat();
  req.method = 'POST';
  req.url = '/internal/mcp/content/create-upload-url';
  let status = 0;
  let jsonBody: any;
  const res = Object.assign(new EventEmitter(), {
    writeHead: (code: number) => { status = code; },
    setHeader: () => undefined,
    end: (data: string) => { jsonBody = JSON.parse(data); },
  }) as unknown as ServerResponse;
  const client = sb ?? {
    rpc: vi.fn(() => ({
      abortSignal: async () => ({
        data: {
          client_id: CLIENT,
          brief_id: BRIEF,
          pending_asset_id: PENDING,
          storage_path: `${CLIENT}/${PENDING}.png`,
          content_type: 'image/png',
          expires_at: '2026-09-24T12:00:00.000Z',
          replayed: false,
        },
        error: null,
      }),
    })),
    storage: {
      from: (bucket: string) => ({
        createSignedUploadUrl: async (path: string, options: { upsert: boolean }) => {
          expect(bucket).toBe('client-media');
          expect(options.upsert).toBe(false);
          expect(path).toBe(`${CLIENT}/${PENDING}.png`);
          return {
            data: {
              signedUrl: `https://example.test/storage/v1/object/upload/sign/client-media/${path}?token=once`,
              token: 'once',
              path,
            },
            error: null,
          };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return handleMcpContent(req, res, client, SECRET).then(() => ({
    status,
    body: jsonBody,
  }));
}

describe('content.create_upload_url route', () => {
  it('mints a signed PUT URL for production and hides it from CoS', async () => {
    const minted = await call({
      client_id: CLIENT,
      brief_id: BRIEF,
      content_type: 'image/png',
      filename: 'pack-01.png',
    });
    expect(minted.status).toBe(200);
    expect(minted.body.upload_url).toContain('token=once');
    expect(minted.body.storage_path).toBe(`${CLIENT}/${PENDING}.png`);
    expect(minted.body.pending_asset_id).toBe(PENDING);
    expect(minted.body.headers['content-type']).toBe('image/png');
    expect(minted.body.token).toBeUndefined();
    expect(JSON.stringify(minted.body)).not.toContain('service_role');

    const sb = {
      rpc: vi.fn(() => ({
        abortSignal: async () => ({
          data: {
            client_id: CLIENT,
            brief_id: BRIEF,
            brief_status: 'draft',
            eligible: true,
            read_check: true,
          },
          error: null,
        }),
      })),
      storage: { from: () => { throw new Error('CoS must not mint'); } },
    } as unknown as SupabaseClient;
    const checked = await call({
      client_id: CLIENT,
      brief_id: BRIEF,
      content_type: 'image/png',
    }, 'bot_chief_of_staff', sb);
    expect(checked.status).toBe(200);
    expect(checked.body).toEqual({
      client_id: CLIENT,
      brief_id: BRIEF,
      brief_status: 'draft',
      eligible: true,
      read_check: true,
    });
  });
});
