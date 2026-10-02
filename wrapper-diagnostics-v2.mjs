import {readFile,writeFile,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validate,plan,execute,runProcess,subscriptionPreflight,statusMetadata,capturedResult} from './wrapper.mjs';
import {diagnosticEnvelope} from './failure-diagnostics.mjs';

const base=path.dirname(fileURLToPath(import.meta.url));

export async function executeWithDiagnostics(input,root=path.join(base,'data'),options={}) {
  const r=validate(input);let outcome;
  const underlying=options.runner??runProcess;
  const runner=async(...args)=>{outcome=await underlying(...args);return outcome;};
  // Core still owns atomic reservation, private-folder setup, timeout, and status.
  const result=await execute(r,root,{...options,runner});
  if(!r.captureResult||r.route!=='local'||!outcome||['executed','verified'].includes(result.state))return result;
  const dir=path.join(root,'requests',r.id);
  const file=path.join(dir,'failure-diagnostics.json');
  const body=JSON.stringify(diagnosticEnvelope(outcome,result),null,2);
  try {
    // Core privacy check already succeeded before any generation; do not alter it again.
    await writeFile(file,body,{encoding:'utf8',flag:'wx',mode:0o600});
    return {...result,privateDiagnosticsCaptured:true,diagnosticFile:file,diagnosticSha256:createHash('sha256').update(body).digest('hex')};
  }catch{return {...result,privateDiagnosticsCaptured:false};}
}

async function main(args) {
  if(args.length!==2||!['send','status','read-result'].includes(args[0]))throw Error('Invalid command');
  if(args[0]!=='send') {
    if(!/^[0-9a-f-]{36}$/i.test(args[1]))throw Error('Invalid request ID');
    const v=JSON.parse(await readFile(path.join(base,'data','requests',args[1],args[0]==='status'?'status.json':'result.json'),'utf8'));
    console.log(JSON.stringify(args[0]==='status'?statusMetadata(v,args[1]):capturedResult(v,args[1]),null,2));return;
  }
  const r=validate(JSON.parse(await readFile(path.resolve(args[1]),'utf8')));
  await access(plan(r,base).exe,constants.F_OK);
  const controller=new AbortController();const cancel=()=>controller.abort();process.once('SIGINT',cancel);
  try {
    await subscriptionPreflight(r,plan(r,base),{signal:controller.signal});
    if(controller.signal.aborted)throw Error('Canceled before submission');
    const out=await executeWithDiagnostics(r,undefined,{signal:controller.signal});console.log(JSON.stringify(out,null,2));
    if(['unknown','rejected'].includes(out.state)||(r.captureResult&&!out.resultCaptured)||out.captureFailure)process.exitCode=2;
  } finally {process.removeListener('SIGINT',cancel);}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(()=>{
  console.error('Request not sent or not confirmed. Check request validation, existing login, and local status. Raw errors are suppressed.');process.exitCode=1;
});
