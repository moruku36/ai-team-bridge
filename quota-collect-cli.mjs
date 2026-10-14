import {pathToFileURL} from 'node:url';
import {acquireQuota} from './windows-quota-collector.mjs';

export async function main(args=process.argv.slice(2)) {
  if(args.length!==2 || !['claude','antigravity'].includes(args[0])) {
    process.stderr.write('Usage: node quota-collect-cli.mjs <claude|antigravity> <absolute-existing-executable.exe>\n');
    process.exitCode=2; return;
  }
  const result=await acquireQuota(args[0],{executable:args[1]});
  process.stdout.write(JSON.stringify(result)+'\n');
  if(result.status==='unknown') process.exitCode=1;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
