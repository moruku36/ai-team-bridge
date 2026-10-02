import {readFile} from 'node:fs/promises';

export class ValidationError extends Error{constructor(code){super(code);this.name='ValidationError';this.code=code;}}
export const fail=code=>{throw new ValidationError(code);};
export const SOURCES=['manual','mock','supported-export'];
export const PROVIDERS=['claude','antigravity','codex'];
export const ALIAS=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MODEL=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const NAME=/^[a-z0-9][a-z0-9._-]{0,39}$/;
const TS=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
// Strict allowlists: anything else (emails, account ids, billing, raw errors) is dropped, never retained.
const TOP=new Set(['schema','source','reviewed','provenance','provider','accountScope','modelScope','observedAt','windows']);
const WIN=new Set(['name','remainingPercent','resetsAt','resetTimezone']);
const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const pick=(o,allowed)=>Object.fromEntries(Object.entries(o).filter(([k])=>allowed.has(k)));

export function canonicalJson(v) {
  if(Array.isArray(v))return `[${v.map(canonicalJson).join(',')}]`;
  if(isObj(v))return `{${Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const poolKey=(provider,accountScope,modelScope)=>JSON.stringify([provider,accountScope,modelScope]);

// ISO-8601 with an explicit Z/offset only. Returns epoch milliseconds.
export function parseInstant(s,code='invalid_timestamp') {
  const m=typeof s==='string'?TS.exec(s):null;
  if(!m)fail(code);
  const [y,mo,d,h,mi,se]=m.slice(1,7).map(Number);
  if(y<2000||mo<1||mo>12||d<1||d>new Date(Date.UTC(y,mo,0)).getUTCDate()||h>23||mi>59||se>59||(m[7]&&(Number(m[8])>23||Number(m[9])>59)))fail(code);
  const ms=Date.parse(s);
  return Number.isFinite(ms)?ms:fail(code);
}

const offsetMinutes=s=>{const m=TS.exec(s);return m[7]===undefined?0:(m[7]==='-'?-1:1)*(Number(m[8])*60+Number(m[9]));};

function validZone(z) {
  if(typeof z!=='string'||!(z==='UTC'||/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(z)))return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:z});return true;}catch{return false;}
}

function zoneOffset(ms,zone) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'}).formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
  return Math.round((Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(ms/1000)*1000)/60000);
}

function normalizeWindow(raw,observedAtMs) {
  if(!isObj(raw))fail('invalid_window');
  const w=pick(raw,WIN);
  if(typeof w.name!=='string'||!NAME.test(w.name))fail('invalid_window_name');
  if(typeof w.remainingPercent!=='number'||!Number.isFinite(w.remainingPercent)||w.remainingPercent<0||w.remainingPercent>100)fail('invalid_remaining_percent');
  const resetsAtMs=parseInstant(w.resetsAt,'invalid_reset');
  if(resetsAtMs<=observedAtMs)fail('reset_not_after_observation');
  if(!validZone(w.resetTimezone))fail('invalid_reset_timezone');
  if(zoneOffset(resetsAtMs,w.resetTimezone)!==offsetMinutes(w.resetsAt))fail('reset_offset_zone_mismatch');
  return {name:w.name,remainingPercent:w.remainingPercent,resetsAt:w.resetsAt,resetsAtMs,resetTimezone:w.resetTimezone};
}

// Pure shape validation. Freshness, expiry and scope matching are decided by the router at routing time.
export function normalizeSnapshot(raw) {
  if(!isObj(raw))fail('invalid_snapshot');
  const s=pick(raw,TOP);
  if(s.schema!==1)fail('invalid_schema');
  if(!SOURCES.includes(s.source))fail('invalid_source');
  if(!PROVIDERS.includes(s.provider))fail('invalid_provider');
  if(typeof s.accountScope!=='string'||!ALIAS.test(s.accountScope))fail('invalid_account_scope');
  if(typeof s.modelScope!=='string'||!MODEL.test(s.modelScope))fail('invalid_model_scope');
  const observedAtMs=parseInstant(s.observedAt,'invalid_observed_at');
  if(s.source==='manual'&&s.reviewed!==true)fail('manual_review_required');
  if(s.source==='supported-export') {
    const p=s.provenance;
    if(!isObj(p)||p.scopeVerified!==true||typeof p.adapter!=='string'||!NAME.test(p.adapter))fail('provenance_required');
  } else if(s.provenance!==undefined)fail('unexpected_provenance');
  if(!Array.isArray(s.windows)||!s.windows.length||s.windows.length>16)fail('invalid_windows');
  const windows=s.windows.map(w=>normalizeWindow(w,observedAtMs));
  if(new Set(windows.map(w=>w.name)).size!==windows.length)fail('duplicate_window');
  return {schema:1,source:s.source,...(s.source==='manual'?{reviewed:true}:{}),...(s.source==='supported-export'?{provenance:{adapter:s.provenance.adapter,scopeVerified:true}}:{}),
    provider:s.provider,accountScope:s.accountScope,modelScope:s.modelScope,observedAt:s.observedAt,observedAtMs,windows};
}

// A mock never authorizes real delegation; supported exports need explicit scope verification.
export const authorizesLive=s=>(s.source==='manual'&&s.reviewed===true)||(s.source==='supported-export'&&s.provenance?.scopeVerified===true);

// Collectors are injected and must identify themselves. No collector ships with this module.
export async function collectSnapshots(collector,{signal}={}) {
  if(!isObj(collector)||!SOURCES.includes(collector.source)||typeof collector.id!=='string'||!NAME.test(collector.id)||typeof collector.collect!=='function')fail('collector_unidentified');
  const raw=await collector.collect({signal});
  if(!Array.isArray(raw)||raw.length>64)fail('invalid_collector_output');
  const snapshots=[],rejected=[];
  raw.forEach((r,index)=>{
    try{const s=normalizeSnapshot(r);if(s.source!==collector.source)fail('source_mismatch');snapshots.push(s);}
    catch(e){if(!(e instanceof ValidationError))throw e;rejected.push({index,reason:e.code});}
  });
  return {collector:{id:collector.id,source:collector.source},snapshots,rejected};
}

// File import is the manual path: only manual/mock snapshots can come from a file.
export async function importSnapshotFile(file) {
  const text=await readFile(file,'utf8');
  if(text.length>262144)fail('file_too_large');
  let doc;try{doc=JSON.parse(text);}catch{fail('invalid_json');}
  if(!isObj(doc)||doc.schema!==1||!Array.isArray(doc.snapshots)||doc.snapshots.length>64)fail('invalid_snapshot_file');
  const snapshots=[],rejected=[];
  doc.snapshots.forEach((raw,index)=>{
    try{const s=normalizeSnapshot(raw);if(s.source==='supported-export')fail('source_not_importable');snapshots.push(s);}
    catch(e){if(!(e instanceof ValidationError))throw e;rejected.push({index,reason:e.code});}
  });
  return {snapshots,rejected};
}

// One pool per provider+accountScope+modelScope: native Claude, Claude inside Antigravity and Codex never merge.
// Differing duplicates mark the pool conflicting instead of picking one.
export function indexSnapshots(snapshots) {
  const pools=new Map(),providers=new Set();
  for(const raw of snapshots) {
    const s=normalizeSnapshot(raw);providers.add(s.provider);
    const k=poolKey(s.provider,s.accountScope,s.modelScope),prev=pools.get(k);
    if(!prev)pools.set(k,{snapshot:s,conflict:false});
    else if(canonicalJson(prev.snapshot)!==canonicalJson(s))prev.conflict=true;
  }
  return {pools,providers};
}
