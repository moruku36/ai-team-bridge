import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const MANIFEST='SOURCE-MANIFEST.json';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const byName=(a,b)=>a.toLowerCase()<b.toLowerCase()?-1:a.toLowerCase()>b.toLowerCase()?1:0;

// Tracked files from git, excluding the manifest itself. Returns null when git is unavailable.
export function trackedFiles(root) {
  try{return execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).split('\0').filter(f=>f&&f!==MANIFEST).sort(byName);}
  catch{return null;}
}

export async function hashFiles(root,files) {
  const out={};
  for(const f of [...files].sort(byName))out[f]=createHash('sha256').update(await readFile(path.join(root,f))).digest('hex');
  return out;
}

export async function buildManifest(root,files) {
  const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  return {version,algorithm:'SHA-256',files:await hashFiles(root,files)};
}

// Returns a list of problems; empty means the manifest matches the working tree.
export async function checkManifest(root,files=trackedFiles(root)) {
  const m=JSON.parse(await readFile(path.join(root,MANIFEST),'utf8'));
  const listed=Object.keys(m.files??{});
  const problems=[];
  const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  if(m.version!==version)problems.push(`version: manifest ${m.version}, package.json ${version}`);
  if(m.algorithm!=='SHA-256')problems.push('algorithm: expected SHA-256');
  if(files){
    for(const f of files)if(!listed.includes(f))problems.push(`unlisted: ${f}`);
    for(const f of listed)if(!files.includes(f))problems.push(`not tracked: ${f}`);
  }
  for(const f of listed) {
    let h;try{h=(await hashFiles(root,[f]))[f];}catch{problems.push(`missing: ${f}`);continue;}
    if(h!==m.files[f])problems.push(`hash mismatch: ${f}`);
  }
  return problems;
}

async function main([cmd]) {
  if(cmd==='update') {
    const files=trackedFiles(repo);
    if(!files)throw Error('git is required to list tracked files.');
    await writeFile(path.join(repo,MANIFEST),JSON.stringify(await buildManifest(repo,files),null,2)+'\n');
    console.log(`Updated ${MANIFEST} (${files.length} files).`);return;
  }
  if(cmd!=='check')throw Error('Usage: node scripts/source-manifest.mjs check | update');
  const problems=await checkManifest(repo);
  if(problems.length){console.error(problems.join('\n')+`\n${MANIFEST} is out of date. Run npm run manifest:update after reviewing the changes.`);process.exitCode=1;return;}
  console.log(`${MANIFEST} matches the tracked files.`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
}
