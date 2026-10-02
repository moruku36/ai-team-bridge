import {collectOfficialUsage} from './official-usage.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export async function run(argv,{write=x=>process.stdout.write(x),collector=collectOfficialUsage}={}) {
  try {
    const o={};for(let i=0;i<argv.length;i++){
      const k=argv[i];if(k==='--confirm-display-only'){if(o.confirmDisplayOnly)throw Error();o.confirmDisplayOnly=true;}
      else if(['--provider','--workspace','--timeout-seconds'].includes(k)&&argv[i+1]&&!argv[i+1].startsWith('--')){if(o[k]!==undefined)throw Error();o[k]=argv[++i];}else throw Error();
    }
    if(!o.confirmDisplayOnly||!o['--provider']||!o['--workspace'])throw Error();
    const result=await collector(o['--provider'],o['--workspace'],{confirmDisplayOnly:true,timeoutSeconds:o['--timeout-seconds']===undefined?40:Number(o['--timeout-seconds'])});
    write(JSON.stringify(result,null,2)+'\n');return result.missingPools?2:0;
  }catch{write(JSON.stringify({schema:1,outcome:'blocked',reason:'usage_collection_unavailable',routerAuthorized:false})+'\n');return 2;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await run(process.argv.slice(2));
