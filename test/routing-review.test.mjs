import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {normalizeSnapshot} from '../quota-snapshots.mjs';
import {routeQueue,dispatchTask} from '../task-router.mjs';
import {run} from '../router-cli.mjs';

const HOUR=3600e3;
const win=(name,pct,ms)=>({name,remainingPercent:pct,resetsAt:new Date(ms).toISOString(),resetTimezone:'UTC'});
const fresh=(o={})=>({schema:1,source:'manual',reviewed:true,provider:'claude',accountScope:'claude-main',modelScope:'sonnet',observedAt:new Date(Date.now()-60000).toISOString(),
  windows:[win('session',80,Date.now()+4*HOUR),win('weekly',60,Date.now()+120*HOUR)],...o});
const agySnap=(o={})=>fresh({provider:'antigravity',accountScope:'agy-main',modelScope:'gemini-3.8-flash-medium',windows:[win('session',70,Date.now()+4*HOUR)],...o});
const CLAUDE={provider:'claude',mode:'dispatch',accountScope:'claude-main',modelScope:'sonnet',roles:['draft','implementation'],maxSize:'large',maxAgeSeconds:900,requiredWindows:['session','weekly'],reservePercent:{session:10,weekly:10}};
const AGY={provider:'antigravity',mode:'dispatch',accountScope:'agy-main',modelScope:'gemini-3.8-flash-medium',roles:['draft','prototype'],maxSize:'medium',maxAgeSeconds:900,requiredWindows:['session'],reservePercent:{session:10}};
const policy=(...providers)=>({schema:1,reviewed:true,providers});
const SCOPE={reviewed:true,acceptInheritedPermissions:true,acknowledgeInstructionScope:true,mode:'plan',description:'Draft plain text only.'};
const task=(o={})=>({id:randomUUID(),prompt:'Write a haiku about tests.',classification:'public',approval:'not-required',providers:['claude'],role:'draft',size:'small',permissionScope:'text-only',timeoutSeconds:60,
  estimates:{claude:{durationSeconds:30,windows:{session:5,weekly:2}}},allowExecute:true,...o});
