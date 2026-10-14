import test from 'node:test';
import assert from 'node:assert/strict';
import {parseQuota, acquireQuota, createQuotaCollector, COMMANDS, runBounded} from '../windows-quota-collector.mjs';
import {collectSnapshots} from '../quota-snapshots.mjs';

// Entirely synthetic future times and arbitrary percentages; never live outputs.
const at='2060-01-01T00:00:00.000Z', now=Date.parse(at);
const reset5='2060-01-01T03:00:00Z', reset7='2060-01-06T00:00:00Z';
const claude=()=>[{provider:'claude',email:'fixture@example.invalid',token:'synthetic-do-not-retain',usage:{updated_at:at,
  primary:{window_minutes:300,used_percent:22,resets_at:reset5},secondary:{window_minutes:10080,used_percent:48,resets_at:reset7}}}];
const ag=()=>({status:'SUCCESS',num_turns:0,command:{name:'usage',data:{groups:['Gemini models','Claude and GPT models'].map(displayName=>({displayName,buckets:[
  {bucketId:'pool-5h',remainingFraction:0.73,resetTime:reset5},{bucketId:'pool-weekly',remaining:{case:'remainingFraction',value:0.29},resetTime:reset7}]}))}}});
const parse=(provider,value)=>parseQuota(provider,value,{collectedAt:at});

