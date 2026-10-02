import {mkdir,readFile,writeFile,access,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validate,plan,subscriptionPreflight,capturedResult} from './wrapper.mjs';
import {executeWithDiagnostics} from './wrapper-diagnostics-v2.mjs';
import {ValidationError,fail,ALIAS,MODEL,NAME,PROVIDERS,authorizesLive,canonicalJson,indexSnapshots,parseInstant,poolKey} from './quota-snapshots.mjs';

const base=path.dirname(fileURLToPath(import.meta.url));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Reviewed ceilings: a policy may narrow roles but can never add one.
const ROLES={claude:['draft','implementation'],antigravity:['draft','prototype'],codex:['coordination','verification','review']};
const ALL_ROLES=[...new Set(Object.values(ROLES).flat())];
const MODELS={claude:'sonnet',antigravity:'gemini-3.8-flash-medium'};
const SIZES=['small','medium','large'];
const CLASSES=['public','personal','corporate','confidential','secret'];
const APPROVALS=['not-required','required','approved'];
const STATES=['accepted','executed','verified','unknown','rejected'];
const TASK_KEYS=['id','prompt','classification','approval','providers','role','size','permissionScope','timeoutSeconds','estimates','allowExecute','taskScope'];
// Best-effort only: classification is an operator assertion, not proof the text is safe to send.
const SECRET=[/-----BEGIN [A-Z ]*PRIVATE KEY-----/,/\bAKIA[0-9A-Z]{16}\b/,/\bgh[pousr]_[A-Za-z0-9]{36,}/,/\bsk-[A-Za-z0-9_-]{20,}/,/\bxox[abprs]-[A-Za-z0-9-]{10,}/,/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/];
const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const only=(o,keys)=>isObj(o)&&Object.keys(o).every(k=>keys.includes(k));

export function validatePolicy(p) {
  if(!only(p,['schema','reviewed','preference','providers'])||p.schema!==1||p.reviewed!==true||!Array.isArray(p.providers)||!p.providers.length||p.providers.length>3)fail('invalid_policy');
  const providers=p.providers.map((e,i)=>{
    if(!only(e,['provider','mode','accountScope','modelScope','roles','maxSize','maxAgeSeconds','requiredWindows','reservePercent'])||!Object.hasOwn(ROLES,e.provider)||p.providers.findIndex(x=>x.provider===e.provider)!==i)fail('invalid_policy_provider');
    if(!Array.isArray(e.roles)||!e.roles.length||!e.roles.every(r=>ROLES[e.provider].includes(r)))fail('role_expansion');
    if(!SIZES.includes(e.maxSize)||!['dispatch','handoff'].includes(e.mode))fail('invalid_policy_provider');
    const v={provider:e.provider,mode:e.mode,roles:[...e.roles],maxSize:e.maxSize};
    if(e.mode==='handoff')return v;
    if(e.provider==='codex')fail('codex_handoff_only');
    if(typeof e.accountScope!=='string'||!ALIAS.test(e.accountScope)||typeof e.modelScope!=='string'||!MODEL.test(e.modelScope))fail('invalid_policy_scope');
    if(e.modelScope!==MODELS[e.provider])fail('model_scope_mismatch');
    if(!Number.isInteger(e.maxAgeSeconds)||e.maxAgeSeconds<1||e.maxAgeSeconds>86400)fail('invalid_policy_age');
    const rw=e.requiredWindows;
    if(!Array.isArray(rw)||!rw.length||rw.length>16||new Set(rw).size!==rw.length||!rw.every(w=>typeof w==='string'&&NAME.test(w)))fail('invalid_policy_windows');
    if(!only(e.reservePercent,rw)||!rw.every(w=>typeof e.reservePercent[w]==='number'&&e.reservePercent[w]>=0&&e.reservePercent[w]<100))fail('invalid_policy_reserve');
    return {...v,accountScope:e.accountScope,modelScope:e.modelScope,maxAgeSeconds:e.maxAgeSeconds,requiredWindows:[...rw],reservePercent:{...e.reservePercent}};
  });
  let preference=null;
  if(p.preference!==undefined) {
    const q=p.preference;
    if(!only(q,['provider','until'])||!providers.some(x=>x.provider===q.provider))fail('invalid_preference');
    preference={provider:q.provider,untilMs:parseInstant(q.until,'invalid_preference')};
  }
  return {providers,preference};
}

