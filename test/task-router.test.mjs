import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execute} from '../wrapper.mjs';
import {routeQueue,dispatchTask,validatePolicy} from '../task-router.mjs';
import {run} from '../router-cli.mjs';

const NOW=Date.parse('2026-10-02T12:00:00Z');
const EXP=Date.parse('2026-10-02T22:00:00Z');
const iso=ms=>new Date(ms).toISOString();
const win=(name,pct,resetsAt,tz='UTC')=>({name,remainingPercent:pct,resetsAt,resetTimezone:tz});
const snap=(o={})=>({schema:1,source:'manual',reviewed:true,provider:'claude',accountScope:'claude-main',modelScope:'sonnet',observedAt:'2026-10-02T11:55:00Z',windows:[win('session',80,'2026-10-02T16:00:00Z'),win('weekly',60,'2026-10-08T00:00:00Z')],...o});
const agySnap=(o={})=>snap({provider:'antigravity',accountScope:'agy-main',modelScope:'gemini-3.8-flash-medium',windows:[win('session',70,'2026-10-02T17:00:00Z')],...o});
const CLAUDE={provider:'claude',mode:'dispatch',accountScope:'claude-main',modelScope:'sonnet',roles:['draft','implementation'],maxSize:'large',maxAgeSeconds:900,requiredWindows:['session','weekly'],reservePercent:{session:10,weekly:10}};
const AGY={provider:'antigravity',mode:'dispatch',accountScope:'agy-main',modelScope:'gemini-3.8-flash-medium',roles:['draft','prototype'],maxSize:'medium',maxAgeSeconds:900,requiredWindows:['session'],reservePercent:{session:10}};
const CODEX={provider:'codex',mode:'handoff',roles:['coordination','verification','review'],maxSize:'large'};
const policy=(o={})=>({schema:1,reviewed:true,preference:{provider:'claude',until:'2026-10-03T07:00:00+09:00'},providers:[CLAUDE,AGY,CODEX],...o});
const SCOPE={reviewed:true,acceptInheritedPermissions:true,acknowledgeInstructionScope:true,mode:'plan',description:'Draft plain text only.'};
let n=0;
const uuid=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
const task=(o={})=>({id:uuid(),prompt:'Write a haiku about tests.',classification:'public',approval:'not-required',providers:['claude'],role:'draft',size:'small',permissionScope:'text-only',timeoutSeconds:60,
  estimates:{claude:{durationSeconds:30,windows:{session:5,weekly:2}}},allowExecute:true,...o});
const agyTask=(o={})=>task({providers:['antigravity'],role:'prototype',taskScope:SCOPE,estimates:{antigravity:{durationSeconds:30,windows:{session:5}}},...o});
const route=(tasks,snaps=[snap()],pol=policy(),now=NOW)=>routeQueue({schema:1,tasks},snaps,pol,{now}).decisions;
const one=(...a)=>route([a[0]],...a.slice(1))[0];

test('baseline eligible Claude task uses the verified model',()=>{
  const d=one(task());
  assert.equal(d.status,'eligible');assert.equal(d.provider,'claude');assert.equal(d.model,'sonnet');
  assert.equal(d.liveAuthorized,true);assert.equal(d.quotaSource,'manual');
  const t=task(),a=route([t]),b=route([t]);
  assert.deepEqual(a,b);
  assert.equal(a[0].id,t.id);assert.equal(a[0].executePermitted,true);assert.deepEqual(a[0].warnings,[]);
  assert.deepEqual(a[0].candidates,[{provider:'claude',mode:'dispatch',reasons:[]}]);
});

test('dry run is deterministic and does not accumulate state across calls',()=>{
  const q={schema:1,tasks:[task()]};
  assert.deepEqual(routeQueue(q,[snap()],policy(),{now:NOW}),routeQueue(q,[snap()],policy(),{now:NOW}));
});

test('freshness boundary: exact max age fresh, +1ms stale, future blocked',()=>{
  const at=observedAt=>one(task(),[snap({observedAt})]);
  assert.equal(at('2026-10-02T11:45:00Z').status,'eligible');
  assert.deepEqual(at('2026-10-02T11:44:59.999Z').reasons,['snapshot_stale']);
  assert.equal(at('2026-10-02T12:00:00Z').status,'eligible');
  assert.deepEqual(at('2026-10-02T12:00:00.001Z').reasons,['snapshot_future']);
});

