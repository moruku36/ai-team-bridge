import path from 'node:path';
import {parseInstant} from './quota-snapshots.mjs';

// Render cursor-based output in memory. Raw terminal bytes may contain account
// identifiers; never log, persist or return them from the public collector.
export function terminalScreen(raw) {
  if(typeof raw!=='string'||Buffer.byteLength(raw)>2097152)throw Error('output_limit');
  const rows=Array.from({length:80},()=>[]);let r=0,c=0;
  raw=raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'');
  for(let i=0;i<raw.length;) {
    if(raw[i]==='\x1b') {
      const m=/^\x1b\[([0-9;?<>!]*)([ -\/]*)([@-~])/.exec(raw.slice(i));
      if(m){i+=m[0].length;const p=m[1].replace(/[?<>!]/g,'').split(';').map(v=>Number(v)||0),n=p[0]||1;
        switch(m[3]){case 'H':case 'f':r=Math.min(79,(p[0]||1)-1);c=Math.min(239,(p[1]||1)-1);break;
          case 'A':r=Math.max(0,r-n);break;case 'B':r=Math.min(79,r+n);break;case 'C':c=Math.min(239,c+n);break;case 'D':c=Math.max(0,c-n);break;
          case 'G':c=Math.min(239,n-1);break;case 'J':if(p[0]===2){rows.forEach(a=>a.length=0);}else if(!p[0]){rows[r].splice(c);for(let j=r+1;j<rows.length;j++)rows[j]=[];}break;
          case 'K':if(p[0]===2)rows[r]=[];else if(!p[0])rows[r].splice(c);else for(let j=0;j<=c;j++)rows[r][j]=' ';break;
        }continue;
      }i+=2;continue;
    }
    const ch=raw[i++];if(ch==='\r'){c=0;continue;}if(ch==='\n'){r=Math.min(79,r+1);continue;}if(ch==='\b'){c=Math.max(0,c-1);continue;}
    if(ch<' ')continue;rows[r][c++]=ch;if(c>=240){c=0;r=Math.min(79,r+1);}
  }
  return rows.map(a=>Array.from({length:a.length},(_,i)=>a[i]??' ').join('').trimEnd()).join('\n');
}
const pct=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100;

// Only classification, never infer a calendar date, reset year, timezone, or
// authoritative reset from a rounded countdown. Missing values remain unknown.
export function resetObservation(display) {
  if(typeof display!=='string')return {kind:'unknown',display:null,absolute:null,timezone:null};
  let m;
  if((m=/^Resets (\d{1,2}:\d{2}(?:am|pm)) \(([A-Za-z_]+\/[A-Za-z_]+)\)$/.exec(display)))return {kind:'time-only',display,absolute:null,timezone:m[2]};
  if((m=/^Resets ([A-Z][a-z]{2} \d{1,2}, \d{1,2}(?::\d{2})?(?:am|pm)) \(([A-Za-z_]+\/[A-Za-z_]+)\)$/.exec(display)))return {kind:'calendar-without-year',display,absolute:null,timezone:m[2]};
  if((m=/^Refreshes in (\d+)h (\d+)m$/.exec(display)))return {kind:'relative-rounded',display,relativeMinutes:Number(m[1])*60+Number(m[2]),absolute:null,timezone:null};
  if(display==='Quota available')return {kind:'available-without-reset',display,absolute:null,timezone:null};
  // Exact timestamps must already contain their offset. No display guessing.
  if((m=/^Resets (\d{4}-\d{2}-\d{2}T[^ ]+) \(([A-Za-z_]+\/[A-Za-z_]+|UTC)\)$/.exec(display))) {
    try{parseInstant(m[1]);return {kind:'absolute',display,absolute:m[1],timezone:m[2]};}catch{}
  }
  return {kind:'unknown',display:null,absolute:null,timezone:null};
}

function measure(lines,start,kind) {
  const after=lines.slice(start+1,start+7);
  const next=after.findIndex(x=>/^(Current session|Current week|Weekly Limit Remaining|Five Hour Limit Remaining|GEMINI MODELS|CLAUDE AND GPT MODELS)/.test(x));
  const block=next<0?after:after.slice(0,next);
  const percentage=block.find(x=>/%/.test(x));
  const m=percentage&&/(-?[0-9]+(?:\.[0-9]+)?)%(?:\s+used)?\s*$/.exec(percentage);
  const value=m?Number(m[1]):null;
  // A separate per-model breakdown error must not erase a valid aggregate bar.
  const unavailable=!m&&block.slice(0,2).some(x=>/rate limited|unavailable|failed|unknown/i.test(x));
  const remaining=!unavailable&&pct(value)?kind==='used'?100-value:value:null;
  const resetLine=block.find(x=>/^\s*(Resets |Refreshes in |Quota available)/.test(x));
  return {remainingPercent:remaining,quantitySource:{kind,value:remaining===null?null:value,operation:kind==='used'?'100-minus-used':'identity'},reset:resetObservation(resetLine?.trim()),unavailable:unavailable||remaining===null};
}

