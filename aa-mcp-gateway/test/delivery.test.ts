import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { registry } from "../src/registry/tools.js";

const client = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const idea = "33333333-3333-4333-8333-333333333333";
const brief = "44444444-4444-4444-8444-444444444444";
const asset = "55555555-5555-4555-8555-555555555555";
const job = "66666666-6666-4666-8666-666666666666";
const identity = { bot: "bot_client_delivery" as const, clients: [client] };

async function mockAa(
  t: any,
  handler: (req: { url?: string; body: any }) => { status: number; body: unknown },
) {
  const received: { url?: string; method?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    received.push({ url: req.url, method: req.method, body });
    const result = handler({ url: req.url, body });
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const adapter = new AAApiAdapter({
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    token: "service-secret",
    timeoutMs: 1000,
  });
  return { adapter, received };
}

test('CDM discovery exposes delivery and granted reals only; scope denied before AA', async t => {
  let calls=0;
  const store=new Store(':memory:');t.after(()=>store.close());
  const engine=new ActionEngine(store,registry,{execute:async tool=>{calls++;return {status:'completed',capability:tool.name,data:{}};}});
  const names=engine.discover(identity).map(t=>t.name);
  assert.equal(names.filter(n=>n.startsWith('delivery.')).length,8);
  assert.ok(names.includes('content.get_production_status'));
  for(const n of ['workflow.get_pending_approvals','workflow.get_activity','workflow.create_approval']) assert.ok(names.includes(n));
  assert.ok(!names.includes('workflow.record_decision'));assert.ok(!names.includes('campaign.create'));
  for(const tool of registry.filter(t=>t.domain==='delivery' && t.name!=='delivery.list_clients')) {
    const r=await engine.call(identity,tool.name,{client_id:other,...(tool.action==='write'?{title:'Task',idempotency_key:'delivery-key'}:{})});
    assert.equal(r.status,'rejected');
  }
  assert.equal(calls,0);
});
test('all delivery adapters use scoped AA HTTP routes; task idempotency and list filtering',async t=>{
  const {adapter,received}=await mockAa(t,({url,body})=>({status:200,body:url?.endsWith('list-clients')?{clients:[{id:client,name:'Client'}],next_cursor:null}:{client_id:body.client_id,task:{id:job}}}));
  const store=new Store(':memory:');t.after(()=>store.close());const engine=new ActionEngine(store,registry,adapter);
  for(const tool of registry.filter(t=>t.domain==='delivery')) {
    const body=tool.name==='delivery.list_clients'?{}:{client_id:client,...(tool.action==='write'?{title:'Task',idempotency_key:'delivery-key',brief_id:brief,due_date:'2026-09-10'}:{})};
    assert.equal((await engine.call(identity,tool.name,body)).status,'completed',tool.name);
    if(tool.action==='write') {
      assert.equal((await engine.call(identity,tool.name,body)).status,'completed');
      assert.equal((await engine.call(identity,tool.name,{...body,title:'Changed'})).status,'rejected');
    }
  }
  assert.equal(received.length,8);
  assert.deepEqual(received.find(r=>r.url?.endsWith('create-task'))?.body,{client_id:client,title:'Task',brief_id:brief,due_date:'2026-09-10'});
});
test('rejects AA list leaking ungranted IDs and mismatched client response',async t=>{
  const {adapter}=await mockAa(t,({url})=>({status:200,body:url?.endsWith('list-clients')?{clients:[{id:other}],next_cursor:null}:{client_id:other}}));
  const store=new Store(':memory:');t.after(()=>store.close());const engine=new ActionEngine(store,registry,adapter);
  for(const [tool,body] of [['delivery.list_clients',{}],['delivery.get_status',{client_id:client}]] as const) {
    const r=await engine.call(identity,tool,body); assert.equal(r.status,'failed');assert.equal(r.error?.code,'malformed_response');
  }
});