export function validateTask(t) {
  if(!only(t,TASK_KEYS))fail('invalid_task');
  if(typeof t.id!=='string'||!UUID.test(t.id))fail('invalid_task_id');
  if(typeof t.prompt!=='string'||!t.prompt.trim()||Buffer.byteLength(t.prompt)>65536||t.prompt.includes('\0'))fail('invalid_prompt');
  if(!CLASSES.includes(t.classification))fail('invalid_classification');
  if(!APPROVALS.includes(t.approval))fail('invalid_approval');
  if(!Array.isArray(t.providers)||!t.providers.length||new Set(t.providers).size!==t.providers.length||!t.providers.every(p=>PROVIDERS.includes(p)))fail('invalid_providers');
  if(!ALL_ROLES.includes(t.role))fail('invalid_role');
  if(!SIZES.includes(t.size))fail('invalid_size');
  if(t.permissionScope!=='text-only')fail('invalid_permission_scope');
  if(!Number.isInteger(t.timeoutSeconds)||t.timeoutSeconds<1||t.timeoutSeconds>600)fail('invalid_timeout');
  if(t.allowExecute!==undefined&&typeof t.allowExecute!=='boolean')fail('invalid_allow_execute');
  if(t.taskScope!==undefined&&!isObj(t.taskScope))fail('invalid_task_scope');
  if(!isObj(t.estimates))fail('invalid_estimate');
  for(const [p,e] of Object.entries(t.estimates)) {
    if(!PROVIDERS.includes(p)||!only(e,['durationSeconds','windows'])||!Number.isInteger(e.durationSeconds)||e.durationSeconds<1||e.durationSeconds>600||!isObj(e.windows)||!Object.keys(e.windows).length)fail('invalid_estimate');
    for(const [w,d] of Object.entries(e.windows))if(!NAME.test(w)||typeof d!=='number'||!Number.isFinite(d)||d<=0||d>100)fail('invalid_estimate');
  }
  return {...t,allowExecute:t.allowExecute===true};
}

export const fingerprint=task=>createHash('sha256').update(canonicalJson(task)).digest('hex');

// Only the task prompt reaches the provider; quota, policy and account data never do.
export function buildRequest(t,pe) {
  return {id:t.id,provider:pe.provider,prompt:t.prompt,route:'local',model:MODELS[pe.provider],timeoutSeconds:t.timeoutSeconds,captureResult:true,...(pe.provider==='antigravity'?{taskScope:t.taskScope}:{})};
}

function gate(t) {
  const r=[];
  if(!['public','personal'].includes(t.classification))r.push('classification_blocked');
  else if(t.classification==='personal'&&t.approval!=='approved')r.push('personal_requires_approval');
  if(t.approval==='required')r.push('approval_required');
  const sent=[t.prompt,t.taskScope?.description].filter(v=>typeof v==='string');
  if(SECRET.some(re=>sent.some(x=>re.test(x))))r.push('secret_pattern');
  return r;
}

function evaluate(t,pe,{nowMs,index,reserved}) {
  const why=new Set(),demands=[],out={demands,reasons:[]};
  if(!pe.roles.includes(t.role))why.add('role_not_allowed');
  if(SIZES.indexOf(t.size)>SIZES.indexOf(pe.maxSize))why.add('size_exceeds_policy');
  if(pe.mode==='handoff'){out.reasons=[...why];return out;}
  out.model=MODELS[pe.provider];
  if(pe.provider==='antigravity'&&t.taskScope?.mode!=='plan')why.add('plan_mode_required');
  else try{validate(buildRequest(t,pe));}catch{why.add('invalid_wrapper_request');}
  const est=t.estimates[pe.provider];
  if(!est)why.add('missing_estimate');
  else if(est.durationSeconds>t.timeoutSeconds)why.add('duration_exceeds_timeout');
  const ent=index.pools.get(poolKey(pe.provider,pe.accountScope,pe.modelScope));
  if(!ent)why.add(index.providers.has(pe.provider)?'scope_mismatch':'no_snapshot');
  else if(ent.conflict)why.add('conflicting_snapshots');
  else {
    const s=ent.snapshot,age=nowMs-s.observedAtMs,defers=[];
    out.quotaSource=s.source;out.liveAuthorized=authorizesLive(s);
    if(age<0)why.add('snapshot_future');
    else if(age>pe.maxAgeSeconds*1000)why.add('snapshot_stale');
    for(const w of pe.requiredWindows) {
      const win=s.windows.find(x=>x.name===w);
      if(!win){why.add('window_missing');continue;}
      // A passed reset never implies fresh capacity; a post-reset observation is required.
      if(win.resetsAtMs<=nowMs){why.add('window_expired');continue;}
      if(win.remainingPercent<=0){why.add('window_exhausted');defers.push(win.resetsAtMs);continue;}
      const d=est?.windows[w];
      if(d===undefined){if(est)why.add('missing_estimate');continue;}
      if(nowMs+est.durationSeconds*1000>=win.resetsAtMs){why.add('reset_before_completion');defers.push(win.resetsAtMs);continue;}
      const key=poolKey(pe.provider,pe.accountScope,pe.modelScope)+'|'+w;
      if(win.remainingPercent-(reserved.get(key)??0)-d<pe.reservePercent[w]){why.add('insufficient_headroom');defers.push(win.resetsAtMs);continue;}
      demands.push([key,d]);
    }
    if(defers.length)out.defer=Math.min(...defers);
  }
  out.reasons=[...why];
  return out;
}

