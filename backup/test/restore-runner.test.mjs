import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStoppedBackup, inspectBackup, restoreBackup, verifyRestoredDirectory } from '../src/archive.mjs';
import { RestoreRunner } from '../src/restore-runner.mjs';
import { HostApiError } from '../src/host-api.mjs';
import { HostStore } from '../src/host-store.mjs';
import { readHostConfig } from '../src/host-config.mjs';
import { canonicalJson, missing } from '../src/paths.mjs';

async function sandbox(action) {
  const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'mcmanager-restore-test-'))),owner=randomUUID();
  await writeFile(path.join(directory,'.owner'),owner);
  try{await action(directory);}finally{
    const actual=await realpath(directory);assert.equal(path.dirname(actual),await realpath(os.tmpdir()));assert.equal(await readFile(path.join(actual,'.owner'),'utf8'),owner);
    await rm(actual,{recursive:true,force:false,maxRetries:3,retryDelay:100});
  }
}
async function fixture(parent) {
  const serverId=randomUUID(),hostId=randomUUID(),root=path.join(parent,'source'),stateDirectory=path.join(parent,'state'),restoreDirectory=path.join(parent,'copies');
  for(const dir of [root,stateDirectory,restoreDirectory])await mkdir(dir);
  const token=serverId+'.'+'A'.repeat(43),files={
    'bedrock_server_mod.exe':'protocol fixture, not a real executable',
    'server.properties':'level-name=world\n', 'worlds/world/level.dat':'original-world',
    'worlds/world/db/CURRENT':'MANIFEST-000001\n',
    'plugins/archive-collector/config/config.json':canonicalJson({enabled:true,serverId,token,endpoint:'http://127.0.0.1:8080/api/ingest/v1/batches'}),
    'plugins/archive-collector/data/outbox/server-id':serverId,
  };
  for(const [name,data]of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),data);}
  const file=path.join(parent,'backup.tar.gz');await createStoppedBackup({root,output:file,serverId});const proof=await inspectBackup(file);
  const config={root,stateDirectory,restoreDirectory,serverId,runId:randomUUID(),maintenance:true,apiUrl:'http://127.0.0.1:8080',token:'mcmhost.'+hostId+'.'+'B'.repeat(43)};
  const job={id:randomUUID(),hostId,backupId:randomUUID(),sourceBackupId:proof.manifest.backupId,sourceServerId:serverId,targetServerId:serverId,mode:'DISABLED',destinationName:'中文恢复',archiveSha256:proof.sha256,archiveBytes:proof.archiveBytes,fileCount:proof.manifest.files.length,status:'QUEUED',cancelRequested:false};
  const attemptId=randomUUID(),calls=[],events=[];let claimed=false,failReady=false,afterDownload;
  const api={hostId,async request(route){calls.push(route);return {...job};},async post(route,body){calls.push(route);
    if(route==='/restores/claim'){if(claimed)return;claimed=true;job.status='CLAIMED';return{job:{...job},attemptId,active:true};}
    if(route.endsWith('/start')){job.status='RUNNING';return{...job};}
    if(route.endsWith('/renew'))return{...job};
    if(route.endsWith('/collector'))return{...job};
    if(route.endsWith('/report')){job.status=body.outcome;return{...job};}
    if(route.endsWith('/ready')||route.endsWith('/recover')){
      if(failReady){failReady=false;throw new HostApiError(0);}
      job.status='READY';job.restorationId=body.restorationId;return{...job,worldRuntimeVerified:false};
    }throw new Error('Unexpected route');
  },async downloadRestore(value,run,attempt,destination){calls.push('DOWNLOAD');await copyFile(file,destination);await afterDownload?.();}};
  return {config,job,file,proof,api,calls,events,token,set failReady(value){failReady=value;},set afterDownload(value){afterDownload=value;},runner:()=>new RestoreRunner(config,api,event=>events.push(event)).open()};
}

