// Portable host adapter: no Node imports, external endpoint or new credentials.
// Works with the already connected terminal's exec/exchange capabilities.
// Never log tool results: provider headers can contain account identifiers.
const PROVIDERS=['claude','antigravity'];
const absolute=v=>typeof v==='string'&&/^[A-Za-z]:[\\/]/.test(v)&&!/[\x00-\x1f]/.test(v);
const stripTerminal=s=>s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-9;?<>!]*[ -\/]*[@-~]/g,'');
export function decodeHostAction(output) {
  if(typeof output!=='string'||output.length>4194304)throw Error('invalid_frame');
  const matches=[...stripTerminal(output).matchAll(/USAGE_ACTION_BEGIN\s*([A-Za-z0-9+/=\s]+?)\s*USAGE_ACTION_END/g)];
  if(!matches.length)throw Error('invalid_frame');
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let n=0,bits=0,bytes=[];
  for(const c of matches.at(-1)[1].replace(/\s|=/g,'')){n=(n<<6)|alphabet.indexOf(c);bits+=6;if(bits>=8){bits-=8;bytes.push((n>>bits)&255);}}
  const json=decodeURIComponent(bytes.map(b=>'%'+b.toString(16).padStart(2,'0')).join(''));
  return JSON.parse(json);
}
function safeObservation(result,provider) {
  // Rebuild an allowlist at the host boundary as well. Even an unexpected
  // protocol field never reaches persisted/user-facing results.
  if(!result||result.provider!==provider||result.routerAuthorized!==false||!Array.isArray(result.pools))throw Error('invalid_observation');
  const clock=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(v)?v:null;
  const names=provider==='claude'?{'native-all-models':['all-models']}:{'gemini-shared':['gemini-flash','gemini-pro'],'claude-gpt-shared':['claude-opus','claude-sonnet','gpt-oss']};
  const resetKinds=['absolute','relative-rounded','time-only','calendar-without-year','available-without-reset','unknown'];
  const pools=result.pools.map(p=>{
    if(!Object.hasOwn(names,p.pool)||!Array.isArray(p.windows))throw Error('invalid_observation');
    return {pool:p.pool,models:names[p.pool],windows:p.windows.map(w=>{
      if(!['session','weekly','five-hour'].includes(w.name))throw Error('invalid_observation');
      const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100?v:null;
      const r=w.reset??{},q=w.quantitySource??{};
      const remaining=number(w.remainingPercent),quantity=number(q.value);
      if(remaining!==null&&(quantity===null||!((q.kind==='remaining'&&q.operation==='identity'&&remaining===quantity)||(q.kind==='used'&&q.operation==='100-minus-used'&&Math.abs(remaining-(100-quantity))<0.000001))))throw Error('invalid_observation');
      const kind=resetKinds.includes(r.kind)?r.kind:'unknown';
      // Copy accepted display syntax only; arbitrary strings/URLs never pass.
      const display=typeof r.display==='string'&&r.display.length<140&&/^(?:Resets(?: (?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*|at|\d{1,2}(?::\d{2})?(?:[AaPp][Mm])?,?|[AaPp][Mm]|\d{4}|\((?:UTC|[A-Za-z_]+(?:\/[A-Za-z_]+){1,2})\))){1,10}|Refreshes in \d+h \d+m|Quota available)$/.test(r.display)?r.display:null;
      return {name:w.name,remainingPercent:number(w.remainingPercent),quantitySource:{kind:['used','remaining'].includes(q.kind)?q.kind:'unknown',value:number(q.value),operation:['identity','100-minus-used'].includes(q.operation)?q.operation:'unknown'},
        reset:{kind,display,absolute:clock(r.absolute),timezone:typeof r.timezone==='string'&&/^(UTC|[A-Za-z_]+\/[A-Za-z_]+)$/.test(r.timezone)?r.timezone:null,...(Number.isSafeInteger(r.relativeMinutes)&&r.relativeMinutes>=0?{relativeMinutes:r.relativeMinutes}:{})},unavailable:w.unavailable===true||number(w.remainingPercent)===null};
    })};
  });
  if(new Set(pools.map(p=>p.pool)).size!==pools.length)throw Error('invalid_observation');
  for(const p of pools)if(new Set(p.windows.map(w=>w.name)).size!==p.windows.length)throw Error('invalid_observation');
  const codes=['reviewed-account-and-model-mapping-required','backend-freshness-unknown','last-known-data','usage-panel-incomplete','absolute-reset-incomplete','quota-unavailable','required-window-missing'];
  return {schema:1,provider,source:'official-interactive-usage',observationStartedAt:clock(result.observationStartedAt),observedAt:clock(result.observedAt),backendAt:clock(result.backendAt),pools,
    freshness:result.freshness==='last-known'?'last-known':'backend-time-not-exposed',rateLimited:result.rateLimited===true,modelBreakdownUnavailable:result.modelBreakdownUnavailable===true,missingPools:result.missingPools===true,
    routerAuthorized:false,blockers:codes.filter(c=>Array.isArray(result.blockers)&&result.blockers.includes(c))};
}