test('reset boundaries, including non-UTC offsets, block conservatively',()=>{
  const dur=(s,resetsAt,tz)=>one(task({estimates:{claude:{durationSeconds:s,windows:{session:5,weekly:2}}}}),[snap({windows:[win('session',80,resetsAt,tz),win('weekly',60,'2026-10-08T00:00:00Z')]})]);
  const d=dur(30,'2026-10-02T12:00:30Z');
  assert.deepEqual(d.reasons,['reset_before_completion']);
  assert.equal(d.deferUntil,'2026-10-02T12:00:30.000Z');
  assert.equal(dur(29,'2026-10-02T12:00:30Z').status,'eligible');
  assert.deepEqual(dur(30,'2026-10-02T12:00:00Z').reasons,['window_expired']);
  assert.deepEqual(dur(30,'2026-10-02T21:00:00+09:00','Asia/Tokyo').reasons,['window_expired']);
  assert.equal(dur(30,'2026-10-02T21:00:31+09:00','Asia/Tokyo').status,'eligible');
});

test('exhausted weekly window blocks even when session has capacity',()=>{
  const d=one(task(),[snap({windows:[win('session',80,'2026-10-02T16:00:00Z'),win('weekly',0,'2026-10-08T00:00:00Z')]})]);
  assert.equal(d.status,'blocked');assert.deepEqual(d.reasons,['window_exhausted']);
  const weekly=p=>one(task(),[snap({windows:[win('session',80,'2026-10-02T16:00:00Z'),win('weekly',p,'2026-10-08T00:00:00Z')]})]);
  assert.equal(weekly(12).status,'eligible');
  assert.deepEqual(weekly(11.9).reasons,['insufficient_headroom']);
  assert.deepEqual(one(task(),[snap({windows:[win('session',80,'2026-10-02T16:00:00Z')]})]).reasons,['window_missing']);
});

test('unknown, invalid or missing cost estimates block',()=>{
  for(const v of [-1,0,'3',null,101]) {
    const d=one(task({estimates:{claude:{durationSeconds:30,windows:{session:v,weekly:2}}}}));
    assert.equal(d.status,'blocked');assert.deepEqual(d.reasons,['invalid_estimate']);
  }
  assert.deepEqual(one(task({estimates:{}})).reasons,['missing_estimate']);
  assert.deepEqual(one(task({estimates:{claude:{durationSeconds:30,windows:{session:5}}}})).reasons,['missing_estimate']);
  assert.deepEqual(one(task({estimates:{claude:{durationSeconds:61,windows:{session:5,weekly:2}}}})).reasons,['duration_exceeds_timeout']);
});

test('provider, account and model mismatches block; pools are never merged',()=>{
  assert.deepEqual(one(task(),[snap({accountScope:'other'})]).reasons,['scope_mismatch']);
  assert.deepEqual(one(task(),[snap({modelScope:'opus'})]).reasons,['scope_mismatch']);
  assert.deepEqual(one(task(),[]).reasons,['no_snapshot']);
  assert.deepEqual(one(task(),[agySnap()]).reasons,['no_snapshot']);
  assert.deepEqual(one(agyTask(),[snap()]).reasons,['no_snapshot']);
  assert.deepEqual(one(agyTask(),[snap({accountScope:'agy-main',modelScope:'gemini-3.8-flash-medium'})]).reasons,['no_snapshot']);
});

test('conflicting snapshots block; identical duplicates do not',()=>{
  assert.equal(one(task(),[snap(),snap()]).status,'eligible');
  const other=snap({windows:[win('session',50,'2026-10-02T16:00:00Z'),win('weekly',60,'2026-10-08T00:00:00Z')]});
  assert.deepEqual(one(task(),[snap(),other]).reasons,['conflicting_snapshots']);
  assert.deepEqual(one(task(),[snap(),snap({source:'mock'})]).reasons,['conflicting_snapshots']);
});

