import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const base=path.dirname(fileURLToPath(import.meta.url));
const reasons=new Set(['started','provider_ack','provider_result','response_matched','response_mismatch','provider_rejected','provider_failed','unconfirmed_result','timeout','canceled','output_limit','launch_failed','invalid_output','quota_exhausted','rate_limited','private_storage_unavailable']);
export function validate(input) {
  const allowed=new Set(['id','provider','prompt','route','model','timeoutSeconds','session','remoteScope','taskScope','captureResult','expectResponse']);
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!allowed.has(k))) throw Error('Unsupported request fields. Arbitrary tools and flags are not accepted.');
  const r={route:'local',timeoutSeconds:120,...input};
  if(typeof r.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.id)) throw Error('A unique UUID id is required.');
  if(!['claude','antigravity'].includes(r.provider)||!['local','cloud'].includes(r.route)) throw Error('Unsupported provider or route.');
  if(typeof r.prompt!=='string'||!r.prompt.trim()||Buffer.byteLength(r.prompt)>65536||r.prompt.includes('\0')) throw Error('Prompt must be nonempty UTF-8 text, at most 64 KiB, without NUL.');
  if(!Number.isInteger(r.timeoutSeconds)||r.timeoutSeconds<1||r.timeoutSeconds>600) throw Error('Timeout must be 1–600 seconds.');
  r.model??=r.provider==='claude'?'sonnet':'gemini-3.8-flash-medium';
  if(r.model!==(r.provider==='claude'?'sonnet':'gemini-3.8-flash-medium')) throw Error('Only the inventory-verified model is supported.');
  if(r.expectResponse!==undefined&&(typeof r.expectResponse!=='string'||r.expectResponse.length>65536)) throw Error('Invalid response expectation.');
  if(r.captureResult!==undefined&&typeof r.captureResult!=='boolean')throw Error('captureResult must be boolean.');
  if(r.captureResult&&r.route!=='local')throw Error('Only local final results can be captured.');
  if(r.route==='cloud') {
    if(r.provider!=='claude') throw Error('Antigravity cloud route is not supported.');
    if(typeof r.session!=='string'||!/^https:\/\/claude\.ai\/code\/(session_|cse_)[A-Za-z0-9_-]+$/.test(r.session)) throw Error('An exact existing Claude session URL is required.');
    const s=r.remoteScope;
    if(!s||s.reviewed!==true||typeof s.description!=='string'||!s.description.trim()||s.description.length>4096||Object.keys(s).some(k=>!['reviewed','description'].includes(k))) throw Error('Existing cloud permissions and per-task scope must be explicitly reviewed.');
    if(r.expectResponse!==undefined) throw Error('Cloud acknowledgment cannot verify a response.');
  } else if(r.session!==undefined||r.remoteScope!==undefined) throw Error('Local requests cannot resume existing sessions.');
  if(r.provider==='antigravity') {
    const s=r.taskScope;
    if(!s||Array.isArray(s)||s.reviewed!==true||s.acceptInheritedPermissions!==true||s.acknowledgeInstructionScope!==true||!['plan','accept-edits'].includes(s.mode)||typeof s.description!=='string'||!s.description.trim()||s.description.length>4096||s.description.includes('\0')||Object.keys(s).some(k=>!['reviewed','acceptInheritedPermissions','acknowledgeInstructionScope','mode','description'].includes(k))) throw Error('Antigravity requires an explicitly reviewed task scope and acknowledgment of inherited permissions. Per-invocation tool allowlists are unavailable.');
  } else if(r.taskScope!==undefined) throw Error('Claude taskScope is unsupported; local tools remain disabled.');
  return r;
}

export function plan(r,cwd) {
  const profile=process.env.USERPROFILE;
  const exe=r.provider==='claude'?path.join(profile??'','\.local','bin','claude.exe'):path.join(profile??'','AppData','Local','agy','bin','agy.exe');
  if(r.route==='cloud') return {exe,args:['-p','--cloud',r.session,'--output-format','json'],input:`Task scope (reviewed by requester): ${r.remoteScope.description}\n\n${r.prompt}\n`,cwd};
  if(r.provider==='claude') return {exe,args:['-p','--model',r.model,'--tools','','--safe-mode','--strict-mcp-config','--no-session-persistence','--output-format','json'],input:r.prompt+'\n',cwd};
  // AGY stdin requires its documented NDJSON streaming protocol.
  const message=`Authorized task scope: ${r.taskScope.description}\nWorking directory: the fresh scratch workspace for this request only. Do not access other local workspaces or processes. No credentials, account/security/network changes, external writes, resource lifecycle operations, background tasks, persistent configuration, or permission bypass is authorized. Do not expand this scope. If the task requires more access, report the unmet requirement and stop.\n\n${r.prompt}`;
  return {exe,args:['--input-format','stream-json','--output-format','stream-json','--sandbox','--model',r.model,'--mode',r.taskScope.mode,'--disable-slash-commands','--print-timeout',`${r.timeoutSeconds}s`],input:JSON.stringify({event:'user',message:{content:message}})+'\n',cwd};
}

