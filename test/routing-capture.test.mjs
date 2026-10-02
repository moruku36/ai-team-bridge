import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {importSnapshotFile} from '../quota-snapshots.mjs';
import {capturedResult,execute} from '../wrapper.mjs';
import {dispatchTask} from '../task-router.mjs';
import {run} from '../router-cli.mjs';

const RESPONSE='synthetic answer text for readback';
const sha=s=>createHash('sha256').update(s).digest('hex');
const exists=f=>access(f).then(()=>true,()=>false);
const ownRoots=[];
after(async()=>{for(const r of ownRoots)await rm(r,{recursive:true,force:true});});

async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'router-capture-'));
  ownRoots.push(root);
  const id=randomUUID();
  const now=Date.now(),at=ms=>new Date(now+ms).toISOString().replace('Z','+00:00');
  const files={queue:path.join(root,'q.json'),snapshots:path.join(root,'s.json'),policy:path.join(root,'p.json')};
  const queue={schema:1,tasks:[{id,prompt:'Say hello.',classification:'public',approval:'not-required',providers:['claude'],role:'draft',size:'small',permissionScope:'text-only',timeoutSeconds:60,estimates:{claude:{durationSeconds:30,windows:{session:5}}},allowExecute:true}]};
  const policy={schema:1,reviewed:true,providers:[{provider:'claude',mode:'dispatch',accountScope:'acct',modelScope:'sonnet',roles:['draft'],maxSize:'small',maxAgeSeconds:3600,requiredWindows:['session'],reservePercent:{session:5}}]};
  const snap={schema:1,snapshots:[{schema:1,source:'manual',reviewed:true,provider:'claude',accountScope:'acct',modelScope:'sonnet',observedAt:at(-60000),windows:[{name:'session',remainingPercent:90,resetsAt:at(7200000),resetTimezone:'UTC'}]}]};
  await writeFile(files.queue,JSON.stringify(queue));
  await writeFile(files.policy,JSON.stringify(policy));
  await writeFile(files.snapshots,JSON.stringify(snap));
  const imported=await importSnapshotFile(files.snapshots);
  assert.deepEqual(imported.rejected,[]);
  return {root,id,files,queue,policy,snapshots:imported.snapshots};
}

// Builds a stored result in the exact core schema, proves the baseline passes capturedResult, then applies overrides.
function record(f,over={}) {
  const base={schema:1,requestId:f.id,provider:'claude',model:'sonnet',state:'executed',response:RESPONSE,responseSha256:sha(RESPONSE)};
  const baseline=capturedResult(JSON.parse(JSON.stringify(base)),f.id);
  assert.equal(baseline.integrityVerified,true);
  assert.equal(baseline.responseSha256,sha(RESPONSE));
  return {...base,...over};
}

// Injected stand-in for core execute: writes a private-folder result file and reports it, with no provider call.
function core(f,o={}) {
  const calls={n:0};
  const executor=async(req,root)=>{
    calls.n++;
    const dir=path.join(root,'requests',f.id);
    await mkdir(dir,{recursive:true});
    const file=o.outside?path.join(root,'elsewhere.json'):path.join(dir,'result.json');
    if(!o.missing)await writeFile(file,JSON.stringify(record(f,o.over)));
    return {state:'executed',exitCode:0,durationMs:12,resultCaptured:true,resultFile:file,responseSha256:o.hash??sha(RESPONSE)};
  };
  return {executor,calls};
}

const preflight=async()=>{};
const ledgerOf=(f)=>readFile(path.join(f.root,'routing',f.id,'outcome.json'),'utf8');

async function cli(f,executor) {
  const out=[];
  const code=await run(['execute','--queue',f.files.queue,'--snapshots',f.files.snapshots,'--policy',f.files.policy,'--task',f.id,'--confirm-execute'],{write:s=>out.push(s),writeErr:()=>{},deps:{root:f.root,preflight,executor}});
  return {code,text:out.join('')};
}

test('captured result is genuinely read back and exit is 0',async()=>{
  const f=await fixture(),{executor,calls}=core(f);
  const {code,text}=await cli(f,executor);
  const out=JSON.parse(text);
  assert.equal(code,0);
  assert.equal(calls.n,1);
  assert.equal(out.outcome,'dispatched');
  assert.equal(out.launched,true);
  assert.equal(out.executorEntered,true);
  assert.equal(out.state,'executed');
  assert.equal(out.readbackIntegrityVerified,true);
  assert.equal(out.artifactFailure,undefined);
  assert.equal(text.includes(RESPONSE),false);
  const ledger=await ledgerOf(f);
  assert.equal(JSON.parse(ledger).readbackIntegrityVerified,true);
  assert.equal(ledger.includes(RESPONSE),false);
});

