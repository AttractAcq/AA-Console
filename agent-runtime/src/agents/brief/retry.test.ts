import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RuntimeConfig } from '../../config.js';
import type { AgentRow } from '../../orchestration/registry.js';
import type { AgentJobRow } from '../../queue.js';
const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('../../tools/anthropic.js', async () => ({
  ...await vi.importActual('../../tools/anthropic.js'), runAgentLoop: model,
}));
vi.mock('../shared.js', () => ({ loadUpstreamRecords: async () => [] }));
vi.mock('../identity.js', () => ({ loadIdentity: async () => ({}), identityWriterBlock: () => 'Identity' }));
vi.mock('../proof.js', () => ({ loadUsableProof: async () => [], renderProof: () => 'No proof', proofIdForRef: (rows: {id:string;ref_number:string}[], ref: string) => rows.find((r) => r.ref_number === ref)?.id ?? null }));
import { runBriefJob } from './index.js';

const job = { id: 'job', client_id: 'client', input_table: 'client_ideas', input_id: 'idea' } as AgentJobRow;
const config = { anthropicApiKeyByAgent: {}, anthropicApiKey: 'test' } as RuntimeConfig;
const agent = { agent_key: 'brief' } as AgentRow;
const existing = { id: 'brief', client_id: 'client', source_idea_id: 'idea', title: 'Human edited' };
function database(options: { existing?: typeof existing; conflict?: boolean; error?: string; wrongOwner?: boolean;
  proof?: Record<string, unknown>; idea?: Record<string, unknown>; pillar?: Record<string, unknown>;
  brand?: Record<string, unknown>;
  selectionCurrent?: boolean } = {}) {
  let saved: Record<string, unknown> | undefined = options.existing;
  const insert = vi.fn(async (row: Record<string, unknown>) => {
    if (options.error) return { error: { code: options.error, message: 'write failed' } };
    if (options.conflict) {
      saved = { ...existing, client_id: options.wrongOwner ? 'other' : 'client' };
      return { error: { code: '23505', message: 'unique violation' } };
    }
    saved = { id: 'new-brief', ...row };
    return { error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === 'agent_job_events') return { insert: vi.fn(async () => ({ error: null })) };
    const query: any = {
      select: () => query, eq: () => query, is: () => query,
      neq: async () => ({ count: 0 }),
      maybeSingle: async () => ({ error: null, data: table === 'client_briefs' ? saved ?? null
        : table === 'client_proof_assets' ? options.proof ?? null
        : table === 'client_content_pillars' ? options.pillar ?? null
        : table === 'client_brand_profiles' ? options.brand ?? null
        : table === 'client_ideas' ? { id: 'idea', title: 'Idea', media_type: 'image', ...options.idea } : { name: 'Client' } }),
      insert,
    };
    return query;
  });
  const rpc = vi.fn(async () => ({ data: options.selectionCurrent !== false, error: null }));
  return { sb: { from, rpc } as unknown as SupabaseClient, insert, rpc, saved: () => saved };
}
beforeEach(() => {
  vi.clearAllMocks();
  model.mockResolvedValue({ submitted: {
    title: 'Generated title', hook: 'Start with the customer question.',
    premise: 'A practical piece about the service.', argument: 'Explain how it works and what the buyer should ask.',
    proof: 'No proof claim.', script: 'Here are the three questions to ask before booking a consultation. Discuss the process and what happens next.',
    visual_direction: 'A simple still image with clear type.', call_to_action: 'Ask a question.',
    channel_intent: 'Organic social', production_notes: 'Use the existing brand assets.',
  }, usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 } });
});
const run = (sb: SupabaseClient) => runBriefJob(sb, config, agent, job, Date.now() + 60_000);
describe('brief worker retry persistence', () => {
  it('holds a stale selection before calling the model or writing a brief', async () => {
    const db = database({ selectionCurrent: false });
    expect((await run(db.sb)).ok).toBe(false);
    expect(db.rpc).toHaveBeenCalledWith('brief_job_selection_current_v6', { p_job_id: job.id });
    expect(model).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('reuses a persisted output on retry without another model call or overwrite', async () => {
    const db = database();
    expect((await run(db.sb)).ok).toBe(true);
    const first = db.saved();
    expect((await run(db.sb)).ok).toBe(true);
    expect(db.insert).toHaveBeenCalledOnce();
    expect(model).toHaveBeenCalledOnce();
    expect(db.saved()).toBe(first);
  });
  it('preserves a human-edited existing brief', async () => {
    const db = database({ existing });
    expect(await run(db.sb)).toEqual({ ok: true, retryable: false });
    expect(model).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.saved()?.title).toBe('Human edited');
  });
  it('accepts a concurrent winner after a unique violation and preserves its content', async () => {
    const db = database({ conflict: true });
    expect((await run(db.sb)).ok).toBe(true);
    expect(db.insert).toHaveBeenCalledOnce();
    expect(db.saved()?.title).toBe('Human edited');
  });
  it('does not mask a uniqueness error without a matching persisted brief', async () => {
    await expect(run(database({ error: '23505' }).sb)).rejects.toThrow('Failed to write brief');
    await expect(run(database({ conflict: true, wrongOwner: true }).sb)).rejects.toThrow('does not match');
  });
  it('does not mask unrelated database failures', async () => {
    await expect(run(database({ error: '23503' }).sb)).rejects.toThrow('Failed to write brief');
  });
});

describe('proof factory selected source', () => {
  const pinnedJob = {...job, params: {proof_factory_source_id: 'proof-1'}};
  const proof = {id:'proof-1',ref_number:'PRF-1',usage_rights:'approved',permission_basis:'Customer consent',expires_on:null};
  it('rejects revoked sources before calling a model', async () => {
    const db=database({proof:{...proof,usage_rights:'restricted'}});
    expect((await runBriefJob(db.sb,config,agent,pinnedJob,Date.now()+60_000)).ok).toBe(false);
    expect(model).not.toHaveBeenCalled();
  });
  it('rejects a model response that does not cite the selected source', async () => {
    const db=database({proof});
    expect((await runBriefJob(db.sb,config,agent,pinnedJob,Date.now()+60_000)).ok).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('persists the selected source when the model cites it', async () => {
    const result=await model();
    model.mockClear();
    model.mockResolvedValue({...result,submitted:{...result.submitted,proof_ref:'PRF-1'}});
    const db=database({proof});
    expect((await runBriefJob(db.sb,config,agent,pinnedJob,Date.now()+60_000)).ok).toBe(true);
    expect(db.saved()?.proof_asset_id).toBe('proof-1');
  });
});

describe('exact idea sources in a production brief', () => {
  const proof = {id:'proof-1',ref_number:'PRF-1',usage_rights:'approved',permission_basis:'Customer consent',expires_on:null};
  const pillar = {id:'pillar-1',client_id:'client',active:true,name:'Care decisions',
    premise:'Explain when to seek help',belongs:'Buyer questions',does_not_belong:'Unproven claims'};

  it('carries the active selected pillar and cleared idea proof into the brief', async () => {
    const response = await model();
    model.mockClear();
    model.mockResolvedValue({...response, submitted:{...response.submitted,proof_ref:'PRF-1'}});
    const db = database({idea:{pillar_id:'pillar-1',proof_id:'proof-1'},pillar,proof});
    expect((await run(db.sb)).ok).toBe(true);
    expect(model.mock.calls[0]?.[0]?.prompt).toContain('Care decisions: Explain when to seek help');
    expect(db.saved()?.proof_asset_id).toBe('proof-1');
  });

  it('holds a retired selected pillar and a revoked idea proof before calling the model', async () => {
    const retired = database({idea:{pillar_id:'pillar-1'},pillar:{...pillar,active:false}});
    expect((await run(retired.sb)).ok).toBe(false);
    expect(model).not.toHaveBeenCalled();
    const revoked = database({idea:{proof_id:'proof-1'},proof:{...proof,usage_rights:'restricted'}});
    expect((await run(revoked.sb)).ok).toBe(false);
    expect(model).not.toHaveBeenCalled();
  });

  it('uses the recorded visual brand in a still-image brief', async () => {
    const db = database({brand:{colour_primary:'#123456',colour_secondary:null,
      colour_accent:null,colour_background:null,colour_text:null,
      font_heading:'Inter',font_body:null,imagery_style:'Clean diagrams',
      lighting:null,mood:null,composition_notes:null,never_do:'No gradients'}});
    expect((await run(db.sb)).ok).toBe(true);
    const prompt = String(model.mock.calls[0]?.[0]?.prompt ?? '');
    expect(prompt).toContain('exactly #123456');
    expect(prompt).toContain('No gradients');
  });
});