export async function collectConnectedUsage(provider,{terminal,workspace,sourceDirectory,confirmDisplayOnly=false,confirmPreviouslyTrustedWorkspace=false,signal,onProgress,now=()=>Date.now(),maximumDurationSeconds=90}={}) {
  const blocked=reason=>({schema:1,outcome:'blocked',provider:PROVIDERS.includes(provider)?provider:null,reason,routerAuthorized:false});
  if(!PROVIDERS.includes(provider)||!absolute(workspace)||!absolute(sourceDirectory)||workspace.toLowerCase()===sourceDirectory.toLowerCase()||confirmDisplayOnly!==true||confirmPreviouslyTrustedWorkspace!==true||!terminal||typeof terminal.exec!=='function'||typeof terminal.exchange!=='function'||!Number.isInteger(maximumDurationSeconds)||maximumDurationSeconds<10||maximumDurationSeconds>90)return blocked('invalid_host_request');
  let cliId=null,protocolId=null,cliClosed=false,protocolClosed=false,result,usageWrites=0,pages=0,frameBuffer='';
  const auxiliary=new Map();
  const started=now();
  const progress=stage=>{try{onProgress?.({provider,stage});}catch{}};
  const expired=()=>now()-started>maximumDurationSeconds*1000;
  const exec=(cmd,workdir,tty=false,privileged=false)=>terminal.exec({cmd,workdir,tty,yield_time_ms:tty?1000:10000,max_output_tokens:7000,...(privileged?{sandbox_permissions:'require_escalated',justification:'Read the official usage display using existing subscription and previously trusted empty workspace only. No model prompt, login, new trust or security change.'}:{})});
  const exchange=(id,chars='')=>terminal.exchange({session_id:id,chars,yield_time_ms:1000,max_output_tokens:7000});
  const completedRead=async(cmd,workdir,privileged=false)=>{
    let reply=await exec(cmd,workdir,false,privileged),output=reply.output??'';
    const id=reply.session_id;
    if(id!==undefined)auxiliary.set(id,reply.exit_code!==undefined);
    for(let i=0;id!==undefined&&reply.exit_code===undefined&&i<4&&!expired()&&!signal?.aborted;i++){
      reply=await exchange(id);output+=reply.output??'';auxiliary.set(id,reply.exit_code!==undefined);
      if(output.length>2097152)throw Error('output_limit');
    }
    return {...reply,output};
  };
  const readFrame=async(initial)=>{
    let reply=initial;
    for(let i=0;i<4;i++){
      frameBuffer+=reply.output??'';
      if(reply.exit_code!==undefined)protocolClosed=true;
      try{const action=decodeHostAction(frameBuffer);frameBuffer='';return action;}catch{}
      if(protocolClosed||signal?.aborted||expired()||frameBuffer.length>4194304)break;
      reply=await exchange(protocolId);
    }
    throw Error('invalid_protocol_frame');
  };
  const closeCli=async()=>{
    if(cliId===null||cliClosed)return;
    try{const r=await exchange(cliId);cliClosed=r.exit_code!==undefined;}catch{}
    if(cliClosed)return;
    for(let i=0;i<2&&!cliClosed;i++)try{const r=await exchange(cliId,'\u0003');cliClosed=r.exit_code!==undefined;}catch{break;}
    for(let i=0;i<2&&!cliClosed;i++)try{const r=await exchange(cliId);cliClosed=r.exit_code!==undefined;}catch{break;}
  };
  const closeProtocol=async()=>{
    if(protocolId===null||protocolClosed)return;
    try{const r=await exchange(protocolId);protocolClosed=r.exit_code!==undefined;}catch{}
    if(protocolClosed)return;
    try{const r=await exchange(protocolId,JSON.stringify({canceled:true})+'\n');protocolClosed=r.exit_code!==undefined;}catch{}
    if(!protocolClosed)try{const r=await exchange(protocolId);protocolClosed=r.exit_code!==undefined;}catch{}
  };
  try {
    if(signal?.aborted)return blocked('collection_canceled');
    progress('preflight');
    const probe=await completedRead("$item=Get-Item -LiteralPath . -Force; [pscustomobject]@{empty=(@(Get-ChildItem -LiteralPath . -Force).Count -eq 0);reparse=(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)} | ConvertTo-Json -Compress",workspace);
    let verified;try{verified=JSON.parse(probe.output);}catch{throw Error('workspace_verification_failed');}
    if(probe.exit_code!==0||verified.empty!==true||verified.reparse!==false)throw Error('workspace_not_empty_or_unverified');
    const auth=await completedRead("node '"+(sourceDirectory.replace(/'/g,"''")+'\\usage-preflight.mjs')+"' --provider "+provider,workspace,true);
    let ready=false;try{ready=auth.exit_code===0&&JSON.parse(auth.output).ready===true;}catch{}
    if(!ready)throw Error('existing_subscription_unavailable');
    if(signal?.aborted)throw Error('collection_canceled');if(expired())throw Error('collection_timeout');
    const protocol=await exec('node .\\usage-terminal.mjs --provider '+provider,sourceDirectory,true);
    if(protocol.session_id===undefined)throw Error('protocol_start_failed');protocolId=protocol.session_id;
    const first=await readFrame(protocol);
    if(first.action!=='start-approved-pty'||first.provider!==provider||first.rawInputEchoDisabled!==true)throw Error('protocol_start_failed');
    progress('starting');
    const command=provider==='claude'?"& (Join-Path $env:USERPROFILE '.local\\bin\\claude.exe') --safe-mode --tools '' --strict-mcp-config --model sonnet --ax-screen-reader":"& (Join-Path $env:USERPROFILE 'AppData\\Local\\agy\\bin\\agy.exe') --model gemini-3.8-flash-medium --mode plan --sandbox";
    let chunk=await exec(command,workspace,true,true);
    if(chunk.session_id===undefined)throw Error('provider_start_failed');cliId=chunk.session_id;cliClosed=chunk.exit_code!==undefined;
    for(let i=0;i<20;i++) {
      if(signal?.aborted)throw Error('collection_canceled');if(expired())throw Error('collection_timeout');
      const response=await exchange(protocolId,JSON.stringify({output:chunk.output??'',exited:chunk.exit_code!==undefined})+'\n');
      const action=await readFrame(response);
      if(action.action==='write') {
        if(action.text==='/usage\r'&&usageWrites++===0){progress('usage');}
        else if(action.text==='\u001b[6~'&&usageWrites===1&&pages++<2){progress('page');}
        else throw Error('invalid_protocol_action');
        chunk=await exchange(cliId,action.text);cliClosed=chunk.exit_code!==undefined;
      }else if(action.action==='read'){chunk=await exchange(cliId);cliClosed=chunk.exit_code!==undefined;}
      else if(action.action==='exit-own-session') {
        if(usageWrites!==1||JSON.stringify(action.texts)!==JSON.stringify(['\u001b','/exit\r']))throw Error('invalid_protocol_action');
        result=safeObservation(action.result,provider);progress('closing');
        for(const text of action.texts){const r=await exchange(cliId,text);cliClosed=r.exit_code!==undefined;if(cliClosed)break;}
        break;
      }else if(action.action==='close-own-session'||action.action==='done') {
        const reasons=['collection_canceled','collection_timeout','interactive_approval_required','output_limit','cli_exited_before_panel','invalid_terminal_reply'];
        throw Error(reasons.includes(action.result?.reason)?action.result.reason:'invalid_protocol_action');
      }else throw Error('invalid_protocol_action');
    }
    if(!result)throw Error('collection_timeout');
  }catch(error) {
    const allowed=['workspace_verification_failed','workspace_not_empty_or_unverified','existing_subscription_unavailable','protocol_start_failed','provider_start_failed','invalid_protocol_frame','invalid_protocol_action','invalid_observation','collection_canceled','collection_timeout','interactive_approval_required','output_limit','cli_exited_before_panel','invalid_terminal_reply'];
    result=blocked(allowed.includes(error?.message)?error.message:'connected_terminal_unavailable');
  }finally{
    await closeCli();await closeProtocol();
    for(const [id,closed] of auxiliary)if(!closed)try{const r=await exchange(id,'\u0003');auxiliary.set(id,r.exit_code!==undefined);}catch{}
  }
  const cleanup={ownedProviderExited:cliId===null||cliClosed,ownedProtocolExited:protocolId===null||protocolClosed,ownedPreflightExited:[...auxiliary.values()].every(Boolean)};
  if(Object.values(cleanup).some(v=>!v))return {...blocked('cleanup_unconfirmed'),cleanup};
  progress('done');
  return {...result,collection:{host:'connected-terminal',singleRun:true,usageCommands:usageWrites,pageCommands:pages,modelPrompts:0,cleanup}};
}
