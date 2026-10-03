import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectObservedQueue,exportStrictSnapshotPreview} from './usage-selection.mjs';
import {ValidationError} from './quota-snapshots.mjs';

export async function runSelection(args) {
  const [command,...rest]=args,flags={};
  if(!['dry-run','export-strict-preview'].includes(command))throw Error('invalid_selection_command');
  const allowed=command==='dry-run'?['--queue','--observations','--routing-policy','--selection-policy','--now']:['--provider','--observations','--routing-policy','--selection-policy','--now'];
  if(rest.length%2)throw Error('invalid_selection_arguments');
  for(let i=0;i<rest.length;i+=2){if(!allowed.includes(rest[i])||Object.hasOwn(flags,rest[i])||!rest[i+1])throw Error('invalid_selection_arguments');flags[rest[i]]=rest[i+1];}
  if(allowed.filter(f=>f!=='--now').some(f=>!flags[f]))throw Error('invalid_selection_arguments');
  const read=async flag=>{const raw=await readFile(flags[flag],'utf8');if(raw.length>262144)throw Error('selection_input_too_large');return JSON.parse(raw.replace(/^\uFEFF/,''));};
  const [document,routingPolicy,selectionPolicy]=await Promise.all(['--observations','--routing-policy','--selection-policy'].map(read));
  const now=flags['--now']??new Date().toISOString();
  return command==='dry-run'?selectObservedQueue(await read('--queue'),document,routingPolicy,selectionPolicy,{now}):exportStrictSnapshotPreview(document,flags['--provider'],routingPolicy,selectionPolicy,{now});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await runSelection(process.argv.slice(2)),null,2));}
  catch(e){console.log(JSON.stringify({schema:2,kind:'advisory-selection',dryRun:true,executePermitted:false,dispatchAuthorized:false,outcome:'blocked',reason:e instanceof ValidationError?e.code:'invalid_selection_input'}));process.exitCode=2;}
}