export function classify(route,provider,json,exitCode,expectResponse) {
  if(route==='cloud') {
    if(json.ok===true&&exitCode===0) return {state:'accepted',reason:'provider_ack'};
    if(json.ok===false) return {state:'rejected',reason:'provider_rejected'};
    return {state:'unknown',reason:'unconfirmed_result'};
  }
  let response;
  if(provider==='claude'&&json.type==='result'&&json.subtype==='success'&&json.is_error===false&&exitCode===0&&typeof json.result==='string') response=json.result;
  if(provider==='antigravity'&&json.status==='SUCCESS'&&exitCode===0&&typeof json.response==='string') response=json.response;
  if(response!==undefined) {
    if(expectResponse!==undefined) return {state:response.trim()===expectResponse.trim()?'verified':'executed',reason:response.trim()===expectResponse.trim()?'response_matched':'response_mismatch',response};
    return {state:'executed',reason:'provider_result',response};
  }
  if(json.is_error===true||json.status==='ERROR') return {state:'rejected',reason:'provider_failed'};
  return {state:'unknown',reason:'unconfirmed_result'};
}

export function metadata(r,result) {
  const actualModels=Array.isArray(result.actualModels)?result.actualModels.filter(v=>typeof v==='string'&&/^(?:claude|gemini|gpt)-[a-z0-9.-]{1,80}$/.test(v)).slice(0,8):[];
  return {schema:1,id:r.id,provider:r.provider,route:r.route,model:r.route==='cloud'?'existing-session':r.model,state:['accepted','executed','verified','unknown','rejected'].includes(result.state)?result.state:'unknown',
    reason:reasons.has(result.reason)?result.reason:'unconfirmed_result',timestamp:new Date().toISOString(),
    timeoutSeconds:r.timeoutSeconds,durationMs:Number.isFinite(result.durationMs)?Math.round(result.durationMs):0,
    exitCode:Number.isInteger(result.exitCode)?result.exitCode:null,automaticRetry:false,
    scope:r.route==='cloud'?'reviewed-cloud':r.provider==='antigravity'?'reviewed-existing-permissions':'no-tools',outputObserved:result.outputObserved===true,resultCaptured:result.resultCaptured===true,
    requestedModel:r.route==='cloud'?'existing-session':r.model,actualModels:actualModels.length?actualModels:['UNKNOWN']};
}

export function observedActualModels(json) {
  const usage=json?.modelUsage;
  const candidates=usage&&typeof usage==='object'&&!Array.isArray(usage)?Object.keys(usage):typeof json?.model==='string'?[json.model]:[];
  return candidates.filter(v=>/^(?:claude|gemini|gpt)-[a-z0-9.-]{1,80}$/.test(v)).slice(0,8);
}

export function statusMetadata(v,id) {
  if(!v||v.schema!==1||v.id!==id||!['claude','antigravity'].includes(v.provider)||!['local','cloud'].includes(v.route)||!Number.isInteger(v.timeoutSeconds)||v.timeoutSeconds<1||v.timeoutSeconds>600) throw Error('Invalid metadata.');
  const r={id,provider:v.provider,route:v.route,timeoutSeconds:v.timeoutSeconds,model:v.provider==='claude'?'sonnet':'gemini-3.8-flash-medium'};
  const m=metadata(r,v);
  if(typeof v.timestamp==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.timestamp))m.timestamp=v.timestamp;
  return m;
}

export function capturedResult(v,id) {
  if(!v||v.schema!==1||v.requestId!==id||!['claude','antigravity'].includes(v.provider)||!['executed','verified'].includes(v.state)||typeof v.response!=='string'||!['sonnet','gemini-3.8-flash-medium'].includes(v.model)||!/^[a-f0-9]{64}$/.test(v.responseSha256??''))throw Error('Invalid captured result.');
  const digest=createHash('sha256').update(v.response,'utf8').digest('hex');
  if(digest!==v.responseSha256)throw Error('Result integrity mismatch.');
  const modelInfo=metadata({id,provider:v.provider,route:'local',model:v.model,timeoutSeconds:1},{actualModels:v.actualModels});
  return {id,provider:v.provider,model:v.model,requestedModel:v.model,actualModels:modelInfo.actualModels,state:v.state,response:v.response,responseSha256:digest,integrityVerified:true};
}

