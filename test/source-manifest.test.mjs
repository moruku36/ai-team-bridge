import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildManifest,checkManifest} from '../scripts/source-manifest.mjs';

async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'manifest-'));
  await mkdir(path.join(root,'docs'));
  await writeFile(path.join(root,'package.json'),JSON.stringify({version:'9.9.9'}));
  await writeFile(path.join(root,'a.mjs'),'export const a=1;\n');
  await writeFile(path.join(root,'docs','B.md'),'# b\n');
  const files=['package.json','a.mjs','docs/B.md'];
  await writeFile(path.join(root,'SOURCE-MANIFEST.json'),JSON.stringify(await buildManifest(root,files),null,2));
  return {root,files};
}

test('a freshly built manifest checks clean, with case-insensitive ordering',async()=>{
  const {root,files}=await fixture();
  assert.deepEqual(await checkManifest(root,files),[]);
  const m=await buildManifest(root,files);
  assert.deepEqual(Object.keys(m.files),['a.mjs','docs/B.md','package.json']);
  assert.equal(m.version,'9.9.9');assert.equal(m.algorithm,'SHA-256');
});

test('content changes, line-ending changes and missing files are reported',async()=>{
  const {root,files}=await fixture();
  await writeFile(path.join(root,'a.mjs'),'export const a=1;\r\n');
  assert.deepEqual(await checkManifest(root,files),['hash mismatch: a.mjs']);
  await writeFile(path.join(root,'a.mjs'),'export const a=1;\n');
  assert.deepEqual(await checkManifest(root,[...files,'new.mjs']),['unlisted: new.mjs']);
  assert.deepEqual(await checkManifest(root,files.filter(f=>f!=='docs/B.md')),['not tracked: docs/B.md']);
});

test('a version bump without a manifest update is reported',async()=>{
  const {root,files}=await fixture();
  await writeFile(path.join(root,'package.json'),JSON.stringify({version:'10.0.0'}));
  const problems=await checkManifest(root,files);
  assert.ok(problems.includes('version: manifest 9.9.9, package.json 10.0.0'));
  assert.ok(problems.includes('hash mismatch: package.json'));
});
