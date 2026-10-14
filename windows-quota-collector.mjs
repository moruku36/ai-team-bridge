import {execFile} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ALIAS, parseInstant} from './quota-snapshots.mjs';

const TTL = 3600000;
const duration = {five_hour:300, weekly:10080};
const instant = value => {try {const v=typeof value==='string'?value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/,'$1'):value; parseInstant(v); return new Date(v).toISOString();} catch {return null;}};
const percent = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const unknown = (period, reason='not_reported') => ({period, status:reason, remainingPercent:null, resetsAt:null});
function window(period, remaining, reset, now, measuredAt) {
  const resetsAt = instant(reset), age = now - Date.parse(measuredAt);
  if (!percent(remaining)) return unknown(period, 'invalid_percentage');
  if (!resetsAt) return unknown(period, 'reset_not_provided');
  if (age < 0 || age > TTL) return unknown(period, 'stale');
  const delta = Date.parse(resetsAt) - now;
  if (delta <= 0) return unknown(period, 'reset_passed');
  if (delta > duration[period]*60000+300000) return unknown(period, 'invalid_reset');
  return {period, status:'available', remainingPercent:Math.round(remaining*1e8)/1e8, resetsAt};
}

// Raw output stays in memory. Only fixed names, times and numeric quota fields escape.
export function parseQuota(provider, raw, {collectedAt, startedAt=collectedAt}={}) {
  const collected = instant(collectedAt), started = instant(startedAt);
  if (!collected || !started || Date.parse(started)>Date.parse(collected)) throw Error('invalid_collection_time');
  const report = {schema:1, provider, source:provider==='claude'?'win-codexbar-oauth':'agy-native-usage',
    startedAt:started, collectedAt:collected, providerObservedAt:null, timeBasis:'collection',
    staleAfterSeconds:3600, status:'unknown', error:null, pools:[], routerAuthorized:false};
  const now = Date.parse(collected);
  if (provider==='claude') {
    const rows = Array.isArray(raw)?raw.filter(r=>r?.provider==='claude'):[];
    if (rows.length!==1 || rows[0].error || rows[0].errorKind || !rows[0].usage) throw Error('invalid_output');
    const usage=rows[0].usage, observed=instant(usage.updated_at);
    report.providerObservedAt=observed; report.timeBasis='provider-observation';
    const windows=[];
    for (const period of Object.keys(duration)) {
      const matches=['primary','secondary','tertiary'].map(k=>usage[k]).filter(w=>w && w.is_informational!==true && w.window_minutes===duration[period]);
      windows.push(matches.length!==1 ? unknown(period,matches.length?'ambiguous':'not_reported') :
        !observed ? unknown(period,'observation_not_provided') :
        window(period,percent(matches[0].used_percent)?100-matches[0].used_percent:null,matches[0].resets_at,now,observed));
    }
    report.pools.push({scope:'native-all-models', windows});
  } else if (provider==='antigravity') {
    if (raw?.status!=='SUCCESS' || raw.command?.name!=='usage' || raw.num_turns!==0 || !Array.isArray(raw.command.data?.groups) || raw.command.data.groups.length>32) throw Error('invalid_output');
    const pools=new Map();
    for (const g of raw.command.data.groups) {
      const label=[g?.displayName,g?.display_name,g?.name].filter(v=>typeof v==='string').join(' ').toLowerCase();
      const gemini=/gemini/.test(label), claude=/claude|gpt/.test(label);
      if (gemini===claude || !Array.isArray(g.buckets) || g.buckets.length>64) throw Error('unknown_shared_pool');
      const scope=gemini?'gemini-shared':'claude-gpt-shared';
      if (pools.has(scope)) throw Error('ambiguous_shared_pool');
      const windows=[];
      for (const period of Object.keys(duration)) {
        const matches=g.buckets.filter(b=>{
          const label=b?.window ?? b?.bucketId ?? b?.bucket_id ?? b?.id;
          return typeof label==='string' && (period==='weekly'?/(?:^|[-_ ])(?:weekly|7d)$/:/(?:^|[-_ ])(?:5h|five[-_ ]hour|session|hourly)$/).test(label.toLowerCase());
        });
        if (matches.length!==1) {windows.push(unknown(period,matches.length?'ambiguous':'not_reported')); continue;}
        const b=matches[0], nested=b.remaining;
        const f=b.remainingFraction ?? b.remaining_fraction ?? nested?.remainingFraction ?? nested?.remaining_fraction ?? (nested?.case==='remainingFraction'?nested.value:null);
        windows.push(b.disabled===true ? unknown(period,'disabled') : window(period,typeof f==='number'?f*100:null,b.resetTime??b.reset_time,now,collected));
      }
      pools.set(scope,{scope,windows});
    }
    for (const scope of ['gemini-shared','claude-gpt-shared']) report.pools.push(pools.get(scope)??{scope,windows:Object.keys(duration).map(p=>unknown(p))});
  } else throw Error('invalid_provider');
  const states=report.pools.flatMap(p=>p.windows).map(w=>w.status);
  report.status=states.every(s=>s==='available')?'available':states.includes('available')?'partial':'unknown';
  return report;
}