test('failed privacy check reports launched false, keeps rejected state and reservation',async()=>{
  const f=await fixture();
  let launches=0,entered=0;
  const spyRunner=()=>{launches++;};
  const executor=async(req,root)=>{entered++;return execute(req,root,{privacyCheck:async()=>{throw new Error('private_storage_unavailable');},runner:spyRunner});};
  const out=await dispatchTask(f.queue,f.snapshots,f.policy,f.id,{root:f.root,preflight,executor,runner:()=>{launches++;}});
  assert.equal(entered,1);
  assert.equal(launches,0);
  assert.equal(out.launched,false);
  assert.equal(out.outcome,'rejected_before_launch');
  assert.equal(out.executorEntered,true);
  assert.equal(out.state,'rejected');
  assert.equal(out.reason,'private_storage_unavailable');
  assert.equal(await exists(path.join(f.root,'routing',f.id,'reservation.json')),true);
  assert.equal(JSON.parse(await ledgerOf(f)).state,'rejected');
  const res=await cli(await fixture(),async(req,root)=>execute(req,root,{privacyCheck:async()=>{throw new Error('private_storage_unavailable');},runner:spyRunner}));
  assert.equal(launches,0);
  assert.equal(res.code,2);
});

test('preflight that throws after cancellation reports canceled_before_dispatch',async()=>{
  const f=await fixture(),controller=new AbortController(),{executor,calls}=core(f);
  const out=await dispatchTask(f.queue,f.snapshots,f.policy,f.id,{root:f.root,executor,signal:controller.signal,preflight:async()=>{controller.abort();throw new Error('aborted');}});
  assert.equal(out.outcome,'canceled_before_dispatch');
  assert.equal(out.launched,false);
  assert.equal(calls.n,0);
});

test('preflight failure without cancellation stays preflight_failed',async()=>{
  const f=await fixture(),{executor,calls}=core(f);
  const out=await dispatchTask(f.queue,f.snapshots,f.policy,f.id,{root:f.root,executor,preflight:async()=>{throw new Error('nope');}});
  assert.equal(out.outcome,'preflight_failed');
  assert.equal(out.launched,false);
  assert.equal(calls.n,0);
});

test('result storage failure keeps executed state but exits nonzero without retry',async()=>{
  const f=await fixture();
  let calls=0;
  const executor=async()=>{calls++;return {state:'executed',exitCode:0,durationMs:3,resultCaptured:false,captureFailure:'private_storage_unavailable'};};
  const {code,text}=await cli(f,executor);
  const out=JSON.parse(text);
  assert.notEqual(code,0);
  assert.equal(code,2);
  assert.equal(calls,1);
  assert.equal(out.state,'executed');
  assert.equal(out.launched,true);
  assert.equal(out.readbackIntegrityVerified,false);
  assert.equal(out.artifactFailure,'artifact_capture_failed');
  assert.equal(await exists(path.join(f.root,'routing',f.id,'reservation.json')),true);
});

const BAD=[
  ['tampered response',{over:{response:'altered after hashing'}}],
  ['wrong provider',{over:{provider:'antigravity'}}],
  ['wrong model',{over:{model:'gemini-3.8-flash-medium'}}],
  ['wrong request id',{over:{requestId:randomUUID()}}],
  ['returned hash differs from stored result',{hash:sha('some other response')}],
  ['missing result file',{missing:true}],
  ['result file outside the request folder',{outside:true}]
];
for(const [name,o] of BAD) {
  test(`readback failure cannot give success: ${name}`,async()=>{
    const f=await fixture(),{executor,calls}=core(f,o);
    const {code,text}=await cli(f,executor);
    const out=JSON.parse(text);
    assert.equal(code,2);
    assert.equal(calls.n,1);
    assert.equal(out.state,'executed');
    assert.equal(out.readbackIntegrityVerified,false);
    assert.match(out.artifactFailure,/^artifact_/);
    assert.equal(text.includes(RESPONSE),false);
    assert.equal(await exists(path.join(f.root,'routing',f.id,'reservation.json')),true);
    const ledger=JSON.parse(await ledgerOf(f));
    assert.equal(ledger.readbackIntegrityVerified,false);
    assert.match(ledger.artifactFailure,/^artifact_/);
  });
}