export function parseUsage(raw,provider,{observedAt,observationStartedAt,backendAt=null}={}) {
  parseInstant(observedAt,'invalid_observation_time');parseInstant(observationStartedAt,'invalid_observation_time');
  if(Date.parse(observedAt)<Date.parse(observationStartedAt))throw Error('invalid_observation_time');
  if(backendAt!==null)parseInstant(backendAt,'invalid_backend_time');
  if(backendAt!==null&&Date.parse(backendAt)>Date.parse(observedAt))throw Error('invalid_backend_time');
  if(!['claude','antigravity'].includes(provider))throw Error('invalid_provider');
  const screen=terminalScreen(raw),lines=screen.split('\n').map(x=>x.trim());
  const pools=[];
  if(provider==='claude') {
    const session=lines.findIndex(x=>x==='Current session'),weekly=lines.findIndex(x=>x==='Current week (all models)');
    if(session>=0||weekly>=0)pools.push({pool:'native-all-models',models:['all-models'],windows:[...(session<0?[]:[{name:'session',...measure(lines,session,'used')}]),...(weekly<0?[]:[{name:'weekly',...measure(lines,weekly,'used')}])]});
  }else {
    for(const [header,pool,models] of [['GEMINI MODELS','gemini-shared',['gemini-flash','gemini-pro']],['CLAUDE AND GPT MODELS','claude-gpt-shared',['claude-opus','claude-sonnet','gpt-oss']]]) {
      const index=lines.indexOf(header);if(index<0)continue;
      const end=lines.findIndex((x,i)=>i>index&&(x==='GEMINI MODELS'||x==='CLAUDE AND GPT MODELS'));
      const block=lines.slice(index,end<0?undefined:end),windows=[];
      for(const [label,name] of [['Weekly Limit Remaining','weekly'],['Five Hour Limit Remaining','five-hour']]){const n=block.indexOf(label);if(n>=0)windows.push({name,...measure(block,n,'remaining')});}
      pools.push({pool,models,windows});
    }
  }
  const stale=/Showing last-known usage/i.test(screen),rateLimited=/rate limited/i.test(screen);
  const out={schema:1,provider,source:'official-interactive-usage',observationStartedAt,observedAt,backendAt,pools,
    freshness:stale?'last-known':'backend-time-not-exposed',rateLimited,modelBreakdownUnavailable:/Per-model breakdown unavailable/i.test(screen),
    missingPools:pools.length===0,routerAuthorized:false,
    blockers:['reviewed-account-and-model-mapping-required',...(backendAt===null?['backend-freshness-unknown']:[]),...(stale?['last-known-data']:[]),...(pools.length===0?['usage-panel-incomplete']:[]),
      ...(pools.some(p=>p.windows.some(w=>w.reset.kind!=='absolute'))?['absolute-reset-incomplete']:[]),...(pools.some(p=>p.windows.some(w=>w.unavailable))?['quota-unavailable']:[])]};
  if(pools.some(p=>p.windows.length!==2))out.blockers.push('required-window-missing');
  // A collected panel is observation evidence, never an execution permission.
  // Mapping and normalized-snapshot review are separate; no per-model copies.
  return out;
}

export async function collectOfficialUsage(provider,workspace,{confirmDisplayOnly=false,timeoutSeconds=40,signal,runner}={}) {
  if(confirmDisplayOnly!==true)throw Error('display_confirmation_required');
  if(!['claude','antigravity'].includes(provider)||typeof workspace!=='string'||!path.isAbsolute(workspace))throw Error('invalid_collection_request');
  if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<10||timeoutSeconds>90)throw Error('invalid_timeout');
  if(signal?.aborted)throw Error('collection_canceled');
  const started=new Date().toISOString();
  // A supported connected-terminal driver is required. Never downgrade an
  // interactive /usage command into -p, which could become a model prompt.
  if(typeof runner!=='function')throw Error('terminal_driver_required');
  const run=runner;
  const raw=await run({provider,workspace,timeoutSeconds,signal});
  return parseUsage(raw,provider,{observationStartedAt:started,observedAt:new Date().toISOString()});
}
