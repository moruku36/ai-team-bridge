import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validate, plan, classify, runProcess, execute, metadata, statusMetadata, capturedResult, observedActualModels, failureReason, subscriptionPreflight } from '../wrapper.mjs';
import { createHash } from 'node:crypto';

const scope=()=>({reviewed:true,acceptInheritedPermissions:true,acknowledgeInstructionScope:true,mode:'plan',description:'Draft a design using supplied text; no tools or external actions are requested.'});
const req = (extra={}) => ({id:randomUUID(),provider:'claude',prompt:'日本語 " ; $(whoami) `literal`\nnext',...(extra.provider==='antigravity'?{taskScope:scope()}:{}),...extra});
test('default tool denial and prompt travels only through stdin',()=>{
  const r=validate(req()); const p=plan(r,'C:\\isolated');
  assert.equal(p.args[p.args.indexOf('--tools')+1],'');
  assert.ok(p.args.includes('--safe-mode')); assert.ok(p.args.includes('--strict-mcp-config'));
  assert.ok(!p.args.includes(r.prompt)); assert.equal(p.input,r.prompt+'\n');
});
test('AGY uses supported temporary flags and explicitly reviewed scope',()=>{
  const p=plan(validate(req({provider:'antigravity'})),'C:\\isolated');
  assert.ok(p.args.includes('--sandbox')); assert.ok(p.args.includes('gemini-3.8-flash-medium'));
  assert.ok(!p.args.includes('--agent'));assert.ok(!p.args.includes('--dangerously-skip-permissions'));
  assert.ok(!p.args.includes('--allowed-tools'));assert.match(JSON.parse(p.input).message.content,/Authorized task scope:/);
});
test('reject unsupported scopes/models/routes and unreviewed cloud send',()=>{
  for(const x of [{tools:['Bash']},{model:'made-up'},{provider:'antigravity',route:'cloud'},
    {route:'cloud',session:'https://claude.ai/code/session_abc'}]) assert.throws(()=>validate(req(x)));
  assert.throws(()=>validate(req({route:'cloud',session:'https://evil.test/code/session_abc',remoteScope:{reviewed:true,description:'text only'}})));
});
test('cloud acknowledgment is accepted only; contradictory exit is unknown',()=>{
  assert.equal(classify('cloud', 'claude', {ok:true},0).state,'accepted');
  assert.equal(classify('cloud', 'claude', {ok:true},1).state,'unknown');
  assert.equal(classify('local','claude',{type:'result',subtype:'success',is_error:false,result:'OK'},0,'OK').state,'verified');
  assert.equal(classify('local','antigravity',{status:'SUCCESS',response:'OK'},0).state,'executed');
  assert.equal(classify('local','antigravity',{status:'RUNNING'},0).state,'unknown');
  assert.equal(classify('cloud','claude',{ok:false,error:'secret'},1).state,'rejected');
});
test('metadata allowlist discards arbitrary provider output and identifiers',()=>{
  const m=metadata(validate(req()),{state:'unknown',reason:'timeout',exitCode:null,durationMs:1,
    prompt:'private',stderr:'secret',url:'https://secret',session_id:'private',response:'private'});
  assert.ok(!JSON.stringify(m).includes('private')); assert.ok(!JSON.stringify(m).includes('secret'));
});
test('real mock child preserves stdin and literal argv without shell expansion',async()=>{
  const r=req(); const literal='a "b" ; $(echo hacked) & | 日本語';
  const code='let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.stringify({arg:process.argv[1],input:s})));';
  const o=await runProcess({exe:process.execPath,args:['-e',code,literal],input:r.prompt,cwd:process.cwd()},2000);
  assert.equal(o.exitCode,0); const v=JSON.parse(o.stdout); assert.equal(v.input,r.prompt); assert.equal(v.arg,literal);
});
test('timeout owns only its spawned child; unrelated child remains alive',async()=>{
  const {spawn}=await import('node:child_process');
  const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true});
  try { const o=await runProcess({exe:process.execPath,args:['-e','setInterval(()=>{},1000)'],input:'',cwd:process.cwd()},100);
    assert.equal(o.reason,'timeout'); assert.equal(other.exitCode,null);
  } finally {other.kill();}
});
test('malformed output and process failures remain unknown',async()=>{
  const o=await runProcess({exe:process.execPath,args:['-e','console.log("not json")'],input:'',cwd:process.cwd()},2000);
  assert.equal(o.exitCode,0); assert.equal(classify('local','claude',{},0).state,'unknown');
  const bad=await runProcess({exe:path.join(tmpdir(),'missing-wrapper-executable.exe'),args:[],input:'',cwd:process.cwd()},1000);
  assert.equal(bad.reason,'launch_failed');
});
test('journal prevents duplicate submission after unknown outcome and never persists output',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'agent-wrapper-test-')); const r=validate(req()); let calls=0;
  const mock=async()=>{calls++;return {stdout:'private malformed',stderr:'Bearer SECRET',exitCode:0,reason:'invalid_output',durationMs:1};};
  const out=await execute(r,root,{runner:mock}); assert.equal(out.state,'unknown');
  await assert.rejects(execute(r,root,{runner:mock})); assert.equal(calls,1);
  const log=await readFile(path.join(root,'requests',r.id,'status.json'),'utf8');
  assert.ok(!log.includes('SECRET')); assert.ok(!log.includes('malformed')); assert.ok(!log.includes(r.prompt));
});
test('aborted process is unknown and captures no raw stderr in journal',async()=>{
  const controller=new AbortController();setTimeout(()=>controller.abort(),100);
  const o=await runProcess({exe:process.execPath,args:['-e','setInterval(()=>{},1000)'],input:'',cwd:process.cwd()},2000,controller.signal);
  assert.equal(o.reason,'canceled');
});
test('subscription preflight refuses API usage and does not launch login',async()=>{
  const r=validate(req());const p=plan(r,process.cwd());let calls=0;
  const runner=async p=>{calls++;assert.deepEqual(p.args,['auth','status','--json']);return {exitCode:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'})};};
  await assert.rejects(subscriptionPreflight(r,p,{runner,env:{ANTHROPIC_API_KEY:'SECRET'}}));assert.equal(calls,0);
  await subscriptionPreflight(r,p,{runner,env:{}});assert.equal(calls,1);
  await assert.rejects(subscriptionPreflight(r,p,{runner:async()=>({exitCode:0,stdout:'{"loggedIn":false}'}),env:{}}));
});
test('AGY preflight reads only provider selection and requires listed model',async()=>{
  const r=validate(req({provider:'antigravity'}));const p=plan(r,process.cwd());
  await subscriptionPreflight(r,p,{env:{USERPROFILE:'C:\\fixture'},settingsReader:async()=>'{"modelProvider":null}',runner:async p=>{assert.deepEqual(p.args,['models']);return {exitCode:0,stdout:r.model+'\tGemini Medium\n'};}});
  await assert.rejects(subscriptionPreflight(r,p,{env:{USERPROFILE:'C:\\fixture'},settingsReader:async()=>'{"modelProvider":"gemini"}',runner:async()=>assert.fail('must not launch')}));
});
test('AGY scope sends once and creates no profile or hook',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wrapper-guard-test-'));const r=validate(req({provider:'antigravity'}));
  let calls=0;
  const result=await execute(r,root,{runner:async p=>{calls++;assert.ok(p.args.includes('--sandbox'));return {stdout:JSON.stringify({event:'result',result:{status:'SUCCESS',response:'mock'}})+'\n',exitCode:0,durationMs:1};}});
  const cwd=path.join(root,'requests',r.id,'workspace');
  assert.deepEqual(await readdir(cwd),[]);assert.equal(calls,1);assert.equal(result.state,'executed');
});
test('AGY scope denied by default and incomplete acknowledgment is rejected before launch',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wrapper-scope-test-'));let calls=0;
  const runner=async()=>{calls++;assert.fail('must not launch');};
  for(const taskScope of [undefined,{}, {...scope(),reviewed:false},{...scope(),acceptInheritedPermissions:false},{...scope(),acknowledgeInstructionScope:false},{...scope(),tools:['run_command']}]) {
    await assert.rejects(execute(req({provider:'antigravity',taskScope}),root,{runner}));
  }
  assert.equal(calls,0);
});
test('scope approval does not leak scope text to metadata',()=>{
  const r=validate(req({provider:'antigravity',taskScope:{...scope(),description:'private scope SECRET'}}));
  assert.ok(!JSON.stringify(metadata(r,{state:'executed',reason:'provider_result'})).includes('SECRET'));
});
test('accept-edits requires explicit per-request approval; default mode remains plan',()=>{
  const r=validate(req({provider:'antigravity',taskScope:{...scope(),mode:'accept-edits'}}));
  assert.equal(plan(r,process.cwd()).args[plan(r,process.cwd()).args.indexOf('--mode')+1],'accept-edits');
  assert.throws(()=>validate(req({provider:'antigravity',taskScope:{...scope(),mode:'turbo'}})));
});
test('status display applies allowlist even to unexpected journal fields',()=>{
  const r=validate(req());const v={...metadata(r,{state:'accepted',reason:'provider_ack'}),response:'SECRET',stderr:'SECRET',model:'SECRET'};
  assert.ok(!JSON.stringify(statusMetadata(v,r.id)).includes('SECRET'));
  assert.throws(()=>statusMetadata({...v,provider:'SECRET'},r.id));
});
test('local final answer is captured only after private storage check and reads back exactly',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wrapper-capture-test-'));const r=req({captureResult:true,expectResponse:'FIXTURE_OK'});let checked=false;
  const out=await execute(r,root,{privacyCheck:async()=>{checked=true;},runner:async()=>{assert.equal(checked,true);return {exitCode:0,outputObserved:true,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:'FIXTURE_OK'}),durationMs:1};}});
  assert.equal(out.state,'verified');assert.equal(out.resultCaptured,true);assert.equal(out.response,undefined);
  const v=JSON.parse(await readFile(out.resultFile,'utf8'));assert.equal(v.response,'FIXTURE_OK');
  assert.equal(createHash('sha256').update(v.response).digest('hex'),out.responseSha256);
  const log=await readFile(path.join(root,'requests',r.id,'status.json'),'utf8');assert.ok(!log.includes('FIXTURE_OK'));assert.ok(!log.includes('responseSha256'));
});
test('private storage failure stops before any generation',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wrapper-private-test-'));
  const out=await execute(req({captureResult:true}),root,{privacyCheck:async()=>{throw Error('secret');},runner:async()=>assert.fail('must not launch')});
  assert.equal(out.reason,'private_storage_unavailable');assert.equal(out.state,'rejected');
});
test('timeout/partial output is not saved as a final result',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wrapper-partial-test-'));
  const out=await execute(req({captureResult:true}),root,{privacyCheck:async()=>{},runner:async()=>({stdout:'partial SECRET',stderr:'secret',reason:'timeout',exitCode:null,outputObserved:true,durationMs:1})});
  assert.equal(out.state,'unknown');assert.equal(out.outputObserved,true);assert.equal(out.resultCaptured,false);assert.equal(out.resultFile,undefined);
});
test('quota/rate errors are categorized without persisting raw diagnostics',async()=>{
  assert.equal(failureReason({error:'usage limit reached SECRET'},''),'quota_exhausted');
  assert.equal(failureReason({},'429 too many requests SECRET'),'rate_limited');
  const root=await mkdtemp(path.join(tmpdir(),'wrapper-quota-test-'));const r=req();
  const out=await execute(r,root,{runner:async()=>({exitCode:1,stdout:JSON.stringify({type:'result',is_error:true,error:'usage limit reached SECRET'}),stderr:'SECRET',outputObserved:true,durationMs:1})});
  assert.equal(out.state,'rejected');assert.equal(out.reason,'quota_exhausted');
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});
test('capture is local-only and requires a boolean',()=>{
  assert.throws(()=>validate(req({captureResult:'yes'})));
  assert.throws(()=>validate(req({route:'cloud',captureResult:true,session:'https://claude.ai/code/session_test',remoteScope:{reviewed:true,description:'text only'}})));
});
test('read-result validates stored content hash and excludes extraneous fields',()=>{
  const id=randomUUID();const response='fixture';const v={schema:1,requestId:id,provider:'claude',model:'sonnet',state:'executed',response,responseSha256:createHash('sha256').update(response).digest('hex'),auth:'SECRET'};
  assert.equal(capturedResult(v,id).integrityVerified,true);assert.ok(!JSON.stringify(capturedResult(v,id)).includes('SECRET'));
  assert.throws(()=>capturedResult({...v,response:'tampered'},id));assert.throws(()=>capturedResult(v,randomUUID()));
});
test('requested model alias is distinct from provider-reported actual model',()=>{
  const r=validate(req());const actualModels=observedActualModels({modelUsage:{'claude-sonnet-4-6':{}}});
  const m=metadata(r,{actualModels});assert.equal(m.requestedModel,'sonnet');assert.deepEqual(m.actualModels,['claude-sonnet-4-6']);
  assert.deepEqual(metadata(r,{}).actualModels,['UNKNOWN']);assert.deepEqual(observedActualModels({model:'Bearer SECRET'}),[]);
});