export function runProcess(p,timeoutMs,signal) {
  return new Promise(resolve=>{
    const start=Date.now();let stdout='',stderr='',size=0,reason,done=false,child,timer,killTimer;
    const finish=(exitCode)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',cancel);resolve({stdout,stderr,exitCode,reason,outputObserved:size>0,durationMs:Date.now()-start});};
    const stop=(why)=>{if(done||reason)return;reason=why;try{child.stdin.destroy();child.kill();}catch{};killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{};finish(null);},1500);};
    const cancel=()=>stop('canceled');
    if(signal?.aborted){reason='canceled';finish(null);return;}
    try{child=spawn(p.exe,p.args,{cwd:p.cwd,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});}catch{reason='launch_failed';finish(null);return;}
    child.on('error',()=>{reason='launch_failed';finish(null);});
    const capture=(which,c)=>{size+=Buffer.byteLength(c);if(size>2*1024*1024){stop('output_limit');return;}if(which==='out')stdout+=c;else stderr+=c;};
    // Decoders prevent splitting multibyte UTF-8 characters across chunks.
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',c=>capture('out',c));child.stderr.on('data',c=>capture('err',c));
    child.stdin.on('error',()=>{});
    child.on('close',code=>finish(code));
    timer=setTimeout(()=>stop('timeout'),timeoutMs);signal?.addEventListener('abort',cancel,{once:true});
    child.stdin.end(p.input,'utf8');
  });
}

export async function ensurePrivateDirectory(dir,signal) {
  if(process.platform!=='win32') throw Error('Private output is supported on Windows only.');
  const exe=path.join(process.env.ProgramFiles??'C:\\Program Files','PowerShell','7','pwsh.exe');
  const o=await runProcess({exe,args:['-NoProfile','-NonInteractive','-File',path.join(base,'private-output.ps1'),'-Path',dir],input:'',cwd:base},10000,signal);
  if(o.reason||o.exitCode!==0||JSON.parse(o.stdout).private!==true)throw Error('Private storage unavailable.');
}

export function failureReason(json,stderr) {
  const text=[typeof json?.error==='string'?json.error:'',Array.isArray(json?.errors)?json.errors.filter(v=>typeof v==='string').join(' '):'',stderr??''].join(' ');
  if(/usage limit|quota exceeded|quota exhausted|out of extra usage|limit reached/i.test(text))return 'quota_exhausted';
  if(/rate.limit|too many requests|\b429\b/i.test(text))return 'rate_limited';
  return undefined;
}

