import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeSnapshot,collectSnapshots,importSnapshotFile,indexSnapshots,authorizesLive,ValidationError} from '../quota-snapshots.mjs';

const win=(o={})=>({name:'session',remainingPercent:80,resetsAt:'2026-10-03T01:00:00+09:00',resetTimezone:'Asia/Tokyo',...o});
const snap=(o={})=>({schema:1,source:'manual',reviewed:true,provider:'claude',accountScope:'acct-a',modelScope:'sonnet',observedAt:'2026-10-02T11:55:00Z',windows:[win()],...o});
const code=fn=>{try{fn();}catch(e){assert.ok(e instanceof ValidationError);return e.code;}assert.fail('expected rejection');};

test('normalizes a manual snapshot and strips unsupported fields',()=>{
  const s=normalizeSnapshot(snap({email:'person@example.invalid',billing:{plan:'x'},windows:[win({accountId:'123',cost:5})]}));
  assert.deepEqual(Object.keys(s).sort(),['accountScope','modelScope','observedAt','observedAtMs','provider','reviewed','schema','source','windows']);
  assert.deepEqual(Object.keys(s.windows[0]).sort(),['name','remainingPercent','resetTimezone','resetsAt','resetsAtMs']);
  assert.ok(!JSON.stringify(s).includes('example.invalid'));
  assert.equal(s.windows[0].resetsAtMs,Date.parse('2026-10-02T16:00:00Z'));
});

test('rejects null, out-of-range and non-numeric percentages',()=>{
  for(const v of [null,-1,100.5,'50',NaN,Infinity,undefined])assert.equal(code(()=>normalizeSnapshot(snap({windows:[win({remainingPercent:v})]}))),'invalid_remaining_percent');
});

test('requires explicit offsets and real calendar dates',()=>{
  for(const v of ['2026-10-02T11:55:00','2026-10-02 11:55:00Z','2026-02-30T00:00:00Z','2026-10-02T24:00:00Z',null])assert.equal(code(()=>normalizeSnapshot(snap({observedAt:v}))),'invalid_observed_at');
  assert.equal(code(()=>normalizeSnapshot(snap({windows:[win({resetsAt:'2026-10-03T01:00:00'})]}))),'invalid_reset');
});

test('validates reset ordering, IANA zone and offset consistency',()=>{
  assert.equal(code(()=>normalizeSnapshot(snap({windows:[win({resetsAt:'2026-10-02T11:55:00Z',resetTimezone:'UTC'})]}))),'reset_not_after_observation');
  for(const z of ['Mars/Base','JST',undefined,'+09:00'])assert.equal(code(()=>normalizeSnapshot(snap({windows:[win({resetTimezone:z})]}))),'invalid_reset_timezone');
  assert.equal(code(()=>normalizeSnapshot(snap({windows:[win({resetsAt:'2026-10-02T16:00:00Z'})]}))),'reset_offset_zone_mismatch');
  const ny=o=>normalizeSnapshot(snap({windows:[win({resetsAt:o,resetTimezone:'America/New_York'})]}));
  assert.equal(ny('2026-10-03T12:00:00-04:00').windows[0].resetTimezone,'America/New_York');
  assert.equal(code(()=>ny('2026-10-03T12:00:00-05:00')),'reset_offset_zone_mismatch');
});

test('accounts are opaque aliases and windows must be unique',()=>{
  for(const a of ['person@example.invalid','user.name',''])assert.equal(code(()=>normalizeSnapshot(snap({accountScope:a}))),'invalid_account_scope');
  assert.equal(code(()=>normalizeSnapshot(snap({windows:[win(),win()]}))),'duplicate_window');
  assert.equal(code(()=>normalizeSnapshot(snap({windows:[]}))),'invalid_windows');
});

test('source rules: manual needs review, exports need verified provenance',()=>{
  assert.equal(code(()=>normalizeSnapshot(snap({reviewed:undefined}))),'manual_review_required');
  assert.equal(code(()=>normalizeSnapshot(snap({source:'supported-export',reviewed:undefined}))),'provenance_required');
  assert.equal(code(()=>normalizeSnapshot(snap({source:'supported-export',provenance:{adapter:'demo',scopeVerified:false}}))),'provenance_required');
  assert.equal(code(()=>normalizeSnapshot(snap({provenance:{adapter:'demo',scopeVerified:true}}))),'unexpected_provenance');
  const exp=normalizeSnapshot(snap({source:'supported-export',provenance:{adapter:'demo',scopeVerified:true,extra:1}}));
  assert.equal(exp.source,'supported-export');
});

test('mock snapshots never authorize live delegation',()=>{
  assert.equal(authorizesLive(normalizeSnapshot(snap({source:'mock'}))),false);
  assert.equal(authorizesLive(normalizeSnapshot(snap())),true);
  assert.equal(authorizesLive(normalizeSnapshot(snap({source:'supported-export',provenance:{adapter:'demo',scopeVerified:true}}))),true);
});

test('collectors must identify themselves and match snapshot source',async()=>{
  await assert.rejects(collectSnapshots({source:'manual',collect:async()=>[]}),e=>e.code==='collector_unidentified');
  await assert.rejects(collectSnapshots({id:'x',source:'live',collect:async()=>[]}),e=>e.code==='collector_unidentified');
  const mock=await collectSnapshots({id:'demo-mock',source:'mock',collect:async()=>[snap({source:'mock'})]});
  assert.equal(mock.collector.source,'mock');
  assert.equal(authorizesLive(mock.snapshots[0]),false);
  const bad=await collectSnapshots({id:'demo-mock',source:'mock',collect:async()=>[snap(),snap({source:'mock',windows:[win({remainingPercent:null})]})]});
  assert.deepEqual(bad.rejected,[{index:0,reason:'source_mismatch'},{index:1,reason:'invalid_remaining_percent'}]);
});

test('file import accepts manual/mock only and reports static reasons',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'quota-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'s.json');
  await writeFile(file,JSON.stringify({schema:1,snapshots:[snap(),snap({source:'mock'}),snap({source:'supported-export',provenance:{adapter:'demo',scopeVerified:true}}),snap({observedAt:'bad'})]}));
  const r=await importSnapshotFile(file);
  assert.equal(r.snapshots.length,2);
  assert.deepEqual(r.rejected,[{index:2,reason:'source_not_importable'},{index:3,reason:'invalid_observed_at'}]);
  await writeFile(file,'{not json');
  await assert.rejects(importSnapshotFile(file),e=>e.code==='invalid_json');
  await writeFile(file,JSON.stringify({schema:2,snapshots:[]}));
  await assert.rejects(importSnapshotFile(file),e=>e.code==='invalid_snapshot_file');
});

test('pools are separate per provider and conflicts are flagged',()=>{
  const claude=snap(),agy=snap({provider:'antigravity'});
  const idx=indexSnapshots([claude,agy]);
  assert.equal(idx.pools.size,2);
  assert.ok([...idx.pools.values()].every(p=>!p.conflict));
  assert.deepEqual([...idx.providers].sort(),['antigravity','claude']);
  assert.ok([...indexSnapshots([claude,snap()]).pools.values()].every(p=>!p.conflict));
  const conflict=indexSnapshots([claude,snap({windows:[win({remainingPercent:10})]})]);
  assert.ok([...conflict.pools.values()][0].conflict);
});
