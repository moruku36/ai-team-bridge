import test from 'node:test';
import assert from 'node:assert/strict';
import {UsageTerminal,encodeAction,decodeAction} from '../usage-terminal.mjs';
const start='Claude Code v2.1.287\r\neffort: medium\r\n$';
const panel='\x1b[2J\x1b[HCurrent session\r\n20% used\r\nResets 7:30am (Asia/Tokyo)\r\nCurrent week (all models)\r\n50% used\r\nResets Oct 3, 5am (Asia/Tokyo)';
test('protocol sends only usage once and exits its own session after settling',()=>{
 const p=new UsageTerminal('claude');assert.equal(p.reply({output:'starting'}).action,'read');
 assert.deepEqual(p.reply({output:start}),{action:'read'});
 assert.deepEqual(p.reply({output:''}),{action:'write',text:'/usage\r'});
 assert.equal(p.reply({output:panel}).action,'read');
 const final=p.reply({output:''});assert.equal(final.action,'exit-own-session');assert.deepEqual(final.texts,['\u001b','/exit\r']);
 assert.equal(final.result.pools[0].windows[0].remainingPercent,80);assert.equal(final.result.routerAuthorized,false);
 assert.equal(p.reply({output:''}).action,'done');
});
test('trust/login prompts, cancellation, exit and elapsed timeout block without acceptance',()=>{
 for(const output of ['Do you trust','I trust this folder','Open browser','verification code']){
  const p=new UsageTerminal('claude');const a=p.reply({output});assert.equal(a.action,'close-own-session');assert.equal(a.result.reason,'interactive_approval_required');
 }
 assert.equal(new UsageTerminal('claude').reply({canceled:true}).result.reason,'collection_canceled');
 assert.equal(new UsageTerminal('claude').reply({exited:true}).result.reason,'cli_exited_before_panel');
 let now='2031-04-02T12:00:00Z';const p=new UsageTerminal('claude',{now:()=>now});now='2031-04-02T12:01:31Z';assert.equal(p.reply().result.reason,'collection_timeout');
 const capped=new UsageTerminal('claude',{maxReplies:1});capped.reply();assert.equal(capped.reply().result.reason,'collection_timeout');
});
test('AGY pagination merges shared pools and never duplicates member-model budgets',()=>{
 const p=new UsageTerminal('antigravity');assert.equal(p.reply({output:'Antigravity CLI\r\n? for shortcuts'}).action,'write');
 const a='\x1b[2J\x1b[HGEMINI MODELS\r\nWeekly Limit Remaining\r\n80%\r\nRefreshes in 20h 10m\r\nFive Hour Limit Remaining\r\n100%\r\nQuota available\r\n(1–11 of 30 lines)';
 assert.equal(p.reply({output:a}).action,'read');assert.deepEqual(p.reply(),{action:'write',text:'\u001b[6~'});
 const b='\x1b[2J\x1b[HCLAUDE AND GPT MODELS\r\nWeekly Limit Remaining\r\n90%\r\nQuota available\r\nFive Hour Limit Remaining\r\n95%\r\nQuota available\r\n(12–22 of 30 lines)';
 const out=p.reply({output:b});assert.equal(out.action,'exit-own-session');assert.equal(out.result.pools.length,2);assert.equal(out.result.pools[0].windows[0].remainingPercent,80);
 assert.equal(out.result.routerAuthorized,false);
});
test('large framed results survive CRLF and terminal cursor codes',()=>{
 const out={action:'exit-own-session',result:{values:Array.from({length:80},(_,i)=>({pool:'synthetic',value:i}))}};
 const framed='\x1b[2J\x1b[H'+encodeAction(out).replaceAll('\n','\r\n');assert.deepEqual(decodeAction(framed),out);
 assert.throws(()=>decodeAction('bad frame'),/missing/);
});