// Pure dry run: no provider is launched and nothing is reserved. `now` exists for deterministic dry-run tests only.
export function routeQueue(queue,snapshots,policyInput,{now=new Date(),only:onlyId}={}) {
  const policy=validatePolicy(policyInput);
  const nowMs=now instanceof Date?now.getTime():typeof now==='number'?now:typeof now==='string'?parseInstant(now,'invalid_now'):NaN;
  if(!Number.isFinite(nowMs))fail('invalid_now');
  if(!only(queue,['schema','tasks'])||queue.schema!==1||!Array.isArray(queue.tasks)||queue.tasks.length>100)fail('invalid_queue');
  const index=indexSnapshots(snapshots);
  const entries=queue.tasks.map(raw=>{
    try{const task=validateTask(raw);return {id:task.id,task,fp:fingerprint(task)};}
    catch(e){if(!(e instanceof ValidationError))throw e;return {id:isObj(raw)&&typeof raw.id==='string'&&UUID.test(raw.id)?raw.id:null,error:e.code};}
  });
  const seen=new Map();
  for(const e of entries)if(e.id)seen.set(e.id,[...(seen.get(e.id)??[]),e.fp??'invalid:'+e.error]);
  const dupes=new Map([...seen].filter(([,v])=>v.length>1).map(([id,v])=>[id,new Set(v).size>1?'conflicting_task_id':'duplicate_task_id']));
  const pref=policy.preference&&nowMs<policy.preference.untilMs?policy.preference.provider:null;
  const reserved=new Map();
  const decide=e=>{
    if(e.error)return {id:e.id,status:'blocked',reasons:[e.error]};
    const t=e.task;
    if(dupes.has(t.id))return {id:t.id,status:'blocked',reasons:[dupes.get(t.id)]};
    const gates=gate(t);
    let cands=policy.providers.filter(p=>t.providers.includes(p.provider));
    if(!cands.length)gates.push('no_permitted_provider');
    if(gates.length)return {id:t.id,status:'blocked',reasons:gates};
    // Preference only reorders providers the task already permits; it never adds capacity or permission.
    if(pref)cands=[...cands.filter(c=>c.provider===pref),...cands.filter(c=>c.provider!==pref)];
    const tried=[];
    for(const c of cands) {
      const r=evaluate(t,c,{nowMs,index,reserved});
      tried.push({provider:c.provider,mode:c.mode,reasons:r.reasons,defer:r.defer});
      if(r.reasons.length)continue;
      for(const [k,d] of r.demands)reserved.set(k,(reserved.get(k)??0)+d);
      const candidates=tried.map(({defer,...x})=>x);
      if(c.mode==='handoff')return {id:t.id,status:'handoff',provider:c.provider,adapterRequired:true,fingerprint:e.fp,reasons:[],candidates};
      return {id:t.id,status:'eligible',provider:c.provider,model:r.model,fingerprint:e.fp,preferenceApplied:pref===c.provider,quotaSource:r.quotaSource,liveAuthorized:r.liveAuthorized===true,
        executePermitted:t.allowExecute,warnings:r.quotaSource==='mock'?['mock_quota_not_live']:[],reasons:[],candidates};
    }
    const defers=tried.map(x=>x.defer).filter(Number.isFinite);
    return {id:t.id,status:'blocked',reasons:[...new Set(tried.flatMap(x=>x.reasons))],...(defers.length?{deferUntil:new Date(Math.min(...defers)).toISOString()}:{}),candidates:tried.map(({defer,...x})=>x)};
  };
  const decisions=entries.filter(e=>onlyId===undefined||e.id===onlyId).map(decide);
  const n=s=>decisions.filter(d=>d.status===s).length;
  return {schema:1,dryRun:true,now:new Date(nowMs).toISOString(),preferenceActive:pref!==null,decisions,summary:{eligible:n('eligible'),handoff:n('handoff'),blocked:n('blocked')}};
}