test('Claude conversion keeps provider time, native scope, complement and exact reset',()=>{
  const r=parse('claude',claude()); assert.equal(r.status,'available');assert.equal(r.providerObservedAt,at);
  assert.equal(r.pools[0].scope,'native-all-models');assert.equal(r.pools[0].windows[0].remainingPercent,78);
  assert.equal(r.pools[0].windows[1].remainingPercent,52);assert.equal(r.routerAuthorized,false);
  assert.doesNotMatch(JSON.stringify(r),/fixture@example|synthetic-do-not-retain|email|token/);
});
test('microsecond CLI times normalize to milliseconds without inventing dates',()=>{
  const c=claude();c[0].usage.updated_at='2060-01-01T00:00:00.000111Z';
  assert.equal(parse('claude',c).providerObservedAt,at);
  c[0].usage.updated_at='2060-02-30T00:00:00Z';assert.equal(parse('claude',c).status,'unknown');
});
test('AG shares two pools and keeps backend time unknown',()=>{
  const r=parse('antigravity',ag());assert.equal(r.status,'available');assert.equal(r.providerObservedAt,null);
  assert.equal(r.timeBasis,'collection');assert.deepEqual(r.pools.map(p=>p.scope),['gemini-shared','claude-gpt-shared']);
  assert.equal(r.pools[0].windows[0].remainingPercent,73);assert.equal(r.pools[0].windows[1].remainingPercent,29);
});
test('AG requires a native zero-turn usage envelope, not a model reply',()=>{
  for(const value of [{...ag(),num_turns:1},{...ag(),num_turns:undefined},{...ag(),status:'ERROR'},{status:'SUCCESS',command:{name:'chat'}}])
    assert.throws(()=>parse('antigravity',value),/invalid_output/);
});
test('unrecognized and duplicate AG pools fail closed',()=>{
  const a=ag();a.command.data.groups[0].displayName='Unknown';assert.throws(()=>parse('antigravity',a),/unknown_shared_pool/);
  const b=ag();b.command.data.groups.push(b.command.data.groups[0]);assert.throws(()=>parse('antigravity',b),/ambiguous_shared_pool/);
});
test('missing, invalid, informational, duplicate and absent-reset values stay unknown',()=>{
  for(const change of [w=>w.used_percent=null,w=>w.used_percent=-1,w=>w.used_percent='20',w=>w.resets_at=null,w=>w.resets_at=at,w=>w.is_informational=true]) {
    const c=claude();change(c[0].usage.primary);const w=parse('claude',c).pools[0].windows[0];
    assert.equal(w.remainingPercent,null);assert.notEqual(w.status,'available');
  }
  const c=claude();c[0].usage.tertiary=c[0].usage.primary;assert.equal(parse('claude',c).pools[0].windows[0].status,'ambiguous');
});
test('stale, future and missing Claude observations never become fresh',()=>{
  for(const t of ['2059-12-31T22:00:00Z','2060-01-01T00:01:00Z',undefined]) {
    const c=claude();c[0].usage.updated_at=t;assert.equal(parse('claude',c).status,'unknown');
  }
});
test('AG disabled, malformed fraction and expired reset never imply unlimited capacity',()=>{
  for(const change of [w=>w.disabled=true,w=>w.remainingFraction=2,w=>w.remainingFraction=null,w=>w.resetTime=at]) {
    const a=ag();change(a.command.data.groups[0].buckets[0]);assert.equal(parse('antigravity',a).pools[0].windows[0].remainingPercent,null);
  }
});
test('collector injection requires account review, explicit local clock acceptance and current exact resets',async()=>{
  const r=parse('antigravity',ag());assert.throws(()=>createQuotaCollector(r,{accountScope:'local'}),/scope_review_required/);
  assert.throws(()=>createQuotaCollector(r,{accountScope:'local',scopeVerified:true,now}),/fresh_observation_required/);
  const collected=await collectSnapshots(createQuotaCollector(r,{accountScope:'local',scopeVerified:true,allowCollectionTime:true,now}));
  assert.equal(collected.snapshots.length,2);assert.equal(collected.rejected.length,0);
  assert.equal(collected.snapshots[0].source,'supported-export');assert.equal(collected.snapshots[0].modelScope,'gemini-shared');
  assert.throws(()=>createQuotaCollector(r,{accountScope:'local',scopeVerified:true,allowCollectionTime:true,now:now+3600001}),/fresh_observation_required/);
  const partial=claude();partial[0].usage.primary.resets_at=null;
  assert.deepEqual((await collectSnapshots(createQuotaCollector(parse('claude',partial),{accountScope:'local',scopeVerified:true,now}))).snapshots,[]);
});
test('fixed commands, existing consent only and version guard precede quota invocation',async()=>{
  const calls=[];const runner=async(exe,args)=>{calls.push(args);return args[0]==='--version'?'codexbar 0.70.0':args[0]==='config'?'{"allowed":true}':JSON.stringify(claude());};
  const r=await acquireQuota('claude',{executable:'C:\\synthetic\\codexbar-cli.exe',platform:'win32',env:{},clock:()=>at,runner});
  assert.equal(r.status,'available');assert.deepEqual(calls[2],[...COMMANDS.claude]);assert.equal(calls[1][2],'status');
  assert.ok(calls.every(a=>!a.includes('allow')));
});
test('unsupported AG version cannot accidentally send /usage as a prompt',async()=>{
  const calls=[];const r=await acquireQuota('antigravity',{executable:'C:\\synthetic\\agy.exe',platform:'win32',env:{},clock:()=>at,runner:async(e,a)=>{calls.push(a);return '1.0.0';}});
  assert.equal(r.error,'unsupported_version');assert.equal(calls.length,1);
});
test('environment overrides and non-Windows contexts fail before spawning',async()=>{
  const runner=()=>assert.fail('must not spawn');
  for(const opts of [{platform:'linux',env:{}},{platform:'win32',env:{GEMINI_API_KEY:'synthetic'}}]) {
    const r=await acquireQuota('antigravity',{executable:'C:\\synthetic\\agy.exe',runner,...opts});assert.equal(r.status,'unknown');
  }
});
test('failed consent, timeout, cancellation and raw parse errors expose only static metadata',async()=>{
  for(const failure of ['timeout','canceled','secret account fixture@example.invalid']) {
    const r=await acquireQuota('claude',{executable:'C:\\synthetic\\codexbar-cli.exe',platform:'win32',env:{},runner:async()=>{throw Error(failure);}});
    assert.equal(r.collectedAt,null);assert.doesNotMatch(JSON.stringify(r),/fixture@example|secret account/);
  }
  const r=await acquireQuota('claude',{executable:'C:\\synthetic\\codexbar-cli.exe',platform:'win32',env:{},runner:async(e,a)=>a[0]==='--version'?'0.70.0':'{"allowed":false}'});
  assert.equal(r.error,'existing_consent_required');
});
test('bounded process runner suppresses raw errors and applies output/time limits',async()=>{
  await assert.rejects(runBounded(process.execPath,['-e','process.stderr.write("private-synthetic");process.exit(3)']),/^Error: cli_failed$/);
  await assert.rejects(runBounded(process.execPath,['-e','setTimeout(()=>{},5000)'],{timeoutMs:30}),/^Error: timeout$/);
  await assert.rejects(runBounded(process.execPath,['-e','process.stdout.write("x".repeat(1048577))']),/cli_failed|timeout/);
});
