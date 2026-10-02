import test from 'node:test';
import assert from 'node:assert/strict';
import {terminalScreen,resetObservation,parseUsage,collectOfficialUsage} from '../official-usage.mjs';
import {run} from '../usage-cli.mjs';
const timing={observationStartedAt:'2031-04-02T12:00:00Z',observedAt:'2031-04-02T12:00:10Z'};
const terminal=s=>'\x1b[2J\x1b[H'+s.split('\n').join('\r\n');
const claude=`Account: person@example.invalid
Current session
25% 25% used
Resets 7:30am (Asia/Tokyo)
Current week (all models)
60% 60% used
Resets Oct 3, 5am (Asia/Tokyo)
Per-model breakdown unavailable (rate limited — try again in a moment)`;
const agy=`Account: person@example.invalid
GEMINI MODELS
Models within this group: Gemini Flash, Gemini Pro
Weekly Limit Remaining
[████░░] 92.50%
Refreshes in 101h 25m
Five Hour Limit Remaining
[██████] 100.00%
Quota available
CLAUDE AND GPT MODELS
Models within this group: Claude Opus, Claude Sonnet, GPT-OSS
Weekly Limit Remaining
[██████] 100.00%
Quota available
Five Hour Limit Remaining
[██████] 100.00%
Quota available`;
test('VT rendering respects redraws, cursor, erase, OSC titles and CR',()=>{
 assert.equal(terminalScreen('\x1b]0;private title\x07\x1b[2J\x1b[Hsecret\rpublic\x1b[K\r\n99%\x1b[2;1H10%').trim(),'public\n10%');
 assert.throws(()=>terminalScreen('x'.repeat(2097153)),/output_limit/);
});
test('Claude used-rate conversion retains original quantity and operation',()=>{
 const out=parseUsage(terminal(claude),'claude',timing);
 assert.equal(out.pools.length,1);assert.equal(out.pools[0].pool,'native-all-models');
 assert.deepEqual(out.pools[0].models,['all-models']);
 assert.deepEqual(out.pools[0].windows.map(w=>w.remainingPercent),[75,40]);
 assert.deepEqual(out.pools[0].windows[1].quantitySource,{kind:'used',value:60,operation:'100-minus-used'});
 assert.equal(out.rateLimited,true);assert.equal(out.modelBreakdownUnavailable,true);
 assert.equal(out.routerAuthorized,false);assert.ok(!JSON.stringify(out).includes('example.invalid'));
});
test('AGY shared pools appear once regardless of member model count',()=>{
 const out=parseUsage(terminal(agy),'antigravity',timing);
 assert.equal(out.pools.length,2);assert.deepEqual(out.pools[0].models,['gemini-flash','gemini-pro']);
 assert.equal(out.pools[0].windows[0].remainingPercent,92.5);
 assert.deepEqual(out.pools[0].windows[0].quantitySource,{kind:'remaining',value:92.5,operation:'identity'});
 assert.deepEqual(out.pools[1].windows.map(w=>w.remainingPercent),[100,100]);
 assert.equal(out.routerAuthorized,false);
});
test('reset kinds retain ambiguity instead of inventing dates or zones',()=>{
 const values=['Resets 7:30am (Asia/Tokyo)','Resets Oct 3, 5am (Asia/Tokyo)','Refreshes in 101h 25m','Quota available',null,'Resets whatever'];
 assert.deepEqual(values.map(v=>resetObservation(v).kind),['time-only','calendar-without-year','relative-rounded','available-without-reset','unknown','unknown']);
 for(const v of values)assert.equal(resetObservation(v).absolute,null);
 const relative=resetObservation(values[2]);assert.equal(relative.relativeMinutes,6085);assert.equal(relative.timezone,null);
 assert.equal(resetObservation('Resets 2031-04-03T07:00:00+09:00 (Asia/Tokyo)').kind,'absolute');
 assert.equal(resetObservation('Resets 2031-02-30T07:00:00+09:00 (Asia/Tokyo)').kind,'unknown');
});
test('observation and backend timestamps are distinct; cached data is flagged',()=>{
 const out=parseUsage(terminal(claude+'\nShowing last-known usage'),'claude',{...timing,backendAt:'2031-04-02T11:00:00Z'});
 assert.equal(out.observedAt,timing.observedAt);assert.equal(out.backendAt,'2031-04-02T11:00:00Z');
 assert.equal(out.freshness,'last-known');assert.ok(out.blockers.includes('last-known-data'));
 assert.equal(parseUsage(terminal(claude),'claude',timing).backendAt,null);
 assert.throws(()=>parseUsage('', 'claude',{...timing,observedAt:undefined}));
 assert.throws(()=>parseUsage('', 'claude',{...timing,backendAt:'2031-04-03T11:00:00Z'}));
});
test('missing/rate-limited/out-of-range percentages remain unknown',()=>{
 for(const text of ['rate limited','unavailable','101% used','-1% used','not a percentage']) {
  const out=parseUsage(terminal('Current session\n'+text+'\nCurrent week (all models)\n40% used'),'claude',timing);
  assert.equal(out.pools[0].windows[0].remainingPercent,null);
  assert.equal(out.pools[0].windows[1].remainingPercent,60);
  assert.ok(out.blockers.includes('quota-unavailable'));
 }
 const out=parseUsage(terminal('Login required'),'claude',timing);assert.equal(out.missingPools,true);assert.equal(out.routerAuthorized,false);
});
test('normal successful parsing returns only the allowlisted observation fields',()=>{
 const raw=terminal(agy+'\nsecret-path /private/place\nprivate_key=DO_NOT_CAPTURE');
 const out=JSON.stringify(parseUsage(raw,'antigravity',timing));
 for(const forbidden of ['person@','private_key','DO_NOT_CAPTURE','/private/place'])assert.ok(!out.includes(forbidden));
});
test('collector needs explicit confirmation and validates before runner',async()=>{
 let calls=0;const runner=async()=>{calls++;return terminal(claude);};
 await assert.rejects(collectOfficialUsage('claude','C:/synthetic-empty',{runner}),/confirmation/);
 await assert.rejects(collectOfficialUsage('other','C:/synthetic-empty',{runner,confirmDisplayOnly:true}),/invalid/);
 await assert.rejects(collectOfficialUsage('claude','relative',{runner,confirmDisplayOnly:true}),/invalid/);
 await assert.rejects(collectOfficialUsage('claude','C:/synthetic-empty',{runner,confirmDisplayOnly:true,timeoutSeconds:100}),/invalid/);
 assert.equal(calls,0);
 const out=await collectOfficialUsage('claude','C:/synthetic-empty',{runner,confirmDisplayOnly:true});assert.equal(calls,1);assert.equal(out.routerAuthorized,false);
 assert.equal(out.backendAt,null);
});
test('canceled collection does not start runner and raw errors never enter CLI output',async()=>{
 let calls=0;const ctrl=new AbortController();ctrl.abort();
 await assert.rejects(collectOfficialUsage('claude','C:/synthetic-empty',{confirmDisplayOnly:true,signal:ctrl.signal,runner:async()=>{calls++;}}),/canceled/);assert.equal(calls,0);
 let output='';const status=await run(['--provider','claude','--workspace','C:/synthetic-empty','--confirm-display-only'],{collector:async()=>{throw Error('person@example.invalid private token');},write:s=>output+=s});
 assert.equal(status,2);assert.ok(!output.includes('person'));assert.equal(JSON.parse(output).routerAuthorized,false);
});
test('CLI missing confirmation cannot collect, unknown flags rejected',async()=>{
 let calls=0;const collector=async()=>{calls++;return {missingPools:false};};
 for(const args of [[],['--provider','claude','--workspace','C:/synthetic-empty'],['--confirm-display-only','--unknown']])assert.equal(await run(args,{collector,write:()=>{}}),2);
 assert.equal(calls,0);
 assert.equal(await run(['--provider','claude','--workspace','C:/synthetic-empty','--confirm-display-only'],{collector,write:()=>{}}),0);assert.equal(calls,1);
});
