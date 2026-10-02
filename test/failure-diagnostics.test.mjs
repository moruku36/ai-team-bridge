import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {redactDiagnostics,parseProviderFailure,diagnosticEnvelope} from '../failure-diagnostics.mjs';
import {executeWithDiagnostics} from '../wrapper-diagnostics-v2.mjs';

const req=()=>({id:randomUUID(),provider:'claude',prompt:'mock only',captureResult:true});
test('parseable provider error fields survive without arbitrary account/auth fields',()=>{
  const v=parseProviderFailure(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['Backend connection failed'],auth:{token:'SECRET'},email:'private@example.test'}));
  assert.equal(v.subtype,'error_during_execution');assert.deepEqual(v.errors,['Backend connection failed']);assert.ok(!JSON.stringify(v).includes('SECRET'));assert.ok(!JSON.stringify(v).includes('private@'));
});
test('common secret formats and identifiers are redacted while ordinary error remains',()=>{
  const input='Connection failed; Authorization: Bearer abcdefghijklmnopqrstuvwxyz API_KEY="hidden-value" token=another-hidden user@example.test https://login.test/?code=secret sk-ant-abcdefghijklmnop req_abcdef';
  const v=redactDiagnostics(input);assert.match(v,/Connection failed/);
  for(const secret of ['abcdefghijklmnopqrstuvwxyz','hidden-value','another-hidden','user@example','login.test','sk-ant-abcdefghijklmnop','req_abcdef'])assert.ok(!v.includes(secret));
});
test('NDJSON final error envelope is retained',()=>{
  const v=parseProviderFailure('{"event":"init"}\n{"event":"result","result":{"status":"ERROR","error":{"type":"network_error","message":"Connection refused"}}}\n');
  assert.equal(v.status,'ERROR');assert.equal(v.error.message,'Connection refused');
});
test('failed mock review preserves private stderr/outcome and never resubmits',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wrapper-diag-test-'));let calls=0;const r=req();
  const options={privacyCheck:async()=>{},runner:async()=>{calls++;return {exitCode:1,durationMs:175000,outputObserved:true,stdout:JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['Backend failed']}),stderr:'Connection failed Bearer abcdefghijklmnopqrstuvwxyz'};}};
  const v=await executeWithDiagnostics(r,root,options);assert.equal(v.state,'rejected');assert.equal(v.privateDiagnosticsCaptured,true);
  const d=JSON.parse(await readFile(v.diagnosticFile,'utf8'));assert.equal(d.providerExitCode,1);assert.match(d.stderrRedacted,/Connection failed/);assert.ok(!d.stderrRedacted.includes('abcdefghijklmnopqrstuvwxyz'));
  const audit=await readFile(path.join(root,'requests',r.id,'status.json'),'utf8');assert.ok(!audit.includes('Backend failed'));assert.ok(!audit.includes('Connection failed'));
  await assert.rejects(executeWithDiagnostics(r,root,options));assert.equal(calls,1);
});
test('privacy failure never launches or captures diagnostics',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wrapper-diag-private-test-'));
  const v=await executeWithDiagnostics(req(),root,{privacyCheck:async()=>{throw Error('deny');},runner:async()=>assert.fail('must not run')});
  assert.equal(v.reason,'private_storage_unavailable');assert.equal(v.diagnosticFile,undefined);
});
test('unparseable partial output is not promoted to a final response',()=>{
  assert.deepEqual(parseProviderFailure('unfinished source review'),{parseable:false});
});
test('Claude is_error true keeps code/message/metadata and cannot become completed',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wrapper-real-error-shape-'));
  const payload={type:'result',subtype:'error_during_execution',is_error:true,code:'invalid_request_error',message:'Request rejected',errors:['Provider returned an error'],result:'API Error: 400',num_turns:1,duration_ms:175000,session_id:'private-session',total_cost_usd:0};
  const result=await executeWithDiagnostics(req(),root,{privacyCheck:async()=>{},runner:async()=>({exitCode:1,durationMs:175000,outputObserved:true,stdout:JSON.stringify(payload),stderr:'API request failed'})});
  assert.equal(result.state,'rejected');assert.equal(result.resultFile,undefined);assert.equal(result.resultCaptured,false);
  const d=JSON.parse(await readFile(result.diagnosticFile,'utf8'));assert.equal(d.providerOutcome.isError,true);assert.equal(d.providerOutcome.code,'invalid_request_error');assert.equal(d.providerOutcome.message,'Request rejected');assert.equal(d.providerOutcome.duration_ms,175000);assert.equal(d.providerOutcome.errorResult,'API Error: 400');assert.ok(!JSON.stringify(d).includes('private-session'));
});
test('stderr and error messages are bounded after redaction',()=>{
  const d=diagnosticEnvelope({stdout:JSON.stringify({is_error:true,error:'x'.repeat(10000)}),stderr:'ordinary '.repeat(2000),exitCode:1},{state:'rejected',reason:'provider_failed'});
  assert.equal(d.stderrRedacted.length,8192);assert.equal(d.stderrTruncated,true);assert.equal(d.providerOutcome.error.length,4096);
});