test('duplicate and conflicting task ids never pick one silently',()=>{
  const a=task();
  const same=route([a,{...a}]);
  assert.deepEqual(same.map(d=>[d.status,d.reasons[0]]),[['blocked','duplicate_task_id'],['blocked','duplicate_task_id']]);
  const diff=route([a,{...a,prompt:'Different text.'}]);
  assert.deepEqual(diff.map(d=>[d.status,d.reasons[0]]),[['blocked','conflicting_task_id'],['blocked','conflicting_task_id']]);
});

test('batch reservations stop several tasks overspending one window',()=>{
  const heavy=()=>task({estimates:{claude:{durationSeconds:30,windows:{session:30,weekly:2}}}});
  const d=route([heavy(),heavy(),heavy()]);
  assert.deepEqual(d.map(x=>x.status),['eligible','eligible','blocked']);
  assert.deepEqual(d[2].reasons,['insufficient_headroom']);
});

test('classification, approval, permission, role, size and secret gates',()=>{
  for(const c of ['corporate','confidential','secret'])assert.deepEqual(one(task({classification:c})).reasons,['classification_blocked']);
  assert.deepEqual(one(task({classification:'personal'})).reasons,['personal_requires_approval']);
  assert.equal(one(task({classification:'personal',approval:'approved'})).status,'eligible');
  assert.deepEqual(one(task({approval:'required'})).reasons,['approval_required']);
  assert.equal(one(task({approval:'approved'})).status,'eligible');
  assert.deepEqual(one(task({permissionScope:'read-files'})).reasons,['invalid_permission_scope']);
  assert.deepEqual(one(task({tools:['bash']})).reasons,['invalid_task']);
  assert.deepEqual(one(task({role:'review'})).reasons,['role_not_allowed']);
  assert.deepEqual(one(task({prompt:`key ${'AKIA'+'A'.repeat(16)}`})).reasons,['secret_pattern']);
  assert.deepEqual(one(task({prompt:'x'.repeat(65537)})).reasons,['invalid_prompt']);
  assert.deepEqual(one(agyTask({size:'large'}),[agySnap()]).reasons,['size_exceeds_policy']);
});

test('policy cannot expand roles, upgrade Codex to dispatch or skip review',()=>{
  const code=p=>{try{validatePolicy(p);}catch(e){return e.code;}return 'accepted';};
  assert.equal(code(policy({providers:[{...CLAUDE,roles:['draft','review']}]})),'role_expansion');
  assert.equal(code(policy({providers:[{...CODEX,mode:'dispatch'}]})),'codex_handoff_only');
  assert.equal(code(policy({reviewed:false})),'invalid_policy');
  assert.equal(code(policy({preference:{provider:'codex-x',until:'2026-10-03T07:00:00+09:00'}})),'invalid_preference');
  assert.equal(code(policy({preference:{provider:'claude',until:'2026-10-03T07:00:00'}})),'invalid_preference');
});

test('Claude preference ends exactly at 2026-10-03T07:00 Asia/Tokyo and never overrides eligibility',()=>{
  assert.equal(EXP,Date.parse('2026-10-03T07:00:00+09:00'));
  const R='2026-10-03T03:00:00Z',obs='2026-10-02T21:59:00Z';
  const S=(claudePct=80)=>[snap({observedAt:obs,windows:[win('session',claudePct,R),win('weekly',60,'2026-10-08T00:00:00Z')]}),agySnap({observedAt:obs,windows:[win('session',70,R)]})];
  const reorder=policy({providers:[AGY,CLAUDE,CODEX]});
  const both=()=>task({providers:['claude','antigravity'],taskScope:SCOPE,estimates:{claude:{durationSeconds:30,windows:{session:5,weekly:2}},antigravity:{durationSeconds:30,windows:{session:5}}}});
  const before=one(both(),S(),reorder,EXP-1);
  assert.equal(before.provider,'claude');assert.equal(before.preferenceApplied,true);
  const at=one(both(),S(),reorder,EXP);
  assert.equal(at.provider,'antigravity');assert.equal(at.preferenceApplied,false);
  assert.equal(one(both(),S(0),reorder,EXP-1).provider,'antigravity');
  assert.equal(one(both(),S(),reorder,new Date(EXP-1)).provider,'claude');
  assert.equal(one(task({providers:['antigravity'],role:'draft',taskScope:SCOPE,estimates:{antigravity:{durationSeconds:30,windows:{session:5}}}}),S(),reorder,EXP-1).provider,'antigravity');
  const claudeOnly=one(task(),S(0),policy(),EXP-1);
  assert.equal(claudeOnly.status,'blocked');assert.deepEqual(claudeOnly.reasons,['window_exhausted']);
});