const agyTask=(o={})=>task({providers:['antigravity'],role:'prototype',taskScope:SCOPE,estimates:{antigravity:{durationSeconds:30,windows:{session:5}}},...o});
const spies=()=>{
  const calls={preflight:0,executor:0};
  return {calls,deps:{preflight:async()=>{calls.preflight++;},executor:async()=>{calls.executor++;return {state:'executed'};}}};
};
const tmp=async t=>{const d=await mkdtemp(path.join(tmpdir(),'route-review-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;};
const exists=f=>access(f).then(()=>true,()=>false);
// Yields `good` for the first two reads (initial decision, post-preflight decision) and `bad` from the third on.
const flaky=(good,bad,onBad)=>{let n=0;return {[Symbol.iterator](){n++;if(n>=3)onBad?.();return (n>=3?bad:good)[Symbol.iterator]();}};};

test('supported-export provenance keeps only the allowlist and still requires verification',()=>{
  const base=fresh({source:'supported-export',reviewed:undefined});
  const s=normalizeSnapshot({...base,provenance:{adapter:'demo',scopeVerified:true,account:'x',billing:1,raw:'y'}});
  assert.deepEqual(s.provenance,{adapter:'demo',scopeVerified:true});
  assert.ok(!JSON.stringify(s).includes('billing'));
  for(const p of [{adapter:'demo',scopeVerified:false,extra:1},{scopeVerified:true,extra:1},{adapter:'Bad Name',scopeVerified:true}])
    assert.throws(()=>normalizeSnapshot({...base,provenance:p}),e=>e.code==='provenance_required');
});

test('a wrong-model policy and snapshot never authorize a call',async t=>{
  const cases=[[task(),policy({...CLAUDE,modelScope:'opus'}),[fresh({modelScope:'opus'})]],
    [agyTask(),policy({...AGY,modelScope:'opus'}),[agySnap({modelScope:'opus'})]]];
  for(const [tk,pol,snaps] of cases) {
    const root=await tmp(t),{calls,deps}=spies();
    assert.throws(()=>routeQueue({schema:1,tasks:[tk]},snaps,pol,{now:Date.now()}),e=>e.code==='model_scope_mismatch');
    const out=await dispatchTask({schema:1,tasks:[tk]},snaps,pol,tk.id,{...deps,root});
    assert.equal(out.launched,false);assert.deepEqual(out.reasons,['model_scope_mismatch']);
    assert.equal(calls.preflight,0);assert.equal(calls.executor,0);
    assert.equal(await exists(path.join(root,'routing',tk.id)),false);
  }
});

test('execute fails closed on any rejected snapshot import; dry run warns',async t=>{
  const dir=await tmp(t),tk=task(),{calls,deps}=spies();
  const f=async(n,v)=>{await writeFile(path.join(dir,n),JSON.stringify(v));return path.join(dir,n);};
  const q=await f('q.json',{schema:1,tasks:[tk]}),p=await f('p.json',policy(CLAUDE)),s=await f('s.json',{schema:1,snapshots:[fresh(),fresh({observedAt:'bad'})]});
  const go=async argv=>{let out='';const code=await run(argv,{write:x=>{out+=x;},writeErr:()=>{},deps:{...deps,root:dir}});return {code,json:JSON.parse(out)};};
  const base=['--queue',q,'--snapshots',s,'--policy',p];
  const ex=await go(['execute',...base,'--task',tk.id,'--confirm-execute']);
  assert.equal(ex.code,2);assert.equal(ex.json.launched,false);assert.deepEqual(ex.json.reasons,['snapshot_import_rejected']);
  assert.deepEqual(ex.json.snapshotImport.rejected,[{index:1,reason:'invalid_observed_at'}]);
  assert.equal(calls.preflight,0);assert.equal(calls.executor,0);
  assert.equal(await exists(path.join(dir,'routing')),false);
  const dry=await go(base);
  assert.equal(dry.code,0);assert.ok(dry.json.warnings.includes('partial_snapshot_import_cannot_authorize_live_call'));
  assert.equal(dry.json.decisions[0].status,'eligible');
  assert.equal(calls.executor,0);
});

test('quota turning ineligible during preflight blocks before any reservation',async t=>{
  const root=await tmp(t),tk=task(),snaps=[fresh()],calls={executor:0};
  const deps={root,preflight:async()=>{snaps[0]=fresh({observedAt:new Date(Date.now()-HOUR).toISOString()});},executor:async()=>{calls.executor++;return {state:'executed'};}};
  const out=await dispatchTask({schema:1,tasks:[tk]},snaps,policy(CLAUDE),tk.id,deps);
  assert.equal(out.outcome,'blocked');assert.equal(out.launched,false);assert.deepEqual(out.reasons,['eligibility_changed']);
  assert.equal(calls.executor,0);
  assert.equal(await exists(path.join(root,'routing',tk.id)),false);
});

test('final check after reservation keeps the reservation and launches nothing',async t=>{
  const stale=()=>[fresh({observedAt:new Date(Date.now()-HOUR).toISOString()})];
  const read=(root,id,f)=>readFile(path.join(root,'routing',id,f),'utf8').then(JSON.parse);
  {
    const root=await tmp(t),tk=task(),{calls,deps}=spies();
    const out=await dispatchTask({schema:1,tasks:[tk]},flaky([fresh()],stale()),policy(CLAUDE),tk.id,{...deps,root});
    assert.equal(out.outcome,'blocked');assert.deepEqual(out.reasons,['eligibility_changed']);assert.equal(out.launched,false);assert.equal(out.reserved,true);
    assert.equal(calls.preflight,1);assert.equal(calls.executor,0);
    const led=await read(root,tk.id,'outcome.json');
    assert.equal(led.state,'unknown');assert.equal(led.phase,'blocked_before_launch');
    assert.equal((await read(root,tk.id,'reservation.json')).id,tk.id);
  }
  {
    const root=await tmp(t),tk=task(),{calls,deps}=spies(),ctl=new AbortController();
    const out=await dispatchTask({schema:1,tasks:[tk]},flaky([fresh()],[fresh()],()=>ctl.abort()),policy(CLAUDE),tk.id,{...deps,root,signal:ctl.signal});
    assert.equal(out.outcome,'canceled_before_dispatch');assert.equal(out.launched,false);assert.equal(out.reserved,true);
    assert.equal(calls.executor,0);
    const led=await read(root,tk.id,'outcome.json');
    assert.equal(led.state,'unknown');assert.equal(led.phase,'canceled_before_dispatch');
  }
});

test('obvious secrets in an Antigravity task scope description block routing',()=>{
  const key='AKIA'+'ABCDEFGHIJKLMNOP';
  const tk=agyTask({taskScope:{...SCOPE,description:`Use ${key} for drafting.`}});
  const d=routeQueue({schema:1,tasks:[tk]},[agySnap()],policy(AGY),{now:Date.now()}).decisions[0];
  assert.equal(d.status,'blocked');assert.deepEqual(d.reasons,['secret_pattern']);
  const ok=routeQueue({schema:1,tasks:[agyTask()]},[agySnap()],policy(AGY),{now:Date.now()}).decisions[0];
  assert.equal(ok.status,'eligible');
});
