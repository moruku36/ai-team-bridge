import test from 'node:test';
import assert from 'node:assert/strict';
import {collectConnectedUsage,ownedClaudeStopCommand} from '../connected-terminal-host.mjs';
import {encodeAction} from '../usage-terminal.mjs';
const nonce='a'.repeat(32),ticks='638900000000000000';
function host({graceful=false,marker=true,matched=1,childExited=true,parentExited=true,abort=false}={}){
 const calls=[],unowned={alive:true};let stopped=false,signal={aborted:false};
 const terminal={async exec({cmd}){
   calls.push(['exec',cmd]);
   if(cmd.includes('Get-Item'))return {output:JSON.stringify({empty:true,reparse:false,launchNonce:nonce}),exit_code:0};
   if(cmd.includes('usage-preflight'))return {output:'{"ready":true}',exit_code:0};
   if(cmd.includes('usage-terminal'))return {session_id:11,output:encodeAction({action:'start-approved-pty',provider:'claude',rawInputEchoDisabled:true})};
   if(cmd.includes('Stop-Process')){stopped=matched===1&&childExited;return {output:JSON.stringify({matched,childExited}),exit_code:stopped?0:3};}
   if(abort)signal.aborted=true;
   return {session_id:22,output:marker?`USAGE_OWNER_${nonce}:4242:${ticks}\n`:''};
 },async exchange({session_id,chars}){
   calls.push([session_id,chars]);
   assert.ok([11,22].includes(session_id),'non-owned session accessed');
   if(session_id===11)return chars.includes('"output"')?{output:encodeAction({action:'close-own-session',result:{reason:'collection_timeout'}}),exit_code:0}:{output:'',exit_code:0};
   return {output:'',...((graceful&&chars==='/exit\r')||(stopped&&parentExited)?{exit_code:0}:{})};
 }};
 return {terminal,calls,unowned,signal};
}
const run=t=>collectConnectedUsage('claude',{terminal:t.terminal,workspace:'C:\\empty',sourceDirectory:'C:\\source',confirmDisplayOnly:true,confirmPreviouslyTrustedWorkspace:true,signal:t.signal});
test('panel timeout gets graceful Escape/exit and retains blocked result',async()=>{
 const t=host({graceful:true}),r=await run(t);assert.equal(r.reason,'collection_timeout');assert.equal(r.routerAuthorized,false);assert.deepEqual(t.calls.filter(([id,c])=>id===22&&c).map(([,c])=>c),['\u001b','/exit\r']);assert.ok(!t.calls.some(([,c])=>c.includes('Stop-Process')));assert.equal(t.unowned.alive,true);
});
test('hung owned child gets one strict stop, child and terminal exit both required',async()=>{
 const t=host(),r=await run(t);assert.equal(r.reason,'collection_timeout');assert.equal(r.collection.cleanup.forcedStop,true);assert.equal(r.collection.cleanup.ownedProviderExited,true);assert.equal(t.calls.filter(([id,c])=>id==='exec'&&c.includes('Stop-Process')).length,1);assert.equal(t.unowned.alive,true);assert.equal(r.pools,undefined);
});
test('child stopped but parent terminal still running remains cleanup_unconfirmed',async()=>{const r=await run(host({parentExited:false}));assert.equal(r.reason,'cleanup_unconfirmed');assert.equal(r.cleanup.ownedProviderExited,false);});
test('no unique ownership match or child exit proof can be accepted',async()=>{for(const props of [{matched:0},{childExited:false}]){const t=host(props),r=await run(t);assert.equal(r.reason,'cleanup_unconfirmed');assert.equal(t.unowned.alive,true);}});
test('missing launch marker never invokes a stop command',async()=>{const t=host({marker:false}),r=await run(t);assert.equal(r.reason,'cleanup_unconfirmed');assert.ok(!t.calls.some(([id,c])=>id==='exec'&&c.includes('Stop-Process')));});
test('cancellation after launch still cleans own child and never succeeds',async()=>{const t=host({abort:true}),r=await run(t);assert.equal(r.reason,'collection_canceled');assert.equal(r.collection.cleanup.ownedProviderExited,true);assert.equal(t.unowned.alive,true);});
test('stop script rejects injected ownership data and scopes both checks precisely',()=>{
 assert.throws(()=>ownedClaudeStopCommand({pid:4242,ticks:ticks+';bad'},nonce));assert.throws(()=>ownedClaudeStopCommand({pid:4242,ticks},'invalid'));
 const s=ownedClaudeStopCommand({pid:4242,ticks},nonce);assert.match(s,/ParentProcessId=\$ownerId/);assert.match(s,/CommandLine -ceq \$expected/);assert.match(s,/parentAgain.StartTime.ToUniversalTime\(\).Ticks -ne \$ownerTicks/);assert.match(s,/CreationDate -ne \$created/);assert.match(s,/Wait-Process -Id \$targetId -Timeout 5/);assert.doesNotMatch(s,/taskkill|Stop-Process -Name|Stop-Process.*-Force/);
});
