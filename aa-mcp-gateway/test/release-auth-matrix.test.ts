import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotAuthenticator, type AaResolveResult, type BotAuthMode } from '../src/auth/identity.js';
import { allowed, grants } from '../src/policy/permissions.js';
import { registry } from '../src/registry/tools.js';
import type { Bot } from '../src/shared/types.js';
const client='11111111-1111-4111-8111-111111111111';
const synthetic='release-matrix-synthetic-credential-000000';
const header=`Bearer ${synthetic}`;
const existing:Bot[]=['bot_production','bot_client_delivery','bot_chief_of_staff','bot_marketing','bot_distribution','bot_sales_ops'];
const active=(bot:Bot):AaResolveResult=>({found:true,status:'active',bot_id:bot,clients:[client],permissions:[...grants[bot]]});
const credentials=(bot:Bot)=>[{bot,clients:[client],token:synthetic}];
for(const bot of existing) {
 for(const mode of ['env','dual','db'] as BotAuthMode[]) test(`${bot}: ${mode} preserves main authentication behavior`,async()=>{
  let calls=0,current=active(bot),unavailable=false,now=0;
  const auth=new BotAuthenticator(mode,mode==='db'?[]:credentials(bot),async()=>{calls++;if(unavailable)throw Error('fixture outage');return current;},()=>{},()=>now);
  const result=await auth.authenticate(header);
  assert.equal(result.bot,bot);assert.deepEqual(result.clients,[client]);
  assert.deepEqual(result.permissions,mode==='db'?grants[bot]:undefined);
  assert.equal(calls,mode==='env'?0:1);
  current={...active(bot),status:'revoked_token'};
  assert.equal((await auth.authenticate(header)).bot,bot); // Preserve existing positive TTL.
  now=30_001;
  if(mode==='env')assert.equal((await auth.authenticate(header)).bot,bot);
  else await assert.rejects(auth.authenticate(header),/unauthorized/);
  now=60_002;unavailable=true;
  if(mode==='db')await assert.rejects(auth.authenticate(header),/unauthorized/);
  else assert.equal((await auth.authenticate(header)).bot,bot);
 });
 test(`${bot}: dual mismatches deny; misses preserve fallback`,async()=>{
  for(const result of [{...active(bot),clients:[]},{...active(bot),permissions:[]},{...active(bot),bot_id:'bot_finance' as Bot},{...active(bot),status:'suspended'}])await assert.rejects(new BotAuthenticator('dual',credentials(bot),async()=>result).authenticate(header),/unauthorized/);
  assert.equal((await new BotAuthenticator('dual',credentials(bot),async()=>({found:false})).authenticate(header)).bot,bot);
  await assert.rejects(new BotAuthenticator('db',[],async()=>({found:false})).authenticate(header),/unauthorized/);
 });
 test(`${bot}: workflow grants preserved; Admin and decision denied`,()=>{
  for(const action of ['create_task','assign_task','get_task','list_tasks','complete_task']){
   const tool=registry.find(t=>t.name===`workflow.${action}`)!;assert.ok(tool);assert.equal(allowed(bot,tool),true);
   assert.equal(allowed({bot,clients:[client],permissions:[]},tool),false);
  }
  for(const tool of registry.filter(t=>t.name.startsWith('admin.')||t.name==='workflow.record_decision'))assert.equal(allowed(bot,tool),false);
 });
}
for(const origin of ['https://gateway.example.test','http://localhost.evil.test','https://localhost','http://127.0.0.2','http://localhost','http://127.0.0.1'])test(`Admin env origin: ${origin}`,async()=>{
 const auth=BotAuthenticator.fromConfig({BOT_AUTH_MODE:'env',PUBLIC_ORIGIN:origin,bots:credentials('bot_admin')});
 if(['http://localhost','http://127.0.0.1'].includes(origin))assert.equal((await auth.authenticate(header)).bot,'bot_admin');
 else await assert.rejects(auth.authenticate(header),/unauthorized/);
});
for(const mode of ['dual','db'] as const)for(const change of ['revoked','suspended','removed-client','removed-permission','unavailable'])test(`Admin ${mode}: ${change} immediate`,async()=>{
 let current=active('bot_admin'),unavailable=false,calls=0;
 const auth=new BotAuthenticator(mode,mode==='dual'?credentials('bot_admin'):[],async()=>{calls++;if(unavailable)throw Error('fixture outage');return current;});
 assert.equal((await auth.authenticate(header)).bot,'bot_admin');
 if(change==='revoked')current={...current,status:'revoked_token'};
 if(change==='suspended')current={...current,status:'suspended'};
 if(change==='removed-client')current={...current,clients:[]};
 if(change==='removed-permission')current={...current,permissions:[]};
 if(change==='unavailable')unavailable=true;
 if(mode==='db'&&change==='removed-client')assert.deepEqual((await auth.authenticate(header)).clients,[]);
 else if(mode==='db'&&change==='removed-permission'){
  const identity=await auth.authenticate(header);assert.deepEqual(identity.permissions,[]);
  assert.equal(allowed(identity,registry.find(t=>t.name==='admin.list_events')!),false);
 }else await assert.rejects(auth.authenticate(header),/unauthorized/);
 assert.equal(calls,2);
});
test('Admin dual rejects both env/DB mismatch directions',async()=>{
 for(const [env,db] of [['bot_admin','bot_production'],['bot_production','bot_admin']] as [Bot,Bot][])await assert.rejects(new BotAuthenticator('dual',credentials(env),async()=>active(db)).authenticate(header),/unauthorized/);
});
