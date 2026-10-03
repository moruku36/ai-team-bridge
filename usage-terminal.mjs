import {parseUsage,terminalScreen} from './official-usage.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

// A bounded action protocol for the already connected supported Windows PTY.
// The host executes actions only on the new session it created for this run.
// Raw replies enter this process over stdin and are never written to disk.
export class UsageTerminal {
  constructor(provider,{now=()=>new Date().toISOString(),maxReplies=20}={}) {
    if(!['claude','antigravity'].includes(provider))throw Error('invalid_provider');
    this.provider=provider;this.now=now;this.started=now();this.raw='';this.count=0;this.maxReplies=maxReplies;this.phase='starting';this.pages=[];
  }
  reply({output='',exited=false,canceled=false}={}) {
    if(this.phase==='done')return {action:'done',result:this.result};
    if(typeof output!=='string')throw Error('invalid_terminal_reply');
    this.raw+=output;this.count++;
    const blocked=reason=>{this.phase='done';this.result={schema:1,outcome:'blocked',reason,routerAuthorized:false};return {action:'close-own-session',result:this.result};};
    if(canceled)return blocked('collection_canceled');
    if(Buffer.byteLength(this.raw)>2097152)return blocked('output_limit');
    if(this.count>this.maxReplies||Date.parse(this.now())-Date.parse(this.started)>90000)return blocked('collection_timeout');
    if(/Do you trust|I trust this folder|Enter y\/n|Choose how|Open browser|verification code/i.test(this.raw))return blocked('interactive_approval_required');
    if(exited)return blocked('cli_exited_before_panel');
    const screen=terminalScreen(this.raw);
    if(this.phase==='starting') {
      const ready=this.provider==='claude'?/Claude Code v/.test(this.raw)&&/effort:/.test(this.raw):/Antigravity CLI/.test(this.raw)&&/for shortcuts/.test(this.raw);
      if(ready){
        if(this.provider==='claude'){this.phase='warm';return {action:'read'};}
        this.phase='usage';return {action:'write',text:'/usage\r'};
      }
    }else if(this.phase==='warm') {
      this.phase='usage';return {action:'write',text:'/usage\r'};
    }else if(this.phase==='usage') {
      const panel=this.provider==='claude'?/Current session/.test(screen):/Weekly Limit Remaining/.test(screen)&&/Five Hour Limit Remaining/.test(screen);
      if(panel){this.phase='settle';return {action:'read'};}
    }else if(this.phase==='settle') {
      this.result=parseUsage(this.raw,this.provider,{observationStartedAt:this.started,observedAt:this.now()});
      if(this.provider==='antigravity') {
        this.pages.push(this.result);
        const combined=new Map();
        for(const page of this.pages)for(const pool of page.pools){
          const existing=combined.get(pool.pool);if(!existing){combined.set(pool.pool,structuredClone(pool));continue;}
          for(const w of pool.windows){const old=existing.windows.find(x=>x.name===w.name);if(!old)existing.windows.push(w);else if(JSON.stringify(old)!==JSON.stringify(w)){old.remainingPercent=null;old.unavailable=true;old.quantitySource.value=null;}}
        }
        this.result.pools=[...combined.values()];
        if(this.pages.length<3&&/of \d+ lines/.test(screen)&&this.result.pools.length<2)return {action:'write',text:'\u001b[6~'};
        this.result.missingPools=this.result.pools.length!==2;
        this.result.blockers=this.result.blockers.filter(x=>x!=='usage-panel-incomplete');
        if(this.result.missingPools)this.result.blockers.push('usage-panel-incomplete');
        if(this.result.pools.some(p=>p.windows.some(w=>w.unavailable))&&!this.result.blockers.includes('quota-unavailable'))this.result.blockers.push('quota-unavailable');
        if(this.result.pools.some(p=>p.windows.some(w=>w.reset.kind!=='absolute'))&&!this.result.blockers.includes('absolute-reset-incomplete'))this.result.blockers.push('absolute-reset-incomplete');
      }
      this.phase='done';
      return {action:'exit-own-session',texts:['\u001b','/exit\r'],result:this.result};
    }
    return {action:'read'};
  }
}

// Short framed lines survive terminal wrapping without corrupting large JSON.
// Frames contain allowlisted observations/actions only, never raw CLI replies.
export function encodeAction(out) {
  const encoded=Buffer.from(JSON.stringify(out),'utf8').toString('base64');
  return 'USAGE_ACTION_BEGIN\n'+encoded.match(/.{1,64}/g).join('\n')+'\nUSAGE_ACTION_END\n';
}
export function decodeAction(output) {
  const plain=output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-9;?<>!]*[ -\/]*[@-~]/g,'');
  const matches=[...plain.matchAll(/USAGE_ACTION_BEGIN\s*([A-Za-z0-9+/=\s]+?)\s*USAGE_ACTION_END/g)];
  if(!matches.length)throw Error('action_frame_missing');
  return JSON.parse(Buffer.from(matches.at(-1)[1].replace(/\s/g,''),'base64').toString('utf8'));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [flag,provider]=process.argv.slice(2);if(flag!=='--provider'||process.argv.length!==4)throw Error();
    const protocol=new UsageTerminal(provider);
    if(process.stdin.isTTY)process.stdin.setRawMode(true); // Never echo raw provider replies.
    process.stdout.write(encodeAction({action:'start-approved-pty',provider,maximumDurationSeconds:90,trustAcceptance:false,login:false,modelPrompts:false,rawInputEchoDisabled:process.stdin.isTTY===true}));
    const input=createInterface({input:process.stdin,terminal:false});
    const timer=setTimeout(()=>{
      process.stdout.write(encodeAction({action:'close-own-session',result:{schema:1,outcome:'blocked',reason:'collection_timeout',routerAuthorized:false}}));
      input.close();process.stdin.pause();
    },90000);
    for await(const line of input) {
      let out;try{out=protocol.reply(JSON.parse(line));}catch{out={action:'close-own-session',result:{schema:1,outcome:'blocked',reason:'invalid_terminal_reply',routerAuthorized:false}};}
      process.stdout.write(encodeAction(out));if(out.result){input.close();process.stdin.pause();break;}
    }
    clearTimeout(timer);
  }catch{console.log(JSON.stringify({action:'done',result:{schema:1,outcome:'blocked',reason:'invalid_collection_request',routerAuthorized:false}}));process.exitCode=2;}
}