export const COMMANDS = Object.freeze({
  claude: Object.freeze(['usage','--provider','claude','--source','oauth','--json','--no-color','--no-credits','--web-timeout','30']),
  antigravity: Object.freeze(['--print','/usage','--output-format','json','--print-timeout','45s','--log-file','NUL'])
});
export function runBounded(executable,args,{timeoutMs=50000,signal}={}) {
  return new Promise((resolve,reject)=>execFile(executable,args,{cwd:tmpdir(),windowsHide:true,shell:false,
    encoding:'utf8',timeout:timeoutMs,maxBuffer:1048576,signal},(error,stdout)=>{
    // Never return raw stderr or errors (they can contain account data and paths).
    if(error) return reject(Error(error.code==='ENOENT'?'executable_not_found':error.name==='AbortError'?'canceled':error.killed?'timeout':'cli_failed'));
    resolve(stdout);
  }));
}
const credentialOverrides=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN',
  'ANTIGRAVITY_OAUTH_CREDENTIALS_JSON','GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_APPLICATION_CREDENTIALS'];
export async function acquireQuota(provider,{executable,signal,runner=runBounded,platform=process.platform,env=process.env,clock=()=>new Date().toISOString()}={}) {
  const startedAt=clock(); let stage='preflight';
  try {
    if (!COMMANDS[provider]) throw Error('invalid_provider');
    if (platform!=='win32') throw Error('windows_required');
    if (typeof executable!=='string' || !path.win32.isAbsolute(executable) || !/\.exe$/i.test(executable)) throw Error('absolute_executable_required');
    if (credentialOverrides.some(k=>Object.hasOwn(env,k))) throw Error('credential_override_present');
    if(signal?.aborted) throw Error('canceled');
    stage='version';
    const version=(await runner(executable,['--version'],{timeoutMs:5000,signal})).trim();
    const expected=provider==='claude'?'0.70.0':'1.3.5';
    if (!new RegExp('^(?:v|(?:Win-)?CodexBar(?: CLI)? )?'+expected.replaceAll('.','\\.')+'$','i').test(version)) throw Error('unsupported_version');
    if(provider==='claude') {
      stage='consent';
      const consent=JSON.parse(await runner(executable,['config','claude-code-credentials','status','--json','--no-color'],{timeoutMs:5000,signal}));
      if (consent?.allowed!==true) throw Error('existing_consent_required');
    }
    stage='quota'; const raw=await runner(executable,[...COMMANDS[provider]],{timeoutMs:50000,signal});
    stage='parse'; return parseQuota(provider,JSON.parse(raw),{startedAt,collectedAt:clock()});
  } catch(e) {
    const allowed=['invalid_provider','windows_required','absolute_executable_required','credential_override_present','unsupported_version','existing_consent_required','executable_not_found','timeout','canceled','cli_failed','invalid_output','unknown_shared_pool','ambiguous_shared_pool'];
    return {schema:1,provider:['claude','antigravity'].includes(provider)?provider:'unknown',status:'unknown',stage,
      error:allowed.includes(e?.message)?e.message:'invalid_output',startedAt,collectedAt:null,attemptFinishedAt:clock(),
      providerObservedAt:null,pools:[],routerAuthorized:false};
  }
}

// Fits collectSnapshots() without weakening its provenance or exact-reset boundary.
// The caller explicitly reviews the CLI account and shared-pool applicability.
export function createQuotaCollector(report,{accountScope,scopeVerified=false,allowCollectionTime=false,now=Date.now()}={}) {
  if (!ALIAS.test(accountScope??'') || scopeVerified!==true) throw Error('scope_review_required');
  const measuredAt=report.providerObservedAt ?? (allowCollectionTime===true?report.collectedAt:null);
  const ms=Date.parse(measuredAt);
  if (!instant(measuredAt) || ms>now || now-ms>TTL || !['available','partial'].includes(report.status)) throw Error('fresh_observation_required');
  if (!['claude','antigravity'].includes(report.provider)) throw Error('invalid_provider');
  return {id:'windows-quota-cli',source:'supported-export',async collect({signal}={}) {
    if(signal?.aborted) throw Error('canceled');
    // Re-evaluate freshness at consumption, including snapshots held in memory.
    const current=Math.max(now,Date.now());
    if(current-ms>TTL) return [];
    return report.pools.filter(p=>p.windows.length===2 && p.windows.every(w=>w.status==='available' && Date.parse(w.resetsAt)>current)).map(p=>({
      schema:1,source:'supported-export',provenance:{adapter:'windows-quota-cli',scopeVerified:true},provider:report.provider,
      accountScope,modelScope:p.scope,observedAt:measuredAt,windows:p.windows.map(w=>({name:w.period,remainingPercent:w.remainingPercent,resetsAt:w.resetsAt,resetTimezone:'UTC'}))
    }));
  }};
}