const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:undefined;
const rel=(root,f)=>{
  if(typeof f!=='string')return undefined;
  const r=path.relative(root,f).split(path.sep).join('/');
  return r&&!r.startsWith('..')&&!path.isAbsolute(r)?r:undefined;
};

// Reads the private result file back through wrapper.mjs `capturedResult` (request id, content SHA-256, allowlisted fields).
// Only a file directly inside requests/<UUID>/ qualifies. Returns metadata only; the response text is never returned or stored.
// A passing readback shows the stored bytes match the recorded hash. It is not cryptographic authenticity and not answer accuracy.
async function readback(root,id,res,d) {
  if(res.resultCaptured!==true||res.captureFailure!==undefined||!hex(res.responseSha256)||typeof res.resultFile!=='string')return {ok:false,reason:'artifact_capture_failed'};
  const inside=(a,b)=>{const x=path.relative(a,b);return x!==''&&!x.startsWith('..')&&!path.isAbsolute(x)&&!x.includes(path.sep);};
  const dir=path.resolve(root,'requests',id),file=path.resolve(res.resultFile);
  if(!inside(dir,file))return {ok:false,reason:'artifact_path_invalid'};
  try {
    const [realDir,realFile]=await Promise.all([realpath(dir),realpath(file)]);
    if(!inside(realDir,realFile))return {ok:false,reason:'artifact_path_invalid'};
    const text=await readFile(realFile,'utf8');
    if(text.length>8388608)return {ok:false,reason:'artifact_unreadable_or_invalid'};
    const c=capturedResult(JSON.parse(text),id);
    if(c.provider!==d.provider||(c.requestedModel??c.model)!==d.model||c.responseSha256!==res.responseSha256)return {ok:false,reason:'artifact_binding_mismatch'};
    return {ok:true};
  } catch {return {ok:false,reason:'artifact_unreadable_or_invalid'};}
}

