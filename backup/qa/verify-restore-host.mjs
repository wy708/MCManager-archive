import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { localGameClient } from '../../collector/qa/http-client.mjs';
import { inputDriver } from '../../collector/qa/input-driver.mjs';
import { ManagedGame } from '../src/managed-game.mjs';
import { createStoppedBackup, inspectBackup, verifyRestoredDirectory } from '../src/archive.mjs';
import { canonicalJson, inventory, contains, missing } from '../src/paths.mjs';
import { HostStore } from '../src/host-store.mjs';

// Only this project's marked, isolated BDS installation may be used as source.
const project=fileURLToPath(new URL('../../',import.meta.url)),source=path.join(project,'.tools/game-qa-26.51.8');
assert.equal(JSON.parse(readFileSync(path.join(source,'qa-provenance.json'))).owner,'MCManager-archive-isolated-qa');
const serverId=JSON.parse(readFileSync(path.join(source,'live-chat-fixture.json'))).serverId;
const environment=Object.fromEntries(readFileSync(path.join(project,'.env'),'utf8').split(/\r?\n/).filter(line=>line.startsWith('MCM_')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
const base=process.env.MCM_QA_BASE_URL??'http://127.0.0.1:18088';assert.equal(new URL(base).hostname,'127.0.0.1');
const run=randomUUID(),directory=path.join(project,'.tools','restore-host-qa-'+run),offlineIdentity=randomUUID(),copies=path.join(directory,'copies'),outputDirectory=path.join(directory,'backups'),configFile=path.join(directory,'host.json');
await mkdir(directory);await writeFile(path.join(directory,'.qa-owner'),run);await mkdir(copies);await mkdir(outputDirectory);
const configPath=path.join(source,'plugins/archive-collector/config/config.json'),originalConfig=await readFile(configPath);
const cookies=new Map(),events=[],jobs=[],held=new Set(),cursors=new Map();
let csrf,hostId,agentId,mcp,game,player,failure,remote,remoteExit,remoteCode,proxy,config,crashJob,crashKilled=false,holdReadyJob,readyHeld=false,recoverCalls=0;
let forkServerId,baseline,backup,uploaded,sourceMessage,newerMessage,expectedItem,sourceContext,browser;
const mark=(stage,extra={})=>console.log(JSON.stringify({stage,...extra}));
async function request(endpoint,options={}) {
  const response=await fetch(base+endpoint,{...options,redirect:'error',headers:{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers},signal:AbortSignal.timeout(900000)});
  for(const cookie of response.headers.getSetCookie()){const at=cookie.indexOf('=');cookies.set(cookie.slice(0,at),cookie.slice(at+1).split(';')[0]);}return response;
}
async function admin(endpoint,body,method='POST') {
  const response=await request(endpoint,{method,headers:{[csrf.headerName]:csrf.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  assert.ok(response.ok,`Restore QA admin ${endpoint}: HTTP ${response.status}`);return response.status===204?null:response.json();
}
async function get(endpoint){const response=await request(endpoint);assert.ok(response.ok,`Restore QA read: HTTP ${response.status}`);return response.json();}
async function until(action,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){if(failure)throw failure;if(remote&&remoteCode!==undefined)throw new Error('Maintenance CLI exited '+remoteCode);const value=await action();if(value)return value;await delay(100);}throw new Error('Restore host QA timed out; inspect '+directory);}
async function tool(name,args={}){const result=await mcp.callTool({name,arguments:args});assert.notEqual(result.isError,true,'MCP '+name+' failed');return result.structuredContent.data;}
async function chats(id){const messages=[];let cursor=cursors.get(id)??'0';for(;;){const page=await tool('get_chat_messages',{serverId:id,after:cursor,limit:200});messages.push(...page.items);cursor=page.nextCursor;if(!page.hasMore)break;}cursors.set(id,cursor);return messages;}
async function launch(root){assert.ok(root===source||contains(copies,root));game=await ManagedGame.start(root,{output:chunk=>appendFileSync(path.join(directory,'game.log'),chunk)});}
async function connect(){
  const state={expectedClose:false,texts:[],held:null};state.bot=await localGameClient('http://127.0.0.1:19152','ArchiveQA',error=>{if(!state.expectedClose)failure=error;},offlineIdentity);
  state.bot.on('text',packet=>state.texts.push(packet));state.bot.on('inventory_content',packet=>{if(['inventory',0].includes(packet.window_id))state.held=packet.input[0];});
  state.bot.on('inventory_slot',packet=>{if(['inventory',0].includes(packet.window_id)&&packet.slot===0)state.held=packet.item;});
  state.bot.on('disconnect',packet=>{if(!state.expectedClose)failure=new Error('Owned player disconnected: '+packet.reason);});let spawned=false;state.bot.on('spawn',()=>spawned=true);player=state;await until(()=>spawned,45000);inputDriver(state.bot);return state;
}
async function command(text){game.child.stdin.write(text+'\n');await delay(250);}
async function proveBlock(expected){const marker='MCM_RESTORE_HOST_'+randomUUID();await command(`execute if block 2 105 2 ${expected} run say ${marker}`);await until(()=>player.texts.some(packet=>packet.message.includes(marker)),10000);}
async function sendChat(text){player.bot.queue('text',{category:'authored',type:'chat',needs_translation:false,source_name:player.bot.profile.name,xuid:'',platform_chat_id:'',has_filtered_message:false,message:text});await until(()=>player.texts.some(packet=>packet.message===text));}
async function disconnect(id){if(player){player.expectedClose=true;player.bot.close();player=null;}if(id)await until(async()=>(await tool('get_player_context',{serverId:id,playerKey})).sessions[0].ended);}
async function stopGame(){assert.equal(await game.stop(),0);game=null;}
async function queue(mode,destinationName){const body={requestId:randomUUID(),hostId,mode,destinationName,note:'自有隔离 BDS 宿主恢复验收 '+run,forkName:mode==='FORK'?'恢复新一期验收 '+run.slice(0,8):null,forkStartDate:mode==='FORK'?'2026-10-28':null};const job=browser?await browser.create(uploaded.id,body):await admin('/api/backups/'+uploaded.id+'/restores',body);jobs.push(job);return job;}
async function ready(job){return until(async()=>{const current=await get('/api/restores/'+job.id);assert.ok(!['FAILED','CANCELLED','UNCERTAIN'].includes(current.status),'Unexpected restore result '+current.status);return current.status==='READY'?current:null;},300000);}
async function storeRecord(job){const store=await HostStore.open(path.join(outputDirectory,'.mcmanager-host-'+hostId,'.restore-jobs'),hostId,serverId,'RESTORE');return{store,record:(await store.records()).find(record=>record.jobId===job.id)};}
async function worldInventory(){const result=await inventory(path.join(source,'worlds'));return result.files.map(({path,size,sha256})=>({path,size,sha256}));}
const playerKey='uuid:a1af9017-0990-3a67-9999-7c3f26c7ebc4';

try{
  csrf=await(await request('/api/auth/csrf')).json();assert.equal((await request('/api/auth/login',{method:'POST',headers:{[csrf.headerName]:csrf.token},body:new URLSearchParams({username:environment.MCM_ADMIN_USERNAME??'admin',password:environment.MCM_ADMIN_PASSWORD})})).status,204);csrf=await(await request('/api/auth/csrf')).json();
  const collector=await admin(`/api/servers/${serverId}/collector-credential`);await writeFile(configPath,canonicalJson({enabled:true,serverId,token:collector.token,endpoint:base+'/api/ingest/v1/batches'}));
  const agent=await admin('/api/agents',{name:'宿主恢复实际游戏验收',grants:[{serverId,scopes:['STATS_READ','CHAT_READ']}]});agentId=agent.account.id;
  mcp=new Client({name:'restore-host-game-verifier',version:'0.5.0'});await mcp.connect(new StdioClientTransport({command:process.execPath,args:[path.join(project,'mcp/src/server.mjs')],env:{MCM_MCP_API_URL:base,MCM_AGENT_TOKEN:agent.token},stderr:'inherit'}));await chats(serverId);
  mark('seeding-real-world');await launch(source);await connect();await command('gamemode creative ArchiveQA');await command('tp ArchiveQA 0.5 100 0.5');await command('setblock 2 105 2 gold_block');await proveBlock('gold_block');await command('replaceitem entity ArchiveQA slot.hotbar 0 diamond 7');await until(()=>player.held?.count===7);expectedItem={networkId:player.held.network_id,count:7};
  sourceMessage='宿主恢复前原聊天 '+run;await sendChat(sourceMessage);await until(async()=>(await chats(serverId)).some(item=>item.text===sourceMessage));await disconnect(serverId);await stopGame();
  const file=path.join(directory,'source.tar.gz');mark('creating-real-stopped-archive');backup=await createStoppedBackup({root:source,output:file,serverId,note:'宿主三种恢复与实际玩家背包验收'});const proof=await inspectBackup(file);assert.equal(proof.manifest.statistics.pendingEvents,'0');assert.ok(proof.manifest.files.length>1000);
  // Newer game state and newer central history must survive restoring the older copy.
  await launch(source);await connect();await until(()=>player.held?.count===7&&player.held.network_id===expectedItem.networkId);await command('setblock 2 105 2 air');await proveBlock('air');await command('replaceitem entity ArchiveQA slot.hotbar 0 diamond 11');await until(()=>player.held?.count===11);newerMessage='备份后中央历史保留 '+run;await sendChat(newerMessage);await until(async()=>(await chats(serverId)).some(item=>item.text===newerMessage));await disconnect(serverId);sourceContext=await tool('get_player_context',{serverId,playerKey});await stopGame();baseline=await worldInventory();
  uploaded=await admin(`/api/servers/${serverId}/backups`,{requestId:randomUUID(),kind:'MANUAL',note:'宿主恢复验收 '+run,permanent:true,expectedBytes:backup.archiveBytes});
  const response=await request('/api/backups/'+uploaded.id+'/content',{method:'PUT',headers:{[csrf.headerName]:csrf.token,'Content-Type':'application/octet-stream','Content-Length':backup.archiveBytes},body:createReadStream(file),duplex:'half'});assert.ok(response.ok,'Archive upload HTTP '+response.status);uploaded=await response.json();assert.equal(uploaded.status,'READY');mark('archive-uploaded',{backupId:uploaded.id,bytes:backup.archiveBytes});
  const existing=await get('/api/backup-hosts?serverId='+serverId);if(existing.length)assert.equal(existing[0].name,'实服远程备份验收');const issued=existing.length?await admin('/api/backup-hosts/'+existing[0].id+'/rotate'):await admin('/api/backup-hosts',{serverId,name:'实服远程备份验收'});hostId=issued.host.id;
  proxy=createServer((incoming,outgoing)=>{
    if(holdReadyJob&&incoming.url===`/api/host/v1/restores/${holdReadyJob}/ready`){readyHeld=true;held.add(outgoing);outgoing.on('close',()=>held.delete(outgoing));incoming.resume();return;}
    if(incoming.url?.endsWith('/recover'))recoverCalls++;
    const forwarded=httpRequest(new URL(incoming.url,base),{method:incoming.method,headers:{...incoming.headers,host:new URL(base).host}},reply=>{outgoing.writeHead(reply.statusCode,reply.headers);reply.pipe(outgoing);});
    incoming.on('aborted',()=>forwarded.destroy());outgoing.on('close',()=>{if(!outgoing.writableEnded)forwarded.destroy();});forwarded.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});incoming.pipe(forwarded);
  });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  config={apiUrl:'http://127.0.0.1:'+proxy.address().port,token:issued.token,root:source,outputDirectory,restoreDirectory:copies,serverId};await writeFile(configFile,canonicalJson(config));
  remote=spawn(process.execPath,[path.join(project,'backup/src/remote.mjs'),'--config',configFile,'--maintenance'],{cwd:project,windowsHide:true,stdio:['pipe','pipe','pipe']});remoteExit=new Promise((resolve,reject)=>{remote.once('exit',code=>{remoteCode=code;resolve(code);});remote.once('error',reject);});
  let lines='';remote.stdout.on('data',chunk=>{appendFileSync(path.join(directory,'host-events.log'),chunk);lines+=chunk;let at;while((at=lines.indexOf('\n'))>=0){const line=lines.slice(0,at);lines=lines.slice(at+1);let event;try{event=JSON.parse(line);}catch{continue;}events.push(event);if(event.jobId===crashJob&&event.event==='RESTORE_FILES_PHASE'&&event.phase==='EXTRACTING'&&!crashKilled){crashKilled=true;const worker=events.filter(e=>e.event==='HOST_WORKER_STARTED').at(-1);process.kill(worker.pid);mark('extraction-worker-killed',{jobId:crashJob,pid:worker.pid});}}});
  remote.stderr.on('data',chunk=>appendFileSync(path.join(directory,'host-diagnostics.log'),chunk));
  await until(async()=>(await get('/api/backup-hosts?serverId='+serverId)).some(host=>host.id===hostId&&host.runtimeState==='STOPPED'&&host.restoreEnabled&&host.version==='0.6.0'));assert.equal(events.some(e=>e.event==='GAME_STARTED'),false);mark('maintenance-host-available');
  if(process.argv.includes('--browser')){const {restoreBrowser}=await import('./restore-browser.mjs');browser=await restoreBrowser({base,username:environment.MCM_ADMIN_USERNAME??'admin',password:environment.MCM_ADMIN_PASSWORD,serverId,directory});}
  const completed=[];
  for(const [mode,label]of[['DISABLED','独立检查'],['FORK','恢复新一期'],['CONTINUE','继续原一期']]){
    const name=label+'-'+run.slice(0,8);
    const job=await queue(mode,name),result=await ready(job);assert.equal(result.worldRuntimeVerified,false);completed.push(result);if(mode==='FORK')forkServerId=result.targetServerId;await browser?.ready(result);
    const {record}=await storeRecord(job);await verifyRestoredDirectory(path.join(copies,name),{...record.job,restorationId:record.restorationId,inventorySha256:record.inventorySha256});mark('files-ready',{mode,jobId:job.id});
  }
  const interrupted=await queue('DISABLED','中断现场-'+run.slice(0,8));crashJob=interrupted.id;await until(()=>crashKilled,300000);
  await until(async()=>(await get('/api/restores/'+interrupted.id)).status==='UNCERTAIN');await until(()=>events.some(e=>e.event==='RESTORE_RECONCILIATION_REQUIRED'&&e.jobId===interrupted.id));
  await delay(4500);assert.equal(events.filter(e=>e.jobId===interrupted.id&&e.phase==='EXTRACTING').length,1);assert.equal((await storeRecord(interrupted)).record.phase,'UNCERTAIN');assert.ok((await readdir(copies)).some(name=>name.startsWith('.mcmanager-restore-')));const interruptionNote='自有 QA 强制结束解包工作进程，现场保留，确认不重复解包';if(browser)await browser.resolve(interrupted,interruptionNote);else await admin('/api/restores/'+interrupted.id+'/resolve',{outcome:'FAILED',note:interruptionNote});mark('incomplete-restore-preserved');
  const reconnect=await queue('DISABLED','回执重连-'+run.slice(0,8));holdReadyJob=reconnect.id;await until(()=>readyHeld,300000);const originalRecord=(await storeRecord(reconnect)).record;assert.equal(originalRecord.phase,'RESTORED');
  const replacement=await admin('/api/backup-hosts/'+hostId+'/rotate');config.token=replacement.token;await writeFile(configFile,canonicalJson(config));assert.equal((await get('/api/restores/'+reconnect.id)).status,'UNCERTAIN');
  const oldWorker=events.filter(e=>e.event==='HOST_WORKER_STARTED').at(-1).pid;process.kill(oldWorker);holdReadyJob=undefined;for(const response of held)response.destroy();
  const recovered=await until(async()=>{const job=await get('/api/restores/'+reconnect.id);return job.status==='READY'?job:null;},120000);assert.equal(recovered.restorationId,originalRecord.restorationId);assert.equal(events.filter(e=>e.jobId===reconnect.id&&e.phase==='EXTRACTING').length,1);assert.ok(recoverCalls>=1);mark('original-receipt-recovered');
  assert.deepEqual(await worldInventory(),baseline);remote.stdin.write('stop\n');assert.equal(await remoteExit,0);remote=undefined;
  await admin('/api/agents/'+agentId+'/grants',{grants:[serverId,forkServerId].map(serverId=>({serverId,scopes:['STATS_READ','CHAT_READ']}))},'PUT');
  const metric=context=>context.statistics.metrics.find(row=>row.key==='chat.messages').value;
  cursors.set(serverId,'0');const fullHistory=await chats(serverId);assert.equal(fullHistory.filter(item=>item.text===sourceMessage).length,1);assert.equal(fullHistory.filter(item=>item.text===newerMessage).length,1);
  const proofs=[];
  for(const job of completed){
    const root=path.join(copies,job.destinationName),before=await tool('get_player_context',{serverId,playerKey});await launch(root);await connect();
    await until(()=>player.held?.count===expectedItem.count&&player.held.network_id===expectedItem.networkId);await command('tp ArchiveQA 0.5 100 0.5');await proveBlock('gold_block');
    const text='恢复实际运行 '+job.mode+' '+run;await sendChat(text);
    if(job.mode==='DISABLED'){await disconnect();await stopGame();const after=await tool('get_player_context',{serverId,playerKey});assert.equal(metric(after),metric(before));}
    else{
      const target=job.targetServerId;await until(async()=>(await chats(target)).some(item=>item.text===text));await disconnect(target);await stopGame();
      if(job.mode==='FORK'){const originalAfter=await tool('get_player_context',{serverId,playerKey});assert.equal(metric(originalAfter),metric(before));cursors.set(target,'0');const forkChats=await chats(target);assert.equal(forkChats.some(item=>item.text===sourceMessage||item.text===newerMessage),false);const binding=await readFile(path.join(root,'plugins/archive-collector/data/outbox/server-id'),'utf8');assert.equal(binding,target);}
      else{const after=await tool('get_player_context',{serverId,playerKey});assert.equal(BigInt(metric(after)),BigInt(metric(before))+1n);assert.notEqual(after.sessions[0].sessionId,sourceContext.sessions[0].sessionId);}
    }
    proofs.push({mode:job.mode,jobId:job.id,targetServerId:job.targetServerId,worldMarkerRestored:true,playerInventoryRestored:true});mark('real-game-proved',{mode:job.mode});
  }
  cursors.set(serverId,'0');const finalHistory=await chats(serverId);assert.equal(finalHistory.filter(item=>item.text===sourceMessage).length,1);assert.equal(finalHistory.filter(item=>item.text===newerMessage).length,1);assert.deepEqual(await worldInventory(),baseline);
  const evidence={verifiedAt:new Date().toISOString(),hostVersion:'0.6.0',actualGameVersion:'1.26.51.1',leviLaminaVersion:'26.51.8',realGameplay:true,browserWorkflow:Boolean(browser),maintenanceCliTested:true,maintenanceDidNotStartGame:true,backupId:uploaded.id,sourceBackupId:backup.backupId,sha256:backup.sha256,archiveBytes:backup.archiveBytes,fileCount:backup.fileCount,sourceWorldUnchangedByRestores:true,newerCentralHistoryPreserved:true,sourceChatNotDuplicated:true,forkHistoryIsolated:true,disabledCollectorProducedNoEvents:true,threeModes:proofs,interruptedJobId:interrupted.id,hardWorkerKillDuringExtraction:true,partialFilesPreserved:true,noSecondExtraction:true,recoveredJobId:reconnect.id,originalRestorationIdRecovered:originalRecord.restorationId,credentialRotationAndOriginalReceiptRecovery:true,rawTokensRecorded:false,wholeHostCrashTested:false,offMachineNetworkTested:false,allOwnedGamesStopped:true};
  await writeFile(path.join(directory,'evidence.json'),canonicalJson(evidence));await writeFile(path.join(project,'.tools/restore-host-evidence.json'),canonicalJson(evidence));if(browser)await writeFile(path.join(project,'.tools/restore-wizard-game-evidence.json'),canonicalJson(evidence));mark('verified',evidence);
}finally{
  if(player){player.expectedClose=true;player.bot.close();}
  if(game)await game.stop().catch(()=>{});
  if(remote){remote.stdin.write('stop\n');await remoteExit;}
  for(const response of held)response.destroy();proxy?.closeAllConnections();if(proxy)await new Promise(resolve=>proxy.close(resolve));
  if(csrf){for(const job of jobs){const current=await get('/api/restores/'+job.id).catch(()=>null);if(current?.status==='UNCERTAIN')await admin('/api/restores/'+job.id+'/resolve',{outcome:'FAILED',note:'自有 QA 工作进程已停止，保留现场'}).catch(()=>{});else if(current&&!['READY','FAILED','CANCELLED'].includes(current.status))await admin('/api/restores/'+job.id+'/cancel').catch(()=>{});}
    if(hostId)await admin('/api/backup-hosts/'+hostId,undefined,'DELETE').catch(()=>{});if(agentId)await admin('/api/agents/'+agentId,undefined,'DELETE').catch(()=>{});
    for(const id of [serverId,forkServerId].filter(Boolean))await admin('/api/servers/'+id+'/collector-credential',undefined,'DELETE').catch(()=>{});
  }
  await mcp?.close();await writeFile(configPath,originalConfig);await browser?.close();
}
