import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {importSnapshotFile,ValidationError} from './quota-snapshots.mjs';
import {routeQueue,dispatchTask} from './task-router.mjs';

const USAGE='Usage: node router-cli.mjs [dry-run] --queue Q.json --snapshots S.json --policy P.json [--now ISO-WITH-OFFSET] | execute --queue Q.json --snapshots S.json --policy P.json --task UUID --confirm-execute';

async function readJson(file) {
  const text=await readFile(path.resolve(file),'utf8');
  if(text.length>1048576)throw new ValidationError('file_too_large');
  try{return JSON.parse(text);}catch{throw new ValidationError('invalid_json');}
}

// Dry run is the default. `execute` runs exactly one named task, uses the real clock and accepts no --now.
export async function run(argv,{write=s=>process.stdout.write(s),writeErr=s=>process.stderr.write(s),deps={}}={}) {
  try {
    const {values,positionals}=parseArgs({args:argv,allowPositionals:true,strict:true,options:{queue:{type:'string'},snapshots:{type:'string'},policy:{type:'string'},now:{type:'string'},task:{type:'string'},'confirm-execute':{type:'boolean'}}});
    const cmd=positionals[0]??'dry-run',exec=cmd==='execute';
    if(positionals.length>1||!['dry-run','execute'].includes(cmd)||!values.queue||!values.snapshots||!values.policy)throw new ValidationError('usage');
    if(exec?values.now!==undefined||!values.task||values['confirm-execute']!==true:values.task!==undefined||values['confirm-execute']!==undefined)throw new ValidationError('usage');
    const [queue,policy,imported]=await Promise.all([readJson(values.queue),readJson(values.policy),importSnapshotFile(path.resolve(values.snapshots))]);
    const snapshotImport={accepted:imported.snapshots.length,rejected:imported.rejected};
    if(!exec) {
      write(JSON.stringify({...routeQueue(queue,imported.snapshots,policy,{now:values.now??new Date()}),snapshotImport,...(imported.rejected.length?{warnings:['partial_snapshot_import_cannot_authorize_live_call']}:{})},null,2)+'\n');
      return 0;
    }
    // Fail closed: a partially imported snapshot set can never authorize a live call.
    if(imported.rejected.length) {
      write(JSON.stringify({schema:1,outcome:'blocked',id:values.task,launched:false,reasons:['snapshot_import_rejected'],snapshotImport},null,2)+'\n');
      return 2;
    }
    const controller=new AbortController();const cancel=()=>controller.abort();process.once('SIGINT',cancel);
    try {
      const out=await dispatchTask(queue,imported.snapshots,policy,values.task,{...deps,signal:controller.signal});
      write(JSON.stringify({...out,snapshotImport},null,2)+'\n');
      return out.outcome==='dispatched'&&['executed','verified'].includes(out.state)&&out.resultCaptured===true&&out.captureFailure===undefined&&out.readbackIntegrityVerified===true?0:2;
    } finally {process.removeListener('SIGINT',cancel);}
  } catch(e) {
    writeErr(e instanceof ValidationError?(e.code==='usage'?USAGE:`Rejected: ${e.code}`):e?.code?.startsWith?.('ERR_PARSE_ARGS')?USAGE:'Request not sent or not confirmed. Raw errors are suppressed.');
    writeErr('\n');
    return 1;
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(code=>{process.exitCode=code;});
}
