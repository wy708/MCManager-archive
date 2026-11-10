import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,readdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
const hash=b=>createHash('sha256').update(b).digest('hex');
const next=await readFile('backup/src/managed-game.mjs'),prior=Buffer.from('known previous program');
for(const scenario of ['stale','missing','backslash','already-patched','unknown-program','invalid-manifest']){
 const root=await mkdtemp(path.join(os.tmpdir(),'mcm-patch-'));
 try{
  for(const sub of ['host/src','config','startup-fix'])await mkdir(path.join(root,sub),{recursive:true});
  await copyFile('scripts/windows-package/fix-startup-wait.mjs',path.join(root,'fix-startup-wait.mjs'));
  await writeFile(path.join(root,'03-start.cmd'),'');
  await writeFile(path.join(root,'config/host.json'),JSON.stringify({root}));
  await writeFile(path.join(root,'host/src/processes.mjs'),'export async function assertServerStopped() {}');
  await writeFile(path.join(root,'host/src/host-config.mjs'),'export async function acquireHostLock() {return {close:async()=>{}}}');
  const current=scenario==='already-patched'?next:scenario==='unknown-program'?Buffer.from('unrecognized customization'):prior;
  const target=path.join(root,'host/src/managed-game.mjs');await writeFile(target,current);
  await writeFile(path.join(root,'startup-fix/managed-game.mjs'),next);
  await writeFile(path.join(root,'startup-fix/patch.json'),JSON.stringify({before:hash(prior),after:hash(next)}));
  const key=scenario==='backslash'?'host\\src\\managed-game.mjs':'host/src/managed-game.mjs';
  const manifest={'untouched.txt':'b'.repeat(64),...(scenario==='missing'?{}:{[key]:'a'.repeat(64)})};
  const manifestText=JSON.stringify(scenario==='invalid-manifest'?[]:manifest),manifestPath=path.join(root,'SHA256.json');await writeFile(manifestPath,manifestText);
  const run=()=>execFileSync(process.execPath,[path.join(root,'fix-startup-wait.mjs')],{stdio:'pipe'});
  if(['unknown-program','invalid-manifest'].includes(scenario)){
   assert.throws(run);assert.deepEqual(await readFile(target),current);assert.equal(await readFile(manifestPath,'utf8'),manifestText);
  }else{
   run();assert.deepEqual(await readFile(target),next);
   const actual=JSON.parse(await readFile(manifestPath,'utf8'));assert.equal(actual[key],hash(next));assert.equal(actual['untouched.txt'],manifest['untouched.txt']);
   const backups=(await readdir(root)).filter(p=>p.startsWith('startup-fix-backup-'));assert.equal(backups.length,1);
   assert.deepEqual(await readFile(path.join(root,backups[0],'managed-game.mjs')),current);assert.equal(await readFile(path.join(root,backups[0],'SHA256.json'),'utf8'),manifestText);
   run();assert.equal((await readdir(root)).filter(p=>p.startsWith('startup-fix-backup-')).length,1);
  }
 }finally{await rm(root,{recursive:true,force:true});}
}
console.log('Startup patch: stale/missing/Windows-path checksums, partial repair, repeat application and refusal of unknown programs verified');
