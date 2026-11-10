import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { HostStore } from './host-store.mjs';
import { inspectBackup, restoreBackup, verifyRestoredDirectory } from './archive.mjs';
import { canonicalDirectory, canonicalJson, check, isUuid, missing, safeRelative } from './paths.mjs';
import { assertServerStopped } from './processes.mjs';

const terminal=new Set(['DONE','FAILED','CANCELLED','SUPERSEDED']);
const started=new Set(['RESTORING','RESTORED','UNCERTAIN']);
export class RestoreRunner {
  constructor(config,api,notify=()=>{}) {this.config=config;this.api=api;this.notify=notify;this.stopping=false;}
  async open() {
    const directory=path.join(this.config.stateDirectory,'.restore-jobs');await mkdir(directory,{recursive:true,mode:0o700});
    this.store=await HostStore.open(directory,this.api.hostId,this.config.serverId,'RESTORE');return this;
  }
  #job(value,id) {
    check(value&&value.id===id&&value.hostId===this.api.hostId&&[value.id,value.backupId,value.sourceServerId,value.targetServerId,value.sourceBackupId].every(isUuid)&&['DISABLED','CONTINUE','FORK'].includes(value.mode)
      &&/^[a-f0-9]{64}$/.test(value.archiveSha256)&&/^[1-9][0-9]{0,10}$/.test(value.archiveBytes)&&BigInt(value.archiveBytes)<=17179869184n&&Number.isInteger(value.fileCount)&&value.fileCount>0&&value.fileCount<=100000,'Invalid restore job');
    const name=value.destinationName;safeRelative(name);check(name.normalize('NFC')===name&&/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u.test(name),'Invalid new restore directory');
    check(value.mode!=='CONTINUE'||value.sourceServerId===this.config.serverId&&value.targetServerId===this.config.serverId&&this.config.maintenance,'Continue requires the original archive in maintenance mode');
    return value;
  }
  #fingerprint(job) {return Object.fromEntries(['id','backupId','sourceServerId','targetServerId','hostId','mode','destinationName','sourceBackupId','archiveSha256','archiveBytes','fileCount'].map(key=>[key,job[key]]));}
  async #save(record,phase,extra={}) {Object.assign(record,extra,{phase});await this.store.save(record);this.notify({event:'RESTORE_CHECKPOINT',jobId:record.jobId,phase});}
  async #report(record,outcome,code) {
    try {await this.api.post(`/restores/${record.jobId}/report`,{runId:this.config.runId,attemptId:record.attemptId,outcome,code});await this.#save(record,outcome);}
    catch(error) {if(error.status===401)throw error;await this.#save(record,'UNCERTAIN');}
  }
  async renew() {
    if(!this.active||terminal.has(this.active.phase))return;
    try {const job=await this.api.post(`/restores/${this.active.jobId}/renew`,{runId:this.config.runId,attemptId:this.active.attemptId});
      if(job.cancelRequested){this.cancelRequested=true;this.abort?.abort();}
    } catch(error){this.abort?.abort();if(error.status===401)throw error;}
  }
  stop() {this.stopping=true;this.abort?.abort();}
  async step() {
    if(this.stopping)return false;
    const records=await this.store.records();let record=records.find(value=>!terminal.has(value.phase));
    if(!record) {
      const requestId=await this.store.claimId(this.config.runId),claim=await this.api.post('/restores/claim',{runId:this.config.runId,requestId});
      if(!claim)return false;this.#job(claim.job,claim.job?.id);check(isUuid(claim.attemptId),'Invalid restore attempt');
      if(claim.active)record=await this.store.create(claim,this.config.runId);
      await this.store.advanceClaim(this.config.runId);if(!record)return false;
    }
    this.active=record;this.cancelRequested=false;this.abort=new AbortController();
    try {await this.#process(record);}
    finally {if(this.stopping&&!terminal.has(record.phase))await this.#report(record,started.has(record.phase)?'UNCERTAIN':'CANCELLED','EXECUTION_INTERRUPTED');this.active=undefined;this.abort=undefined;}
    return true;
  }
  async #process(record) {
    let job=this.#job(await this.api.request(`/restores/${record.jobId}`),record.jobId);
    if(!record.job)await this.#save(record,record.phase,{job:this.#fingerprint(job),restorationId:randomUUID(),restoreRoot:this.config.restoreDirectory});
    check(canonicalJson(record.job)===canonicalJson(this.#fingerprint(job)),'Restore job changed after claim');
    if(job.status==='READY') {check(job.restorationId===record.restorationId,'Completed restore identity changed');await this.#save(record,'DONE');return;}
    if(['FAILED','CANCELLED'].includes(job.status)){await this.#save(record,job.status);return;}
    check(record.restoreRoot===this.config.restoreDirectory&&await canonicalDirectory(record.restoreRoot)===record.restoreRoot,'Restore root changed during a task');
    const destination=path.join(record.restoreRoot,job.destinationName),archive=this.store.archive(record);
    if(job.status==='QUEUED'&&['CLAIMED','START_REQUEST'].includes(record.phase)){await this.#save(record,'SUPERSEDED');return;}
    if(job.cancelRequested||this.stopping) {await this.#report(record,job.cancelRequested?'CANCELLED':started.has(record.phase)?'UNCERTAIN':'CANCELLED',job.cancelRequested?'OPERATOR_CANCELLED':'EXECUTION_INTERRUPTED');return;}
    if(started.has(record.phase)) {
      if(!record.inventorySha256||await missing(destination)){await this.#uncertain(record);return;}
      try {await verifyRestoredDirectory(destination,{...record.job,restorationId:record.restorationId,inventorySha256:record.inventorySha256},{signal:this.abort.signal});}
      catch {await this.#uncertain(record);return;}
      await this.#ready(record,job);return;
    }
    if(record.runId!==this.config.runId||job.status==='UNCERTAIN'){await this.#uncertain(record);return;}
    if(!(await missing(destination))){await this.#report(record,'FAILED','DESTINATION_EXISTS');return;}
    if(['CLAIMED','START_REQUEST'].includes(record.phase)) {
      await this.#save(record,'START_REQUEST');if(this.stopping)return;
      job=this.#job(await this.api.post(`/restores/${job.id}/start`,{runId:record.runId,attemptId:record.attemptId}),job.id);
      check(job.status==='RUNNING','Restore start not confirmed');await this.#save(record,'DOWNLOADING');
    }
    if(record.phase==='DOWNLOADING') {
      if(await missing(archive))await this.api.downloadRestore(job,record.runId,record.attemptId,archive,this.abort.signal);
      try {const proof=await inspectBackup(archive,{signal:this.abort.signal});
        check(proof.sha256===job.archiveSha256&&proof.archiveBytes===job.archiveBytes&&proof.manifest.serverId===job.sourceServerId&&proof.manifest.backupId===job.sourceBackupId&&proof.manifest.files.length===job.fileCount,'Downloaded archive differs from restore job');
      }catch(error){if(this.stopping)throw error;await this.#report(record,'FAILED','ARCHIVE_INVALID');return;}
      await this.#save(record,'DOWNLOADED');
    }
    if(this.stopping)return;
    if(job.mode==='CONTINUE')await assertServerStopped(this.config.root);
    const renew=await this.api.post(`/restores/${job.id}/renew`,{runId:record.runId,attemptId:record.attemptId});
    if(renew.cancelRequested){await this.#report(record,'CANCELLED','OPERATOR_CANCELLED');return;}
    await this.#save(record,'RESTORING',{workerPid:process.pid});
    try {
      await restoreBackup({file:archive,destination,mode:job.mode,targetServerId:job.targetServerId,restorationId:record.restorationId,endpoint:new URL('/api/ingest/v1/batches',this.config.apiUrl).href,signal:this.abort.signal,
        prepareCollector:async original=>{
          let token;
          if(job.mode==='FORK')token=job.targetServerId+'.'+createHmac('sha256',this.config.token).update('mcmanager-restore:'+job.id+':'+job.targetServerId).digest('base64url');
          else {
            let local;
            try{local=JSON.parse(await readFile(path.join(this.config.root,'plugins/archive-collector/config/config.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
            token=this.config.restoreCollectorToken??local?.token??original.token;
          }
          await this.api.post(`/restores/${job.id}/collector`,{runId:record.runId,attemptId:record.attemptId,collectorToken:token});return token;
        },
        onPrepared:extra=>this.#save(record,'RESTORING',extra),
        beforePublish:async()=>{if(job.mode==='CONTINUE')await assertServerStopped(this.config.root);const result=await this.api.post(`/restores/${job.id}/renew`,{runId:record.runId,attemptId:record.attemptId});if(result.cancelRequested){this.cancelRequested=true;this.abort.abort();}this.abort.signal.throwIfAborted();},
        onPhase:phase=>this.notify({event:'RESTORE_FILES_PHASE',jobId:job.id,phase}),
      });
      await this.#save(record,'RESTORED');
    } catch(error) {
      if(error.status===401)throw error;
      await this.#report(record,this.cancelRequested?'CANCELLED':'UNCERTAIN',this.cancelRequested?'OPERATOR_CANCELLED':'EXECUTION_INTERRUPTED');return;
    }
    if(this.stopping){await this.#report(record,'UNCERTAIN','EXECUTION_INTERRUPTED');return;}
    await this.#ready(record,job);
  }
  async #uncertain(record) {
    if(record.phase!=='UNCERTAIN')await this.#report(record,'UNCERTAIN','EXECUTION_INTERRUPTED');
    const key=record.jobId+':'+record.phase;if(this.lastNotice!==key){this.lastNotice=key;this.notify({event:'RESTORE_RECONCILIATION_REQUIRED',jobId:record.jobId});}
  }
  async #ready(record,job) {
    if(job.mode==='CONTINUE')await assertServerStopped(this.config.root);
    const result=await this.api.post(`/restores/${job.id}/${job.status==='UNCERTAIN'||record.runId!==this.config.runId?'recover':'ready'}`,{runId:this.config.runId,attemptId:record.attemptId,restorationId:record.restorationId,sourceBackupId:job.sourceBackupId,targetServerId:job.targetServerId,mode:job.mode,destinationName:job.destinationName,sha256:job.archiveSha256,fileCount:job.fileCount});
    check(result.status==='READY'&&result.restorationId===record.restorationId&&result.worldRuntimeVerified===false,'Restore readiness not confirmed');await this.#save(record,'DONE');
  }
}