// Executes at most one task with one provider call. Uses the real clock, revalidates just before launch,
// and never retries or falls back. `deps` is an API-level injection point for offline tests; the CLI passes none.
export async function dispatchTask(queue,snapshots,policyInput,taskId,deps={}) {
  const {root=path.join(base,'data'),signal,executor=executeWithDiagnostics,preflight=subscriptionPreflight,runner,privacyCheck}=deps;
  const stop=(outcome,reasons=[],extra={})=>({schema:1,outcome,id:taskId,launched:false,reasons,...extra});
  if(typeof taskId!=='string'||!UUID.test(taskId))return stop('blocked',['invalid_task_id']);
  const decide=()=>{
    try{return routeQueue(queue,snapshots,policyInput,{now:new Date(),only:taskId}).decisions[0];}
    catch(e){if(e instanceof ValidationError)return {status:'blocked',reasons:[e.code]};throw e;}
  };
  const d=decide();
  if(!d)return stop('blocked',['task_not_found']);
  if(d.status==='handoff')return stop('handoff_required',[],{provider:d.provider,adapterRequired:true});
  if(d.status!=='eligible')return stop('blocked',d.reasons);
  const refusal=[];
  if(!d.executePermitted)refusal.push('execute_not_permitted');
  if(!d.liveAuthorized)refusal.push('mock_quota_not_live');
  if(refusal.length)return stop('blocked',refusal);
  const task=validateTask(queue.tasks.find(t=>t?.id===taskId));
  const pe=validatePolicy(policyInput).providers.find(e=>e.provider===d.provider);
  const r=validate(buildRequest(task,pe));
  const dir=path.join(root,'routing',taskId);
  const existing=async()=>{
    const prev=await readFile(path.join(dir,'reservation.json'),'utf8').then(t=>JSON.parse(t)).catch(()=>null);
    return stop(prev&&prev.fingerprint!==d.fingerprint?'conflicting_task_payload':'already_reserved',['reservation_exists']);
  };
  if(await access(dir).then(()=>true,()=>false))return existing();
  if(signal?.aborted)return stop('canceled_before_dispatch');
  try{await preflight(r,plan(r,process.cwd()),{signal});}catch{return signal?.aborted?stop('canceled_before_dispatch'):stop('preflight_failed',['subscription_preflight_failed']);}
  if(signal?.aborted)return stop('canceled_before_dispatch');
  const again=decide();
  if(again?.status!=='eligible'||again.provider!==d.provider||again.fingerprint!==d.fingerprint||!again.liveAuthorized)return stop('blocked',['eligibility_changed']);
  // Atomic reservation (directory create) precedes any launch and is never removed, whatever the outcome.
  try{await mkdir(path.dirname(dir),{recursive:true});await mkdir(dir);}
  catch(e){if(e?.code==='EEXIST')return existing();return stop('blocked',['reservation_unavailable']);}
  const ledger=o=>writeFile(path.join(dir,'outcome.json'),JSON.stringify({schema:1,id:taskId,...o,updatedAt:new Date().toISOString()},null,2),{mode:0o600});
  try {
    await writeFile(path.join(dir,'reservation.json'),JSON.stringify({schema:1,id:taskId,fingerprint:d.fingerprint,provider:d.provider,model:d.model,quotaSource:d.quotaSource,eligibility:'eligible',reservedAt:new Date().toISOString()},null,2),{flag:'wx',mode:0o600});
    await ledger({state:'unknown',reason:'reserved_not_launched',phase:'reserved'});
  } catch {return stop('blocked',['reservation_unavailable'],{reserved:true});}
  if(await access(path.join(root,'requests',taskId)).then(()=>true,()=>false)) {
    await ledger({state:'unknown',reason:'request_id_in_use',phase:'blocked_before_launch'}).catch(()=>{});
    return stop('blocked',['request_id_in_use'],{reserved:true});
  }
  if(signal?.aborted) {
    await ledger({state:'unknown',reason:'canceled',phase:'canceled_before_dispatch'}).catch(()=>{});
    return stop('canceled_before_dispatch',[],{reserved:true});
  }
  try{await ledger({state:'unknown',reason:'launching',phase:'launching'});}
  catch{return stop('blocked',['reservation_unavailable'],{reserved:true});}
  // Final revalidation after the durable writes: real clock, same provider/fingerprint, permissions and signal.
  const last=decide();
  const canceled=signal?.aborted===true;
  if(canceled||last?.status!=='eligible'||last.provider!==d.provider||last.fingerprint!==d.fingerprint||!last.executePermitted||!last.liveAuthorized) {
    await ledger({state:'unknown',reason:canceled?'canceled':'eligibility_changed',phase:canceled?'canceled_before_dispatch':'blocked_before_launch'}).catch(()=>{});
    return canceled?stop('canceled_before_dispatch',[],{reserved:true}):stop('blocked',['eligibility_changed'],{reserved:true});
  }
  let res;
  try{res=await executor(r,root,{runner,signal,privacyCheck});}
  catch{res=undefined;}
  // Metadata only: no prompt, response or raw error text enters the ledger or the returned value.
  const rec={state:STATES.includes(res?.state)?res.state:'unknown',reason:typeof res?.reason==='string'&&/^[a-z_]{1,40}$/.test(res.reason)?res.reason:res?'unconfirmed_result':'execution_error',phase:'finished',
    exitCode:Number.isInteger(res?.exitCode)?res.exitCode:null,durationMs:Number.isFinite(res?.durationMs)?Math.round(res.durationMs):0,resultCaptured:res?.resultCaptured===true,
    resultPath:rel(root,res?.resultFile),responseSha256:hex(res?.responseSha256),diagnosticPath:rel(root,res?.diagnosticFile),diagnosticSha256:hex(res?.diagnosticSha256),
    captureFailure:res?.captureFailure==='private_storage_unavailable'?res.captureFailure:undefined,
    actualModels:Array.isArray(res?.actualModels)?res.actualModels.filter(v=>typeof v==='string'&&/^[a-z0-9.-]{1,80}$/.test(v)).slice(0,8):[]};
  // Known before-generation privacy failure: the executor was entered but no provider was launched.
  const preLaunch=res?.state==='rejected'&&res.reason==='private_storage_unavailable'&&res.resultCaptured!==true;
  // executed/verified is a provider final-answer state only; exit 0 additionally needs private capture and hash-checked readback.
  if(rec.state==='executed'||rec.state==='verified') {
    const a=await readback(root,taskId,res,d);
    rec.readbackIntegrityVerified=a.ok;
    if(!a.ok)rec.artifactFailure=a.reason;
  }
  let ledgerWriteFailed=false;
  try{await ledger(rec);}catch{ledgerWriteFailed=true;}
  return {schema:1,outcome:preLaunch?'rejected_before_launch':'dispatched',id:taskId,launched:!preLaunch,executorEntered:true,provider:d.provider,model:d.model,...rec,...(ledgerWriteFailed?{ledgerWriteFailed:true}:{})};
}