test('durable inventory verifies the original restoration nonce and every prepared world file',()=>sandbox(async parent=>{
  const f=await fixture(parent),destination=path.join(f.config.restoreDirectory,'copy'),restorationId=randomUUID();let prepared;
  const restored=await restoreBackup({file:f.file,destination,restorationId,onPrepared:value=>{prepared=value;}});
  assert.equal(restored.restorationId,restorationId);assert.equal(prepared.inventorySha256,restored.inventorySha256);
  const expected={...f.job,restorationId,...prepared};assert.equal((await verifyRestoredDirectory(destination,expected)).worldRuntimeVerified,false);
  await assert.rejects(verifyRestoredDirectory(destination,{...expected,restorationId:randomUUID()}),/receipt/);
  await writeFile(path.join(destination,'worlds/world/level.dat'),'changed-world');
  await assert.rejects(verifyRestoredDirectory(destination,expected),/changed or are incomplete/);
}));

test('abort at publication preserves the owned stage and never creates a completed destination',()=>sandbox(async parent=>{
  const f=await fixture(parent),destination=path.join(f.config.restoreDirectory,'copy'),abort=new AbortController();let prepared=false;
  await assert.rejects(restoreBackup({file:f.file,destination,signal:abort.signal,onPrepared:()=>{prepared=true;},onPhase:phase=>{if(phase==='PUBLISHING')abort.abort();}}),{name:'AbortError'});
  assert.equal(prepared,true);assert.equal(await missing(destination),true);
  const stages=(await readdir(f.config.restoreDirectory)).filter(name=>name.startsWith('.mcmanager-restore-'));assert.equal(stages.length,1);
  assert.equal(await missing(path.join(f.config.restoreDirectory,stages[0],'server/worlds/world/level.dat')),false);
}));

test('lost completion response recovers original files once; subsequent player changes do not replay restore',()=>sandbox(async parent=>{
  const f=await fixture(parent);f.failReady=true;const first=await f.runner();
  await assert.rejects(first.step(),HostApiError);assert.equal((await first.store.records())[0].phase,'RESTORED');
  const nonce=(await first.store.records())[0].restorationId;f.job.status='UNCERTAIN';f.config.runId=randomUUID();
  const reopened=await f.runner();await reopened.step();assert.equal(f.job.status,'READY');assert.equal(f.job.restorationId,nonce);
  assert.equal(f.events.filter(e=>e.phase==='EXTRACTING').length,1);assert.equal(f.calls.filter(c=>c==='DOWNLOAD').length,1);assert.equal(f.calls.filter(c=>c.endsWith('/recover')).length,1);
  await writeFile(path.join(f.config.restoreDirectory,f.job.destinationName,'worlds/world/level.dat'),'played-after-ready');
  await reopened.step();assert.equal(await readFile(path.join(f.config.restoreDirectory,f.job.destinationName,'worlds/world/level.dat'),'utf8'),'played-after-ready');
}));

test('changed completed files remain uncertain and cannot trigger another extraction or readiness',()=>sandbox(async parent=>{
  const f=await fixture(parent);f.failReady=true;const first=await f.runner();await assert.rejects(first.step());
  await writeFile(path.join(f.config.restoreDirectory,f.job.destinationName,'worlds/world/level.dat'),'external-change');
  f.job.status='UNCERTAIN';const reopened=await f.runner();await reopened.step();await reopened.step();
  assert.equal(f.job.status,'UNCERTAIN');assert.equal(f.events.filter(e=>e.phase==='EXTRACTING').length,1);assert.equal(f.calls.filter(c=>c.endsWith('/recover')).length,0);
}));

test('partial extraction journal is never replayed',()=>sandbox(async parent=>{
  const f=await fixture(parent),runner=await f.runner();
  const claim=await f.api.post('/restores/claim',{}),record=await runner.store.create(claim,f.config.runId);
  record.phase='RESTORING';await runner.store.save(record);f.job.status='RUNNING';
  await runner.step();await runner.step();assert.equal(f.job.status,'UNCERTAIN');assert.equal(f.calls.filter(c=>c==='DOWNLOAD').length,0);
}));

