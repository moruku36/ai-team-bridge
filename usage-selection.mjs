import {routeQueue,validatePolicy} from './task-router.mjs';
import {normalizeSnapshot,parseInstant,ValidationError,fail,ALIAS} from './quota-snapshots.mjs';

const POOLS={claude:'native-all-models',antigravity:'gemini-shared'};
const MODELS={claude:'sonnet',antigravity:'gemini-3.8-flash-medium'};
const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const only=(v,keys)=>obj(v)&&Object.keys(v).every(k=>keys.includes(k));
const percent=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100;
const freeze=v=>{if(obj(v)||Array.isArray(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};

export function validateSelectionPolicy(raw,routingPolicy) {
  const routing=validatePolicy(routingPolicy);
  if(!only(raw,['schema','reviewed','purpose','maxObservationAgeSeconds','safetyMarginPercent','unknownBackend','unknownReset','ranking','mappings'])||raw.schema!==1||raw.reviewed!==true||raw.purpose!=='advisory-only'||raw.unknownReset!=='advisory-only'||raw.ranking!=='policy-order'||!['allow-observed-freshness','require-backend-time'].includes(raw.unknownBackend))fail('invalid_selection_policy');
  if(!Number.isInteger(raw.maxObservationAgeSeconds)||raw.maxObservationAgeSeconds<1||raw.maxObservationAgeSeconds>120||!percent(raw.safetyMarginPercent)||raw.safetyMarginPercent<1)fail('invalid_selection_policy');
  if(!Array.isArray(raw.mappings)||!raw.mappings.length||raw.mappings.length>2)fail('invalid_selection_mapping');
  const mappings=raw.mappings.map(m=>{
    if(!only(m,['provider','accountScope','modelScope','pool','scopeReviewed'])||m.scopeReviewed!==true||!Object.hasOwn(POOLS,m.provider)||m.pool!==POOLS[m.provider]||m.modelScope!==MODELS[m.provider]||typeof m.accountScope!=='string'||!ALIAS.test(m.accountScope))fail('invalid_selection_mapping');
    const pe=routing.providers.find(p=>p.provider===m.provider&&p.mode==='dispatch');
    if(!pe||pe.accountScope!==m.accountScope||pe.modelScope!==m.modelScope)fail('selection_scope_mismatch');
    return {...m};
  });
  if(new Set(mappings.map(m=>m.provider)).size!==mappings.length)fail('duplicate_selection_mapping');
  return {...raw,mappings,routing};
}

// Pure reviewed-input boundary. Observation age is separate from backend age.
export function normalizeUsageForSelection(raw,mapping,policy,nowMs) {
  if(!obj(raw)||raw.schema!==1||!Object.hasOwn(POOLS,raw.provider)||raw.source!=='official-interactive-usage')fail('unsupported_normalization_adapter');
  if(!mapping||mapping.provider!==raw.provider||mapping.pool!==POOLS[raw.provider])fail('selection_scope_mismatch');
  if(raw.outcome!==undefined||raw.routerAuthorized!==false)fail('observation_not_completed');
  if(raw.rateLimited!==false||raw.freshness!=='backend-time-not-exposed')fail('observation_unavailable_or_last_known');
  if(raw.missingPools!==false)fail('observation_incomplete');
  const observedMs=parseInstant(raw.observedAt,'invalid_observed_at'),ageMs=nowMs-observedMs;
  if(ageMs<0)fail('observation_future');
  const pe=policy.routing.providers.find(p=>p.provider===raw.provider);
  const maxAgeSeconds=Math.min(policy.maxObservationAgeSeconds,pe.maxAgeSeconds);
  if(ageMs>maxAgeSeconds*1000)fail('observation_stale');
  const backendAt=raw.backendAt??null;
  if(backendAt!==null){const ms=parseInstant(backendAt,'invalid_backend_at');if(ms>observedMs||nowMs-ms>maxAgeSeconds*1000)fail('backend_time_invalid_or_stale');}
  else if(policy.unknownBackend==='require-backend-time')fail('backend_time_required');
  if(!Array.isArray(raw.pools)||raw.pools.length>2||new Set(raw.pools.map(p=>p?.pool)).size!==raw.pools.length)fail('observation_pool_invalid');
  if(raw.pools.some(p=>!obj(p)||!(raw.provider==='claude'?['native-all-models']:['gemini-shared','claude-gpt-shared']).includes(p.pool)))fail('observation_pool_invalid');
  const pool=raw.pools.find(p=>p.pool===mapping.pool);
  if(!pool||!Array.isArray(pool.windows)||pool.windows.length>16)fail('observation_incomplete');
  if(new Set(pool.windows.map(w=>w?.name)).size!==pool.windows.length)fail('observation_window_conflict');
  const windows=pe.requiredWindows.map(name=>{
    const w=pool.windows.find(x=>x.name===name),q=w?.quantitySource;
    if(!w||w.unavailable!==false||!percent(w.remainingPercent)||!percent(q?.value))fail('required_window_unavailable');
    if(!((q.kind==='remaining'&&q.operation==='identity'&&q.value===w.remainingPercent)||(q.kind==='used'&&q.operation==='100-minus-used'&&Math.abs(100-q.value-w.remainingPercent)<0.000001)))fail('quantity_inconsistent');
    const r=w.reset;
    if(!obj(r)||!['absolute','relative-rounded','time-only','calendar-without-year','available-without-reset','unknown'].includes(r.kind))fail('reset_category_unknown');
    const reset={kind:r.kind,absolute:null,timezone:null,relativeMinutes:null};
    if(r.kind==='absolute'){
      // Reuse strict offset/timezone validation; never derive an instant.
      const strict=normalizeSnapshot({schema:1,source:'manual',reviewed:true,provider:raw.provider,accountScope:mapping.accountScope,modelScope:mapping.modelScope,observedAt:raw.observedAt,windows:[{name,remainingPercent:w.remainingPercent,resetsAt:r.absolute,resetTimezone:r.timezone}]});
      if(strict.windows[0].resetsAtMs<=nowMs)fail('known_reset_expired');
      reset.absolute=r.absolute;reset.timezone=r.timezone;
    }else{
      if(r.absolute!=null)fail('nonexact_reset_has_absolute');
      if(r.timezone!=null){try{new Intl.DateTimeFormat('en-US',{timeZone:r.timezone});}catch{fail('invalid_reset_timezone');}reset.timezone=r.timezone;}
    }
    if(r.kind==='relative-rounded'){if(!Number.isSafeInteger(r.relativeMinutes)||r.relativeMinutes<0)fail('reset_category_unknown');reset.relativeMinutes=r.relativeMinutes;}
    return {name,remainingPercent:w.remainingPercent,quantitySource:{kind:q.kind,value:q.value,operation:q.operation},reset};
  });
  return freeze({schema:2,kind:'selection-observation',provider:raw.provider,accountScope:mapping.accountScope,modelScope:mapping.modelScope,poolScope:mapping.pool,observedAt:raw.observedAt,backendAt,observationAgeMs:ageMs,backendFreshness:backendAt===null?'unknown':'timestamp-present',expiresAt:new Date(observedMs+maxAgeSeconds*1000).toISOString(),modelBreakdownUnavailable:raw.modelBreakdownUnavailable===true,windows,dispatchAuthorized:false});
}

function reviewedIndex(document,policy,nowMs) {
  if(!only(document,['schema','reviewed','observations'])||document.schema!==1||document.reviewed!==true||!Array.isArray(document.observations)||document.observations.length>64)fail('reviewed_observation_document_required');
  const index=new Map(),rejected=[];
  for(const raw of document.observations){
    const provider=Object.hasOwn(POOLS,raw?.provider)?raw.provider:null;
    if(provider&&index.has(provider)){index.set(provider,{reason:'conflicting_observations'});rejected.push({provider,reason:'conflicting_observations'});continue;}
    try{const mapping=policy.mappings.find(m=>m.provider===provider);index.set(provider,{value:normalizeUsageForSelection(raw,mapping,policy,nowMs)});}
    catch(e){if(!(e instanceof ValidationError))throw e;rejected.push({provider,reason:e.code});if(provider)index.set(provider,{reason:e.code});}
  }
  return {index,rejected};
}

export function selectObservedQueue(queue,document,routingPolicy,selectionPolicy,{now}={}) {
  const nowMs=typeof now==='number'?now:parseInstant(now,'explicit_now_required');
  if(!Number.isFinite(nowMs))fail('explicit_now_required');
  const policy=validateSelectionPolicy(selectionPolicy,routingPolicy);
  // Existing gates report approval/role/wrapper/estimate errors alongside the
  // absent snapshot. Remove exactly that enum for ADVISORY selection only.
  const baseline=routeQueue(queue,[],routingPolicy,{now:nowMs});
  const {index,rejected}=reviewedIndex(document,policy,nowMs),reserved=new Map();
  const decisions=baseline.decisions.map((base,i)=>{
    const denied=reasons=>({id:base.id,status:'blocked',reasons,executePermitted:false,dispatchAuthorized:false});
    if(!base.candidates)return denied(base.reasons);
    const task=queue.tasks[i],tried=[];
    for(const candidate of base.candidates){
      const pe=policy.routing.providers.find(p=>p.provider===candidate.provider);
      const reasons=candidate.reasons.filter(r=>r!=='no_snapshot');
      if(pe.mode!=='dispatch'||!Object.hasOwn(POOLS,pe.provider))reasons.push('unsupported_selection_provider');
      const entry=index.get(pe.provider);
      if(!entry?.value)reasons.push(entry?.reason??'no_reviewed_observation');
      const obs=entry?.value,demands=[];
      if(obs&&pe.mode==='dispatch'){
        for(const name of pe.requiredWindows){
          const w=obs.windows.find(w=>w.name===name),estimate=task.estimates[pe.provider]?.windows[name];
          if(!w||!percent(estimate)||estimate<=0){reasons.push('missing_window_estimate');continue;}
          if(w.reset.absolute&&nowMs+task.estimates[pe.provider].durationSeconds*1000>=parseInstant(w.reset.absolute))reasons.push('known_reset_before_completion');
          const key=JSON.stringify([obs.provider,obs.accountScope,obs.poolScope,name]);
          if(w.remainingPercent-(reserved.get(key)??0)-estimate-pe.reservePercent[name]-policy.safetyMarginPercent<0)reasons.push('insufficient_headroom');
          demands.push([key,estimate]);
        }
      }
      tried.push({provider:candidate.provider,reasons:[...new Set(reasons)]});
      if(reasons.length)continue;
      for(const [key,estimate] of demands)reserved.set(key,(reserved.get(key)??0)+estimate);
      const quotaEvidence=obs.windows.map(w=>{
        const key=JSON.stringify([obs.provider,obs.accountScope,obs.poolScope,w.name]),batchDemandPercent=reserved.get(key)??0;
        return {name:w.name,remainingPercent:w.remainingPercent,quantitySource:w.quantitySource,batchDemandPercent,reservePercent:pe.reservePercent[w.name],safetyMarginPercent:policy.safetyMarginPercent,displayedHeadroomAfterBatchPercent:w.remainingPercent-batchDemandPercent-pe.reservePercent[w.name]-policy.safetyMarginPercent};
      });
      return {id:base.id,status:'selected-for-review',provider:pe.provider,modelScope:obs.modelScope,poolScope:obs.poolScope,observedAt:obs.observedAt,backendAt:obs.backendAt,backendFreshness:obs.backendFreshness,modelBreakdownUnavailable:obs.modelBreakdownUnavailable,expiresAt:obs.expiresAt,quotaEvidence,resetUncertainty:obs.windows.map(w=>({name:w.name,...w.reset})),executePermitted:false,dispatchAuthorized:false,candidates:tried,warnings:['advisory_only','no_deadline_ranking',...(obs.backendAt===null?['backend_freshness_unknown']:[]),...(obs.modelBreakdownUnavailable?['aggregate_only_model_breakdown_unavailable']:[]),...(obs.windows.some(w=>w.reset.kind!=='absolute')?['reset_not_exact']:[])]};
    }
    return {...denied([...new Set(tried.flatMap(t=>t.reasons))]),candidates:tried};
  });
  return freeze({schema:2,kind:'advisory-selection',dryRun:true,now:new Date(nowMs).toISOString(),executePermitted:false,dispatchAuthorized:false,decisions,rejected,summary:{selectedForReview:decisions.filter(d=>d.status==='selected-for-review').length,blocked:decisions.filter(d=>d.status==='blocked').length}});
}

export function exportStrictSnapshotPreview(document,provider,routingPolicy,selectionPolicy,{now}={}) {
  const nowMs=typeof now==='number'?now:parseInstant(now,'explicit_now_required');
  if(!Number.isFinite(nowMs))fail('explicit_now_required');
  const policy=validateSelectionPolicy(selectionPolicy,routingPolicy),{index,rejected}=reviewedIndex(document,policy,nowMs),entry=index.get(provider);
  const blocked=reason=>freeze({schema:2,kind:'strict-export-preview',exported:false,dispatchAuthorized:false,reasons:[reason]});
  if(rejected.length)return blocked('observation_document_has_rejections');
  if(!entry?.value)return blocked(entry?.reason??'unsupported_or_unobserved_provider');
  const o=entry.value;
  if(policy.routing.providers.find(p=>p.provider===provider).maxAgeSeconds>policy.maxObservationAgeSeconds)return blocked('routing_age_exceeds_reviewed_observation_age');
  if(o.windows.some(w=>w.reset.kind!=='absolute'))return blocked('reset_not_exact');
  const snapshot=normalizeSnapshot({schema:1,source:'manual',reviewed:true,provider:o.provider,accountScope:o.accountScope,modelScope:o.modelScope,observedAt:o.observedAt,windows:o.windows.map(w=>({name:w.name,remainingPercent:w.remainingPercent,resetsAt:w.reset.absolute,resetTimezone:w.reset.timezone}))});
  return freeze({schema:2,kind:'strict-export-preview',exported:true,dispatchAuthorized:false,snapshot,uncertainty:{backendAt:o.backendAt,backendFreshness:o.backendFreshness},warnings:['manual_review_assertion','strict_router_must_revalidate_actual_time']});
}