test('mock quota routes in dry run but is flagged and never live-authorized',()=>{
  const d=one(task(),[snap({source:'mock'})]);
  assert.equal(d.status,'eligible');assert.equal(d.liveAuthorized,false);
  assert.deepEqual(d.warnings,['mock_quota_not_live']);
});

test('Codex is handoff only and Antigravity requires plan mode and acknowledgments',()=>{
  const h=one(task({providers:['codex'],role:'review',estimates:{}}));
  assert.equal(h.status,'handoff');assert.equal(h.adapterRequired,true);assert.equal(h.model,undefined);
  assert.deepEqual(one(task({providers:['codex'],role:'draft',estimates:{}})).reasons,['role_not_allowed']);
  assert.equal(one(agyTask(),[agySnap()]).status,'eligible');
  assert.deepEqual(one(agyTask({taskScope:{...SCOPE,mode:'accept-edits'}}),[agySnap()]).reasons,['plan_mode_required']);
  assert.deepEqual(one(agyTask({taskScope:{...SCOPE,acceptInheritedPermissions:false}}),[agySnap()]).reasons,['invalid_wrapper_request']);
});

// ---- dispatch (all providers, preflight and privacy helpers are injected mocks) ----
const mkRoot=async t=>{const root=await mkdtemp(path.join(tmpdir(),'router-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;};
const OK={stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:'SYNTHETIC-ANSWER'}),stderr:'',exitCode:0,outputObserved:true,durationMs:5};
const plainExec=(r,root,o)=>execute(r,root,o);
const harness=(root,outcome=OK,extra={})=>{
  const calls={run:0,pre:0};
  return {calls,deps:{root,preflight:async()=>{calls.pre++;},privacyCheck:async()=>{},runner:async()=>{calls.run++;return typeof outcome==='function'?outcome():outcome;},...extra}};
};
const live=(o={})=>{const t=Date.now();return snap({observedAt:iso(t-1000),windows:[win('session',80,iso(t+4*3600e3)),win('weekly',60,iso(t+3*86400e3))],...o});};
const liveAgy=()=>{const t=Date.now();return agySnap({observedAt:iso(t-1000),windows:[win('session',70,iso(t+4*3600e3))]});};
const exists=f=>access(f).then(()=>true,()=>false);

test('dispatch success writes metadata-only ledger and blocks resubmission',async t=>{
  const root=await mkRoot(t),{deps,calls}=harness(root);
  const k=task({prompt:'UNIQUE-PROMPT-TEXT'}),q={schema:1,tasks:[k]};
  const res=await dispatchTask(q,[live()],policy(),k.id,deps);
  assert.equal(res.outcome,'dispatched');assert.equal(res.state,'executed');assert.equal(res.launched,true);assert.equal(res.resultCaptured,true);
  assert.equal(res.resultPath,`requests/${k.id}/result.json`);
  assert.match(res.responseSha256,/^[a-f0-9]{64}$/);
  assert.equal('response' in res,false);
  assert.deepEqual([calls.run,calls.pre],[1,1]);
  const text=(await Promise.all(['reservation.json','outcome.json'].map(f=>readFile(path.join(root,'routing',k.id,f),'utf8')))).join('');
  assert.ok(!text.includes('UNIQUE-PROMPT-TEXT')&&!text.includes('SYNTHETIC-ANSWER'));
  const again=await dispatchTask(q,[live()],policy(),k.id,deps);
  assert.equal(again.outcome,'already_reserved');assert.equal(calls.run,1);
  const changed=await dispatchTask({schema:1,tasks:[{...k,prompt:'changed'}]},[live()],policy(),k.id,deps);
  assert.equal(changed.outcome,'conflicting_task_payload');assert.equal(calls.run,1);
});

test('provider failure keeps reservation, stores no raw error and never falls back',async t=>{
  const root=await mkRoot(t);
  const fail={stdout:JSON.stringify({type:'result',subtype:'error',is_error:true,error:'RAW-PROVIDER-ERROR'}),stderr:'RAW-STDERR',exitCode:1,outputObserved:true,durationMs:3};
  const {deps,calls}=harness(root,fail,{executor:plainExec});
  const k=task({providers:['claude','antigravity'],taskScope:SCOPE,estimates:{claude:{durationSeconds:30,windows:{session:5,weekly:2}},antigravity:{durationSeconds:30,windows:{session:5}}}});
  const q={schema:1,tasks:[k]};
  const res=await dispatchTask(q,[live(),liveAgy()],policy(),k.id,deps);
  assert.equal(res.state,'rejected');assert.equal(res.provider,'claude');assert.equal(calls.run,1);
  const ledgerText=await readFile(path.join(root,'routing',k.id,'outcome.json'),'utf8');
  assert.ok(!ledgerText.includes('RAW-PROVIDER-ERROR')&&!ledgerText.includes('RAW-STDERR')&&!JSON.stringify(res).includes('RAW-'));
  assert.equal((await dispatchTask(q,[live(),liveAgy()],policy(),k.id,deps)).outcome,'already_reserved');
  assert.equal(calls.run,1);
});

test('unknown outcome (timeout) is preserved and never resubmitted',async t=>{
  const root=await mkRoot(t);
  const {deps,calls}=harness(root,{stdout:'',stderr:'',exitCode:null,reason:'timeout',outputObserved:false,durationMs:1},{executor:plainExec});
  const k=task(),q={schema:1,tasks:[k]};
  const res=await dispatchTask(q,[live()],policy(),k.id,deps);
  assert.deepEqual([res.state,res.reason],['unknown','timeout']);
  assert.equal((await dispatchTask(q,[live()],policy(),k.id,deps)).outcome,'already_reserved');
  assert.equal(calls.run,1);
});

test('cancellation before dispatch or during preflight never launches',async t=>{
  const root=await mkRoot(t);
  const pre=new AbortController();pre.abort();
  const h1=harness(root);const k=task();
  const r1=await dispatchTask({schema:1,tasks:[k]},[live()],policy(),k.id,{...h1.deps,signal:pre.signal});
  assert.equal(r1.outcome,'canceled_before_dispatch');assert.deepEqual([h1.calls.run,h1.calls.pre],[0,0]);
  assert.equal(await exists(path.join(root,'routing',k.id)),false);
  const mid=new AbortController(),k2=task();
  const h2=harness(root,OK,{preflight:async()=>{mid.abort();}});
  const r2=await dispatchTask({schema:1,tasks:[k2]},[live()],policy(),k2.id,{...h2.deps,signal:mid.signal});
  assert.equal(r2.outcome,'canceled_before_dispatch');assert.equal(h2.calls.run,0);
});

test('cancellation while running stays unknown and keeps the reservation',async t=>{
  const root=await mkRoot(t),c=new AbortController();
  const {deps,calls}=harness(root,()=>{c.abort();return {stdout:'',stderr:'',exitCode:null,reason:'canceled',outputObserved:false,durationMs:1};},{executor:plainExec});
  const k=task(),q={schema:1,tasks:[k]};
  const res=await dispatchTask(q,[live()],policy(),k.id,{...deps,signal:c.signal});
  assert.deepEqual([res.state,res.reason],['unknown','canceled']);
  assert.equal(await exists(path.join(root,'routing',k.id,'reservation.json')),true);
  assert.equal((await dispatchTask(q,[live()],policy(),k.id,deps)).outcome,'already_reserved');
  assert.equal(calls.run,1);
});

test('concurrent dispatch of one id launches at most once',async t=>{
  const root=await mkRoot(t);
  const {deps,calls}=harness(root,async()=>{await new Promise(r=>setTimeout(r,20));return OK;});
  const k=task(),q={schema:1,tasks:[k]};
  const out=await Promise.all([dispatchTask(q,[live()],policy(),k.id,deps),dispatchTask(q,[live()],policy(),k.id,deps)]);
  assert.deepEqual(out.map(o=>o.outcome).sort(),['already_reserved','dispatched']);
  assert.equal(calls.run,1);
});

test('dispatch refuses mock quota, missing execute permission, stale quota and unknown ids',async t=>{
  const root=await mkRoot(t),{deps,calls}=harness(root);
  const k=task();
  assert.deepEqual((await dispatchTask({schema:1,tasks:[k]},[live({source:'mock'})],policy(),k.id,deps)).reasons,['mock_quota_not_live']);
  const noPerm=task({allowExecute:false});
  assert.deepEqual((await dispatchTask({schema:1,tasks:[noPerm]},[live()],policy(),noPerm.id,deps)).reasons,['execute_not_permitted']);
  const stale=live({observedAt:iso(Date.now()-3600e3)});
  assert.deepEqual((await dispatchTask({schema:1,tasks:[k]},[stale],policy(),k.id,deps)).reasons,['snapshot_stale']);
  assert.deepEqual((await dispatchTask({schema:1,tasks:[k]},[live()],policy(),randomUUID(),deps)).reasons,['task_not_found']);
  assert.equal(calls.run,0);assert.equal(calls.pre,0);
  assert.deepEqual(await readdir(root),[]);
});

test('Codex dispatch reports handoff and never launches or reserves',async t=>{
  const root=await mkRoot(t),{deps,calls}=harness(root);
  const k=task({providers:['codex'],role:'review',estimates:{}});
  const res=await dispatchTask({schema:1,tasks:[k]},[],policy(),k.id,deps);
  assert.equal(res.outcome,'handoff_required');assert.equal(res.adapterRequired,true);assert.equal(res.launched,false);
  assert.equal(calls.run,0);assert.equal(await exists(path.join(root,'routing',k.id)),false);
});

test('preflight failure leaves no reservation and leaks no raw error',async t=>{
  const root=await mkRoot(t),calls={run:0};
  const k=task();
  const res=await dispatchTask({schema:1,tasks:[k]},[live()],policy(),k.id,{root,preflight:async()=>{throw Error('RAW-PREFLIGHT');},privacyCheck:async()=>{},runner:async()=>{calls.run++;return OK;}});
  assert.equal(res.outcome,'preflight_failed');assert.ok(!JSON.stringify(res).includes('RAW-PREFLIGHT'));
  assert.equal(calls.run,0);assert.equal(await exists(path.join(root,'routing',k.id)),false);
});

// ---- CLI ----
const ex=f=>fileURLToPath(new URL(`../examples/${f}`,import.meta.url));
const cliBase=['--queue',ex('routing-queue.example.json'),'--snapshots',ex('quota-snapshot.example.json'),'--policy',ex('routing-policy.example.json')];
const cli=async args=>{let out='',err='';const code=await run(args,{write:s=>{out+=s;},writeErr:s=>{err+=s;}});return {code,out,err};};

test('CLI dry run over the synthetic examples is the default',async()=>{
  const r=await cli([...cliBase,'--now','2026-10-02T12:00:00Z']);
  assert.equal(r.code,0);
  const j=JSON.parse(r.out);
  assert.equal(j.dryRun,true);assert.equal(j.preferenceActive,true);
  assert.deepEqual(j.decisions.map(d=>d.status),['eligible','eligible','handoff','blocked']);
  assert.deepEqual(j.decisions.slice(0,3).map(d=>d.provider),['claude','antigravity','codex']);
  assert.ok(j.decisions.slice(0,2).every(d=>d.liveAuthorized===false));
  assert.deepEqual(j.snapshotImport.rejected,[]);
});

test('CLI execute needs a task and confirmation, rejects --now and refuses the mock example',async()=>{
  const id='11111111-1111-4111-8111-111111111111';
  assert.equal((await cli(['execute',...cliBase])).code,1);
  assert.equal((await cli(['execute',...cliBase,'--task',id])).code,1);
  assert.equal((await cli(['execute',...cliBase,'--task',id,'--confirm-execute','--now','2026-10-02T12:00:00Z'])).code,1);
  assert.equal((await cli([...cliBase,'--task',id])).code,1);
  const r=await cli(['execute',...cliBase,'--task',id,'--confirm-execute']);
  assert.equal(r.code,2);
  const j=JSON.parse(r.out);
  assert.equal(j.launched,false);assert.equal(j.outcome,'blocked');
});