test('pre-existing destination is rejected before start and never overwritten',()=>sandbox(async parent=>{
  const f=await fixture(parent),destination=path.join(f.config.restoreDirectory,f.job.destinationName);await mkdir(destination);
  await writeFile(path.join(destination,'valuable-world'),'keep');const runner=await f.runner();await runner.step();
  assert.equal(f.job.status,'FAILED');assert.equal(await readFile(path.join(destination,'valuable-world'),'utf8'),'keep');
  assert.equal(f.calls.some(c=>c.endsWith('/start')||c==='DOWNLOAD'),false);
}));

test('fork registers a separate collector credential and quarantines the original archive cache',()=>sandbox(async parent=>{
  const f=await fixture(parent);f.job.mode='FORK';f.job.targetServerId=randomUUID();let proposed;
  const post=f.api.post.bind(f.api);f.api.post=async(route,body)=>{if(route.endsWith('/collector'))proposed=body.collectorToken;return post(route,body);};
  await(await f.runner()).step();assert.equal(f.job.status,'READY');assert.ok(proposed.startsWith(f.job.targetServerId+'.'));assert.notEqual(proposed,f.token);
  const destination=path.join(f.config.restoreDirectory,f.job.destinationName),config=JSON.parse(await readFile(path.join(destination,'plugins/archive-collector/config/config.json'),'utf8'));
  assert.equal(config.serverId,f.job.targetServerId);assert.equal(config.token,proposed);assert.equal(await missing(path.join(destination,'plugins/archive-collector/data')),true);
  assert.equal(await readFile(path.join(destination,'.mcmanager-restore/original-collector-data/outbox/server-id'),'utf8'),f.config.serverId);
}));

test('rejected continuation credential does not publish the restored server or rotate the source key',()=>sandbox(async parent=>{
  const f=await fixture(parent);f.job.mode='CONTINUE';f.config.restoreCollectorToken=f.config.serverId+'.'+'Z'.repeat(43);let received;
  const post=f.api.post.bind(f.api);f.api.post=async(route,body)=>{if(route.endsWith('/collector')){received=body.collectorToken;throw new HostApiError(409);}return post(route,body);};
  await(await f.runner()).step();assert.equal(received,f.config.restoreCollectorToken);assert.equal(f.job.status,'UNCERTAIN');assert.equal(await missing(path.join(f.config.restoreDirectory,f.job.destinationName)),true);
  assert.equal(JSON.parse(await readFile(path.join(f.config.root,'plugins/archive-collector/config/config.json'),'utf8')).token,f.token);
  assert.equal(f.calls.some(c=>c.endsWith('/ready')),false);
}));

test('restore journals are bound to their task kind and cannot be opened as backup state',()=>sandbox(async parent=>{
  const hostId=randomUUID(),serverId=randomUUID(),store=await HostStore.open(parent,hostId,serverId,'RESTORE');
  const record=await store.create({job:{id:randomUUID()},attemptId:randomUUID()},randomUUID());record.phase='RESTORING';await store.save(record);
  assert.equal((await(await HostStore.open(parent,hostId,serverId,'RESTORE')).records())[0].phase,'RESTORING');
  await assert.rejects(HostStore.open(parent,hostId,serverId),/task kind/);
}));

test('maintenance supports an empty disaster recovery root while rejecting overlapping restore paths',()=>sandbox(async parent=>{
  const root=path.join(parent,'empty'),outputDirectory=path.join(parent,'output'),restoreDirectory=path.join(parent,'copies');
  for(const dir of[root,outputDirectory,restoreDirectory])await mkdir(dir);
  const hostId=randomUUID(),file=path.join(parent,'host.json'),config={root,outputDirectory,restoreDirectory,serverId:randomUUID(),apiUrl:'http://127.0.0.1:8080',token:'mcmhost.'+hostId+'.'+'A'.repeat(43)};
  await writeFile(file,JSON.stringify(config));assert.equal((await readHostConfig(file,{}, {maintenance:true})).maintenance,true);
  await assert.rejects(readHostConfig(file,{}));
  for(const invalid of[root,parent,path.join(outputDirectory,'.mcmanager-host-'+hostId)]){
    await writeFile(file,JSON.stringify({...config,restoreDirectory:invalid}));await assert.rejects(readHostConfig(file,{}, {maintenance:true}),/separate/);
  }
}));
