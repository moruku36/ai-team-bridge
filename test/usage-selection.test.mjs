import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selectObservedQueue,exportStrictSnapshotPreview} from '../usage-selection.mjs';
import {normalizeSnapshot} from '../quota-snapshots.mjs';
import {routeQueue} from '../task-router.mjs';
import {runSelection} from '../usage-selection-cli.mjs';
const NOW='2031-04-02T12:00:00Z';
const routing={schema:1,reviewed:true,providers:[{provider:'claude',mode:'dispatch',accountScope:'claude-main',modelScope:'sonnet',roles:['draft','implementation'],maxSize:'large',maxAgeSeconds:120,requiredWindows:['session','weekly'],reservePercent:{session:10,weekly:10}}]};
const policy={schema:1,reviewed:true,purpose:'advisory-only',maxObservationAgeSeconds:120,safetyMarginPercent:1,unknownBackend:'allow-observed-freshness',unknownReset:'advisory-only',ranking:'policy-order',mappings:[{provider:'claude',accountScope:'claude-main',modelScope:'sonnet',pool:'native-all-models',scopeReviewed:true}]};
const window=(name,reset={kind:'unknown',absolute:null,timezone:null})=>({name,remainingPercent:80,quantitySource:{kind:'used',value:20,operation:'100-minus-used'},reset,unavailable:false});
const observation=(o={})=>({schema:1,provider:'claude',source:'official-interactive-usage',observedAt:NOW,backendAt:null,rateLimited:false,freshness:'backend-time-not-exposed',missingPools:false,routerAuthorized:false,pools:[{pool:'native-all-models',windows:[window('session'),window('weekly')]}],...o});
const doc=(o=observation())=>({schema:1,reviewed:true,observations:[o]});
let seq=0;
const task=(o={})=>({id:'00000000-0000-4000-8000-'+String(++seq).padStart(12,'0'),prompt:'Draft a synthetic test summary.',classification:'public',approval:'not-required',providers:['claude'],role:'draft',size:'small',permissionScope:'text-only',timeoutSeconds:60,estimates:{claude:{durationSeconds:30,windows:{session:5,weekly:5}}},allowExecute:true,...o});
const queue=tasks=>({schema:1,tasks});
const select=(tasks=[task()],d=doc(),p=policy)=>selectObservedQueue(queue(tasks),d,routing,p,{now:NOW});
const exact=()=>observation({pools:[{pool:'native-all-models',windows:['session','weekly'].map(name=>window(name,{kind:'absolute',absolute:'2031-04-02T16:00:00Z',timezone:'UTC'}))}]});
test('unknown backend/reset supports advisory selection, never dispatch or invented reset',()=>{
 const r=select();assert.equal(r.decisions[0].status,'selected-for-review');assert.equal(r.decisions[0].backendFreshness,'unknown');assert.equal(r.decisions[0].backendAt,null);assert.equal(r.decisions[0].resetUncertainty[0].absolute,null);assert.equal(r.executePermitted,false);assert.equal(r.dispatchAuthorized,false);assert.ok(Object.isFrozen(r));assert.equal(r.decisions[0].expiresAt,'2031-04-02T12:02:00.000Z');assert.equal(r.decisions[0].quotaEvidence[0].remainingPercent,80);assert.equal(r.decisions[0].quotaEvidence[0].quantitySource.value,20);assert.equal(r.decisions[0].quotaEvidence[0].displayedHeadroomAfterBatchPercent,64);
 assert.throws(()=>normalizeSnapshot(r));assert.throws(()=>routeQueue(queue([task()]),[r],routing,{now:NOW}));
});
test('strict preview refuses unknown reset without fallback inference',()=>{const r=exportStrictSnapshotPreview(doc(),'claude',routing,policy,{now:NOW});assert.equal(r.exported,false);assert.deepEqual(r.reasons,['reset_not_exact']);assert.equal(r.snapshot,undefined);});
test('exact reviewed reset may enter strict router dry run without backend timestamp',()=>{
 const r=exportStrictSnapshotPreview(doc(exact()),'claude',routing,policy,{now:NOW});assert.equal(r.exported,true);assert.equal(r.dispatchAuthorized,false);assert.equal(r.uncertainty.backendAt,null);const d=routeQueue(queue([task({allowExecute:false})]),[r.snapshot],routing,{now:NOW}).decisions[0];assert.equal(d.status,'eligible');assert.equal(d.executePermitted,false);
});
test('observation age boundary/future and backend age are independent',()=>{
 assert.equal(select([task()],doc(observation({observedAt:'2031-04-02T11:58:00Z'}))).summary.selectedForReview,1);
 for(const o of [{observedAt:'2031-04-02T11:57:59.999Z'},{observedAt:'2031-04-02T12:00:00.001Z'},{backendAt:'2031-04-02T11:57:59Z'},{backendAt:'2031-04-02T12:00:01Z'}])assert.equal(select([task()],doc(observation(o))).summary.selectedForReview,0);
 assert.equal(select([task()],doc(),{...policy,unknownBackend:'require-backend-time'}).summary.selectedForReview,0);
});
test('rate-limited/missing/last-known/unknown freshness and category block',()=>{
 for(const patch of [{rateLimited:true},{rateLimited:undefined},{missingPools:true},{freshness:'last-known'},{freshness:'unknown'},{source:'codexbar-cache'},{provider:'codex'}])assert.equal(select([task()],doc(observation(patch))).summary.selectedForReview,0);
 const o=observation();o.pools[0].windows[0].reset.kind='guessed';assert.equal(select([task()],doc(o)).summary.selectedForReview,0);
});
test('missing/malformed percentage and contradictory conversion cannot select',()=>{
 for(const pct of [null,undefined,-1,101]){const o=observation();o.pools[0].windows[0].remainingPercent=pct;assert.equal(select([task()],doc(o)).summary.selectedForReview,0);}
 const o=observation();o.pools[0].windows[0].quantitySource.value=30;assert.equal(select([task()],doc(o)).summary.selectedForReview,0);
});
test('existing approval/role/classification/wrapper/estimate/duplicate gates survive',()=>{
 for(const patch of [{approval:'required'},{classification:'unknown'},{role:'verification'},{classification:'personal',approval:'not-required'},{estimates:{}},{estimates:{claude:{durationSeconds:61,windows:{session:5,weekly:5}}}}])assert.equal(select([task(patch)]).summary.selectedForReview,0);
 const t=task();assert.equal(select([t,t]).summary.selectedForReview,0);
 const m=task({estimates:{claude:{durationSeconds:30,windows:{session:5}}}});assert.equal(select([m]).summary.selectedForReview,0);
});
test('shared pool batch demands cannot copy budget and failed fit consumes nothing',()=>{
 const heavy=()=>task({estimates:{claude:{durationSeconds:30,windows:{session:50,weekly:50}}}});
 const r=select([heavy(),heavy(),task()]);assert.deepEqual(r.decisions.map(d=>d.status),['selected-for-review','blocked','selected-for-review']);assert.ok(r.decisions[1].reasons.includes('insufficient_headroom'));
});
test('policy cannot omit review/mapping or expand ages/model/pool',()=>{
 for(const p of [{...policy,reviewed:false},{...policy,maxObservationAgeSeconds:121},{...policy,mappings:[{...policy.mappings[0],pool:'gemini-shared'}]},{...policy,mappings:[{...policy.mappings[0],modelScope:'opus'}]}])assert.throws(()=>select([task()],doc(),p));
 assert.throws(()=>select([task()],{...doc(),reviewed:false}));
});
test('multiple observations cannot silently pick newest',()=>{const r=select([task()],{schema:1,reviewed:true,observations:[observation(),observation()]});assert.equal(r.summary.selectedForReview,0);assert.ok(r.decisions[0].reasons.includes('conflicting_observations'));});
test('relative reset evidence retained without computing instant or deadline order',()=>{
 const o=observation();for(const w of o.pools[0].windows)w.reset={kind:'relative-rounded',relativeMinutes:15,absolute:null,timezone:null};const r=select([task()],doc(o));assert.equal(r.decisions[0].resetUncertainty[0].relativeMinutes,15);assert.equal(r.decisions[0].resetUncertainty[0].absolute,null);assert.ok(r.decisions[0].warnings.includes('no_deadline_ranking'));
});
test('known reset expiry and reset before completion remain blocking',()=>{
 const o=exact();o.pools[0].windows[0].reset.absolute='2031-04-02T12:00:15Z';assert.equal(select([task()],doc(o)).summary.selectedForReview,0);
 o.pools[0].windows[0].reset.absolute='2031-04-02T11:59:59Z';assert.equal(select([task()],doc(o)).summary.selectedForReview,0);
});
test('CLI has no execute mode and pure selector makes no execution call',async()=>{
 await assert.rejects(()=>runSelection(['execute']));await assert.rejects(()=>runSelection(['dry-run','--execute','true']));
 const s=await readFile(new URL('../usage-selection.mjs',import.meta.url),'utf8');assert.doesNotMatch(s,/Date\.now|dispatchTask|executeWithDiagnostics|child_process|fetch\(/);
});
test('AGY selected pool remains separate from native Claude and other AGY members',async()=>{
 const load=async name=>JSON.parse(await readFile(new URL('../examples/'+name,import.meta.url),'utf8'));
 const [q,d,r,p]=await Promise.all(['usage-queue.example.json','usage-observations.example.json','usage-routing-policy.example.json','usage-selection-policy.example.json'].map(load));
 const ag=d.observations.find(o=>o.provider==='antigravity');
 for(const w of ag.pools.find(p=>p.pool==='gemini-shared').windows){w.remainingPercent=0;w.quantitySource.value=0;}
 const result=selectObservedQueue(q,d,r,p,{now:NOW});
 assert.equal(result.decisions[0].status,'blocked');assert.equal(result.decisions[1].provider,'claude');
 assert.ok(result.decisions[0].reasons.includes('insufficient_headroom'));
});
test('AGY missing reviewed plan scope cannot be masked by absent snapshot',async()=>{
 const load=async name=>JSON.parse(await readFile(new URL('../examples/'+name,import.meta.url),'utf8'));
 const [q,d,r,p]=await Promise.all(['usage-queue.example.json','usage-observations.example.json','usage-routing-policy.example.json','usage-selection-policy.example.json'].map(load));delete q.tasks[0].taskScope;
 const result=selectObservedQueue(q,d,r,p,{now:NOW});assert.equal(result.decisions[0].status,'blocked');assert.ok(result.decisions[0].reasons.includes('plan_mode_required'));
});
test('strict export cannot loosen the reviewed observation age through routing policy',()=>{
 const r=exportStrictSnapshotPreview(doc(exact()),'claude',{...routing,providers:[{...routing.providers[0],maxAgeSeconds:900}]},policy,{now:NOW});assert.equal(r.exported,false);assert.deepEqual(r.reasons,['routing_age_exceeds_reviewed_observation_age']);
});
test('rounding margin is an explicit extra reserve for advisory selection',()=>{
 const o=observation();for(const w of o.pools[0].windows){w.remainingPercent=15;w.quantitySource.value=85;}
 assert.equal(select([task()],doc(o)).summary.selectedForReview,0);
});
test('strict preview fails closed on any rejected source record',()=>{
 const d={schema:1,reviewed:true,observations:[exact(),{schema:1,provider:'codex',source:'unknown'}]};
 const r=exportStrictSnapshotPreview(d,'claude',routing,policy,{now:NOW});assert.equal(r.exported,false);assert.deepEqual(r.reasons,['observation_document_has_rejections']);
 const advisory=select([task()],doc(observation({modelBreakdownUnavailable:true})));assert.equal(advisory.decisions[0].modelBreakdownUnavailable,true);assert.ok(advisory.decisions[0].warnings.includes('aggregate_only_model_breakdown_unavailable'));
});
