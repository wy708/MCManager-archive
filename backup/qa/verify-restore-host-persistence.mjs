import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/paths.mjs';

// Read-only verification after the owned QA containers have been recreated.
const project=fileURLToPath(new URL('../../',import.meta.url)),base=process.env.MCM_QA_BASE_URL??'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname,'127.0.0.1');
const previous=JSON.parse(await readFile(path.join(project,'.tools/restore-host-evidence.json'),'utf8'));
assert.equal(previous.realGameplay,true);assert.equal(previous.threeModes.length,3);
const environment=Object.fromEntries((await readFile(path.join(project,'.env'),'utf8')).split(/\r?\n/).filter(line=>line.startsWith('MCM_')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
const cookies=new Map();
async function request(endpoint,options={}){
  const response=await fetch(base+endpoint,{...options,redirect:'error',headers:{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers},signal:AbortSignal.timeout(900000)});
  for(const cookie of response.headers.getSetCookie()){const at=cookie.indexOf('=');cookies.set(cookie.slice(0,at),cookie.slice(at+1).split(';')[0]);}return response;
}
async function get(endpoint){const response=await request(endpoint);assert.ok(response.ok,`Persistence read HTTP ${response.status}`);return response.json();}
let csrf=await get('/api/auth/csrf');assert.equal((await request('/api/auth/login',{method:'POST',headers:{[csrf.headerName]:csrf.token},body:new URLSearchParams({username:environment.MCM_ADMIN_USERNAME??'admin',password:environment.MCM_ADMIN_PASSWORD})})).status,204);
const backup=await get('/api/backups/'+previous.backupId);assert.equal(backup.status,'READY');assert.equal(backup.sha256,previous.sha256);assert.equal(backup.archiveBytes,previous.archiveBytes);
const download=await request('/api/backups/'+previous.backupId+'/content');assert.equal(download.status,200);const hash=createHash('sha256');let bytes=0n;
for await(const chunk of download.body){hash.update(chunk);bytes+=BigInt(chunk.length);}assert.equal(hash.digest('hex'),previous.sha256);assert.equal(String(bytes),previous.archiveBytes);
for(const original of previous.threeModes){const job=await get('/api/restores/'+original.jobId);assert.equal(job.status,'READY');assert.equal(job.mode,original.mode);assert.equal(job.targetServerId,original.targetServerId);assert.equal(job.archiveSha256,previous.sha256);assert.equal(job.worldRuntimeVerified,false);}
const interrupted=await get('/api/restores/'+previous.interruptedJobId);assert.equal(interrupted.status,'FAILED');
const recovered=await get('/api/restores/'+previous.recoveredJobId);assert.equal(recovered.status,'READY');assert.equal(recovered.restorationId,previous.originalRestorationIdRecovered);
const hosts=await get('/api/backup-hosts?serverId='+previous.threeModes[0].targetServerId),host=hosts.find(host=>host.id===recovered.hostId);assert.ok(host);assert.equal(host.revoked,true);assert.equal(host.version,previous.hostVersion);
const evidence={verifiedAt:new Date().toISOString(),sourceRealGameProofAt:previous.verifiedAt,backupId:previous.backupId,sha256:previous.sha256,downloadedBytes:String(bytes),threeReadyModesPreserved:true,originalRecoveryReceiptPreserved:true,interruptionResolutionPreserved:true,hostRevocationPreserved:true,worldRuntimeVerifiedStillSeparate:true,rawTokensRecorded:false};
await writeFile(path.join(project,'.tools/restore-host-persistence-evidence.json'),canonicalJson(evidence));console.log(canonicalJson(evidence));
