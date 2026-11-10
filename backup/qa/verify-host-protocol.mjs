// Real HTTP/PostgreSQL protocol verification with a synthetic archive. This is
// not a host daemon, native snapshot, or game-restoration acceptance test.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectBackup } from '../src/archive.mjs';
import { canonicalJson } from '../src/paths.mjs';
const project = fileURLToPath(new URL('../../', import.meta.url)), base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname, '127.0.0.1');
const environment = Object.fromEntries((await readFile(path.join(project,'.env'),'utf8')).split(/\r?\n/).filter(line => line.startsWith('MCM_') && line.includes('='))
  .map(line => { const at = line.indexOf('='); return [line.slice(0,at),line.slice(at+1)]; }));
const cookies = new Map(); let csrf, hostId, token;
async function request(endpoint, options = {}, admin = true) {
  const response = await fetch(base + endpoint, { ...options, redirect:'error', headers: { ...(admin ? {Cookie:[...cookies].map(([key,value])=>`${key}=${value}`).join('; ')} : {}), ...options.headers }, signal:AbortSignal.timeout(900000) });
  if (admin) for (const cookie of response.headers.getSetCookie()) { const at=cookie.indexOf('=');cookies.set(cookie.slice(0,at),cookie.slice(at+1).split(';')[0]); }
  return response;
}
async function admin(endpoint, body, method='POST') {
  const response = await request(endpoint,{method,headers:{[csrf.headerName]:csrf.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  assert.ok(response.ok,`Admin protocol HTTP ${response.status}`);return response.status===204?null:response.json();
}
async function host(endpoint, body, expected=200) {
  const response=await request('/api/host/v1'+endpoint,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)},false);
  assert.equal(response.status,expected,`Host protocol ${endpoint}`);return response.status===204?null:response.json();
}
csrf=await(await request('/api/auth/csrf')).json();
assert.equal((await request('/api/auth/login',{method:'POST',headers:{[csrf.headerName]:csrf.token},body:new URLSearchParams({username:environment.MCM_ADMIN_USERNAME??'admin',password:environment.MCM_ADMIN_PASSWORD})})).status,204);
csrf=await(await request('/api/auth/csrf')).json();
if (process.argv.includes('--check-persistence')) {
  const evidence=JSON.parse(await readFile(path.join(project,'.tools/host-job-deployment-evidence.json'),'utf8'));
  const job=await(await request('/api/backup-jobs/'+evidence.jobId)).json();assert.equal(job.status,'SUCCEEDED');assert.equal(job.archiveSha256,evidence.sha256);
  const record=await(await request('/api/backups/'+job.backupId)).json();assert.equal(record.status,'READY');assert.equal(record.sha256,evidence.sha256);
  const download=await request('/api/backups/'+record.id+'/content');assert.equal(download.status,200);const hash=createHash('sha256');let bytes=0n;
  for await(const chunk of download.body){bytes+=BigInt(chunk.length);hash.update(chunk)}assert.equal(hash.digest('hex'),evidence.sha256);assert.equal(bytes.toString(),evidence.archiveBytes);
  console.log(JSON.stringify({protocolPersistenceVerified:true,jobId:job.id,backupId:record.id,downloadedBytesVerified:true,realGameplay:false}));
} else {
  let fixture;const fixtureFile=path.join(project,'.tools/host-job-deployment-fixture.json');
  try {fixture=JSON.parse(await readFile(fixtureFile,'utf8'));assert.equal(fixture.owner,'MCManager-host-protocol-qa');}
  catch(error){if(error.code!=='ENOENT')throw error;const server=await admin('/api/servers',{name:'远程备份协议 QA',description:'Synthetic protocol fixtures; not real game data',startDate:'2020-01-01'});fixture={owner:'MCManager-host-protocol-qa',serverId:server.id};await writeFile(fixtureFile,canonicalJson(fixture));}
  const directory=path.join(project,'.tools','host-protocol-qa-'+randomUUID());await mkdir(directory);await writeFile(path.join(directory,'.qa-owner'),'MCManager-host-protocol-qa');
  try {
    const existing=await(await request('/api/backup-hosts?serverId='+fixture.serverId)).json();
    const issued=existing.length?await admin('/api/backup-hosts/'+existing[0].id+'/rotate'):await admin('/api/backup-hosts',{serverId:fixture.serverId,name:'协议测试执行端'});
    hostId=issued.host.id;token=issued.token;const runId=randomUUID();await host('/heartbeat',{runId,state:'RUNNING',version:'qa-1'});
    const jobs=await(await request('/api/backup-jobs?serverId='+fixture.serverId+'&size=100')).json();
    for(const job of jobs.items)if(job.status==='UNCERTAIN')await admin('/api/backup-jobs/'+job.id+'/resolve',{outcome:'FAILED',note:'前次自有协议测试已退出，保留原始诊断'});
    const input={requestId:randomUUID(),hostId,kind:'MANUAL',note:'Synthetic HTTP upload and host job verification',permanent:false};
    const job=await admin('/api/servers/'+fixture.serverId+'/backup-jobs',input);assert.equal((await admin('/api/servers/'+fixture.serverId+'/backup-jobs',input)).id,job.id);
    const claimRequest={runId,requestId:randomUUID()},claim=await host('/jobs/claim',claimRequest);assert.equal((await host('/jobs/claim',claimRequest)).attemptId,claim.attemptId);
    const lease={runId,attemptId:claim.attemptId};await host('/jobs/'+job.id+'/start',lease);
    const archive=path.join(directory,'fixture.tar.gz');await promisify(execFile)(process.execPath,[path.join(project,'backup/qa/create-upload-fixture.mjs'),directory,fixture.serverId,archive,'--online','--large'],{windowsHide:true,timeout:60000});
    const proof=await inspectBackup(archive);assert.ok(BigInt(proof.archiveBytes)>1048576n);
    const artifact={...lease,sourceBackupId:proof.manifest.backupId,sha256:proof.sha256,bytes:proof.archiveBytes};const reservation=await host('/jobs/'+job.id+'/artifact',artifact);
    assert.equal((await request('/api/backups/'+reservation.id+'/content',{headers:{Authorization:'Bearer '+token}},false)).status,401);
    const uploaded=await request('/api/host/v1/jobs/'+job.id+'/content',{method:'PUT',duplex:'half',headers:{Authorization:'Bearer '+token,'X-Host-Run':runId,'X-Backup-Attempt':claim.attemptId,'Content-Type':'application/octet-stream','Content-Length':proof.archiveBytes},body:createReadStream(archive)},false);
    assert.equal(uploaded.status,200);const ready=await uploaded.json();assert.equal(ready.status,'READY');assert.equal(ready.sha256,proof.sha256);
    const finished=await host('/jobs/'+job.id);assert.equal(finished.status,'SUCCEEDED');assert.equal(finished.backupId,ready.id);assert.equal(ready.worldRuntimeVerified,false);
    const result={verifiedAt:new Date().toISOString(),jobId:job.id,backupId:ready.id,serverId:fixture.serverId,archiveBytes:proof.archiveBytes,sha256:proof.sha256,
      realHttpAndContainerVerifier:true,nginxUploadAboveDefaultBodyLimit:true,idempotentCreationAndClaim:true,jobAndArchiveCommittedTogether:true,hostCannotDownloadArchives:true,realGameplay:false};
    await writeFile(path.join(project,'.tools/host-job-deployment-evidence.json'),canonicalJson(result));console.log(JSON.stringify(result,null,2));
  } finally {if(hostId)await admin('/api/backup-hosts/'+hostId,undefined,'DELETE');}
}