export async function subscriptionPreflight(r,p,{runner=runProcess,env=process.env,settingsReader=readFile,signal}={}) {
  // No credential values are printed, persisted, or inspected.
  const blocked=r.provider==='claude'?['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']:['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_BASE_URL'];
  if(blocked.some(k=>Object.hasOwn(env,k))) throw Error('API-key/custom-provider environment is not allowed.');
  if(r.provider==='claude') {
    const o=await runner({...p,args:['auth','status','--json'],input:''},15000,signal);
    let a;try{a=JSON.parse(o.stdout);}catch{throw Error('Subscription status unknown.');}
    if(o.reason||o.exitCode!==0||a.loggedIn!==true||a.authMethod!=='claude.ai'||a.apiProvider!=='firstParty'||!['pro','max','team','enterprise'].includes(a.subscriptionType)) throw Error('Existing Claude subscription login required.');
  } else {
    const settings=path.join(env.USERPROFILE??'','.gemini','antigravity-cli','settings.json');
    let s={};try{s=JSON.parse(await settingsReader(settings,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Antigravity settings unreadable.');}
    if(s.modelProvider!==undefined&&s.modelProvider!==null&&s.modelProvider!=='') throw Error('Antigravity API provider is not allowed.');
    const o=await runner({...p,args:['models'],input:''},15000,signal);
    if(o.reason||o.exitCode!==0||!o.stdout.split(/\r?\n/).some(line=>line.split(/\s+/)[0]===r.model)) throw Error('Existing Antigravity login/model unavailable. No OAuth will be started.');
  }
}

function parseResult(provider,route,text) {
  if(provider==='antigravity'&&route==='local') {
    const events=text.split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
    const results=events.filter(e=>e.event==='result');if(results.length!==1)throw Error('invalid');return results[0].result;
  }
  return JSON.parse(text);
}

export async function execute(input,root=path.join(base,'data'),{runner=runProcess,signal,privacyCheck=ensurePrivateDirectory}={}) {
  const r=validate(input);const dir=path.join(root,'requests',r.id);await mkdir(path.dirname(dir),{recursive:true});
  // Atomic reservation survives crash/timeout. An existing ID is never resubmitted.
  try{await mkdir(dir);}catch{throw Error('Request ID already reserved or workspace unavailable. Do not resubmit an uncertain cloud send.');}
  const statusFile=path.join(dir,'status.json');
  if(r.captureResult) {
    try{await privacyCheck(dir,signal);}catch{
      const m=metadata(r,{state:'rejected',reason:'private_storage_unavailable'});
      await writeFile(statusFile,JSON.stringify(m,null,2));return m;
    }
  }
  await writeFile(statusFile,JSON.stringify(metadata(r,{state:'unknown',reason:'started'}),null,2));
  const cwd=path.join(dir,'workspace');await mkdir(cwd);
  const p=plan(r,cwd);
  const o=await runner(p,r.timeoutSeconds*1000,signal);
  let result={state:'unknown',reason:o.reason??'invalid_output'};
  if(!o.reason) {try{const json=parseResult(r.provider,r.route,o.stdout);result=classify(r.route,r.provider,json,o.exitCode,r.expectResponse);result.actualModels=observedActualModels(json);if(result.state==='rejected')result.reason=failureReason(json,o.stderr)??result.reason;}catch{result.reason=failureReason(undefined,o.stderr)??result.reason;}}
  const m=metadata(r,{...result,outputObserved:o.outputObserved,exitCode:o.exitCode,durationMs:o.durationMs});
  await writeFile(statusFile,JSON.stringify(m,null,2));
  if(r.captureResult&&result.response!==undefined&&['executed','verified'].includes(m.state)) {
    const resultFile=path.join(dir,'result.json');
    const responseSha256=createHash('sha256').update(result.response,'utf8').digest('hex');
    try {
      await writeFile(resultFile,JSON.stringify({schema:1,requestId:r.id,provider:r.provider,model:r.model,requestedModel:r.model,actualModels:m.actualModels,state:m.state,response:result.response,responseSha256},null,2),{encoding:'utf8',flag:'wx',mode:0o600});
      m.resultCaptured=true;await writeFile(statusFile,JSON.stringify(m,null,2));
      return {...m,resultFile,responseSha256};
    } catch {return {...m,captureFailure:'private_storage_unavailable'};}
  }
  return {...m,...(result.response!==undefined?{response:result.response}:{})};
}

async function main(args) {
  if(args.length!==2||!['send','status','read-result'].includes(args[0])) throw Error('Usage: node wrapper.mjs send REQUEST.json | status REQUEST_UUID | read-result REQUEST_UUID');
  if(args[0]==='status'||args[0]==='read-result') {
    if(!/^[0-9a-f-]{36}$/i.test(args[1])) throw Error('Invalid request ID.');
    const file=args[0]==='status'?'status.json':'result.json';
    const v=JSON.parse(await readFile(path.join(base,'data','requests',args[1],file),'utf8'));
    console.log(JSON.stringify(args[0]==='status'?statusMetadata(v,args[1]):capturedResult(v,args[1]),null,2));return;
  }
  const r=validate(JSON.parse(await readFile(path.resolve(args[1]),'utf8')));
  // Read executable availability without launching a provider or triggering OAuth.
  await access(plan(r,base).exe,constants.F_OK);
  const controller=new AbortController();const cancel=()=>controller.abort();process.once('SIGINT',cancel);
  try{await subscriptionPreflight(r,plan(r,base),{signal:controller.signal});
    if(controller.signal.aborted)throw Error('Canceled before submission.');
    const out=await execute(r,undefined,{signal:controller.signal});console.log(JSON.stringify(out,null,2));
    if(['unknown','rejected'].includes(out.state)||(r.captureResult&&!out.resultCaptured)||out.captureFailure)process.exitCode=2;
  }finally{process.removeListener('SIGINT',cancel);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(()=>{console.error('Request not sent or not confirmed. Check request format (Antigravity requires reviewed taskScope), existing login, CLI availability, and local status. Raw errors are suppressed.');process.exitCode=1;});
}
