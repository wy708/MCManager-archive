// Real BDS -> native collector -> isolated file database -> real MCP stdio.
// Requires an explicitly staged local QA game. Never points at a deployed server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, renameSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { inputDriver } from '../collector/qa/input-driver.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
assert.ok(process.env.MCM_CONTAINER_QA_ROOT && process.env.MCM_CONTAINER_QA_CLIENT,'Explicit isolated QA paths required');
const qa=path.resolve(process.env.MCM_CONTAINER_QA_ROOT), game=path.join(qa,'game');
assert.equal(readFileSync(path.join(qa,'owner.txt'),'utf8').trim(),'MCManager-container-audit-isolated-qa');
assert.match(readFileSync(path.join(game,'server.properties'),'utf8'),/^online-mode=false$/m);
const {localGameClient}=await import(pathToFileURL(process.env.MCM_CONTAINER_QA_CLIENT));
const password=randomBytes(24).toString('hex');
let backend,gameProcess,bot,client,transport,base,csrf,server;
let backendLog='',gameLog='',cookies=new Map();
const evidence={realGameplay:true,bds:'1.26.61.1',checks:[],at:new Date().toISOString()};
async function until(test,ms=30000) { const end=Date.now()+ms; while(Date.now()<end) { const value=await test(); if(value)return value; if(gameProcess?.exitCode!=null) throw new Error('QA game exited: '+gameProcess.exitCode); await delay(100); } throw new Error('QA condition timed out'); }
async function request(endpoint,options={}) {
  const r=await fetch(base+endpoint,{...options,headers:{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...options.headers},signal:AbortSignal.timeout(15000)});
  for(const c of r.headers.getSetCookie()) { const i=c.indexOf('='); cookies.set(c.slice(0,i),c.slice(i+1).split(';')[0]); } return r;
}
async function admin(endpoint,body) {
  const r=await request(endpoint,{method:'POST',headers:{[csrf.headerName]:csrf.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.ok(r.ok,`${endpoint} HTTP ${r.status}`); return r.json();
}
async function tool(name,args={}) { const r=await client.callTool({name,arguments:{serverId:server.id,...args}}); assert.notEqual(r.isError,true,JSON.stringify(r.content));return r.structuredContent.data; }
async function command(text) { gameProcess.stdin.write(text+'\n'); await delay(300); }
async function stopGame() { if(gameProcess?.exitCode===null) { gameProcess.stdin.write('stop\n'); await Promise.race([once(gameProcess,'exit'),delay(20000).then(()=>{if(gameProcess.exitCode===null)gameProcess.kill();})]); } }
try {
  backend=spawn('C:/Program Files/Java/jdk-21/bin/java.exe',['-jar',path.join(root,'backend/target/mcmanager-archive-0.1.0.jar')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
    MCM_PORT:'0',MCM_BIND_ADDRESS:'127.0.0.1',MCM_ADMIN_USERNAME:'admin',MCM_ADMIN_PASSWORD:password,MCM_COOKIE_SECURE:'false',
    MCM_DB_URL:`jdbc:h2:file:${path.join(qa,'database-'+randomUUID()).replaceAll('\\','/')};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE`,MCM_DB_USER:'sa',MCM_DB_PASSWORD:''}});
  for(const s of [backend.stdout,backend.stderr])s.on('data',c=>backendLog+=c);
  await until(()=>{const m=backendLog.match(/Tomcat started on port (\d+)/); if(m)base=`http://127.0.0.1:${m[1]}`;return base;});
  csrf=await(await request('/api/auth/csrf')).json();
  assert.equal((await request('/api/auth/login',{method:'POST',headers:{[csrf.headerName]:csrf.token},body:new URLSearchParams({username:'admin',password})})).status,204);
  csrf=await(await request('/api/auth/csrf')).json();
  server=await admin('/api/servers',{name:'Isolated real container QA',description:'No production data',startDate:'2020-01-01'});
  const credential=await admin(`/api/servers/${server.id}/collector-credential`,{});
  const issued=await admin('/api/agents',{name:'Container QA',grants:[{serverId:server.id,scopes:['WORLD_READ','STATS_READ','PROJECT_WRITE','QQ_BIND']}]});
  const plugin=path.join(game,'plugins/archive-collector'); mkdirSync(path.join(plugin,'config'),{recursive:true});
  if(existsSync(path.join(plugin,'data'))) renameSync(path.join(plugin,'data'),path.join(qa,'prior-capture-'+randomUUID()));
  for(const name of ['archive-collector.dll','manifest.json'])copyFileSync(path.join(root,'collector/bin/1.26.61.1/archive-collector',name),path.join(plugin,name));
  writeFileSync(path.join(plugin,'config/config.json'),JSON.stringify({enabled:true,serverId:server.id,token:credential.token,endpoint:base+'/api/ingest/v1/batches',activityIdleSeconds:300}));
  transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp/src/server.mjs')],env:{MCM_MCP_API_URL:base,MCM_AGENT_TOKEN:issued.token},stderr:'pipe'});
  client=new Client({name:'real-container-qa',version:'1.0'}); await client.connect(transport);
  gameProcess=spawn(path.join(game,'bedrock_server_mod.exe'),[],{cwd:game,windowsHide:true,stdio:['pipe','pipe','pipe']});
  for(const s of [gameProcess.stdout,gameProcess.stderr])s.on('data',c=>{gameLog+=c;writeFileSync(path.join(qa,'game.log'),gameLog);});
  await until(()=>gameLog.includes('Native dimension completion subscription established'),90000);
  assert.doesNotMatch(gameLog,/Couldn't find:|Collector could not start|Unsupported runtime/);
  let botError; bot=await localGameClient('http://127.0.0.1:19461','ArchiveQA',e=>{botError=e;});
  let spawned=false; const inventory=new Map(),containerSlots=new Map(),updates=new Map(),opened=[],responses=[];
  bot.on('spawn',()=>spawned=true);
  bot.on('inventory_content',p=>{p.input.forEach((item,slot)=>{containerSlots.set(`${p.window_id}:${slot}`,item);if(['inventory',0].includes(p.window_id))inventory.set(slot,item);});});
  bot.on('inventory_slot',p=>{containerSlots.set(`${p.window_id}:${p.slot}`,p.item);if(['inventory',0].includes(p.window_id))inventory.set(p.slot,p.item);});
  bot.on('update_block',p=>updates.set(`${p.position.x},${p.position.y},${p.position.z}`,p.block_runtime_id));
  bot.on('container_open',p=>opened.push(p)); bot.on('item_stack_response',p=>{
    responses.push(...p.responses);
    for(const r of p.responses) for(const c of r.containers??[]) for(const s of c.slots??[]) {
      if(c.slot_type.container_id==='hotbar_and_inventory') inventory.set(s.slot,{...inventory.get(s.slot),count:s.count,stack_id:s.item_stack_id});
      if(c.slot_type.container_id==='container') { const key=`${opened.at(-1)?.window_id}:${s.slot}`;containerSlots.set(key,{...containerSlots.get(key),count:s.count,stack_id:s.item_stack_id}); }
    }
  });
  await until(()=>spawned); assert.equal(botError,undefined);
  const received=[];bot.on('text',packet=>received.push(packet));
  async function playerCommand(commandText){bot.queue('command_request',{command:commandText,origin:{type:'Player',uuid:randomUUID(),request_id:'',player_entity_id:0n},internal:false,version:'Latest'});await delay(600);}
  const driver=inputDriver(bot); driver.setGrounded(true);
  await command('tp ArchiveQA 0.5 100 0.5'); bot.queue('serverbound_loading_screen',{type:2});
  await command('fill -3 99 -3 5 99 5 bedrock'); await command('fill -3 100 -3 5 104 5 air');
  await command('clear ArchiveQA'); await command('setblock 1 100 1 chest');
  await command('replaceitem block 1 100 1 slot.container 0 diamond 10');
  await command('gamemode survival ArchiveQA');
  const location={dimension:'minecraft:overworld',x:1,y:100,z:1};
  const history=()=>tool('get_container_history',location);
  await until(()=>updates.get('1,100,1'));
  bot.queue('player_hotbar',{selected_slot:0,window_id:'inventory',select_slot:true});
  function click(pos) { driver.input(undefined,undefined,{legacy:{legacy_request_id:0},actions:[],data:{action_type:'click_block',trigger_type:'player_input',block_position:pos,face:1,hotbar_slot:0,hand:'main_hand',held_item:inventory.get(0)??{network_id:0},player_pos:{...driver.position},click_pos:{x:0.5,y:1,z:0.5},block_runtime_id:updates.get(`${pos.x},${pos.y},${pos.z}`),client_prediction:'success',client_cooldown_state:'off'}}); }
  click({x:1,y:100,z:1});
  let window=await until(()=>opened.at(-1));
  console.log('QA: real chest screen opened');
  await until(async()=> (await history()).items.some(r=>r.operation==='OPEN'));
  evidence.checks.push('real player opens chest');
  const slot=(container,index,id)=>({slot_type:{container_id:container},slot:index,stack_id:id});
  let requestId=-401;
  async function move(count,source,destination,success=true) {
    const id=requestId-=2;bot.queue('item_stack_request',{requests:[{request_id:id,actions:[{type_id:'take',legacy_type_id:0,count,source,destination}],custom_names:[],cause:'chat_public'}]});
    const r=await until(()=>responses.find(r=>r.request_id===id)); if(success)assert.equal(r.status,'ok',JSON.stringify(r));else assert.notEqual(r.status,'ok'); await delay(500);return r;
  }
  await until(()=>containerSlots.get(`${window.window_id}:0`)?.count===10);
  const chestItem=()=>containerSlots.get(`${window.window_id}:0`);
  await move(3,slot('container',0,chestItem().stack_id),slot('hotbar_and_inventory',1,inventory.get(1)?.stack_id??0));
  await until(async()=> (await history()).items.some(r=>r.operation==='TRANSFER'&&r.container.changes.some(c=>c.before?.count===10&&c.after?.count===7)));
  evidence.checks.push('successful withdrawal 10 -> 7 attributed to player');
  const countBefore=(await history()).items.filter(r=>r.operation==='TRANSFER').length;
  await move(1,slot('container',0,chestItem().stack_id+10000),slot('hotbar_and_inventory',2,inventory.get(2)?.stack_id??0),false);
  await delay(1200);assert.equal((await history()).items.filter(r=>r.operation==='TRANSFER').length,countBefore);
  evidence.checks.push('rejected stale item identity produces no attributed transfer');
  await move(2,slot('hotbar_and_inventory',1,inventory.get(1).stack_id),slot('container',0,chestItem().stack_id));
  await until(async()=> (await history()).items.some(r=>r.operation==='TRANSFER'&&r.container.changes.some(c=>c.before?.count===7&&c.after?.count===9)));
  evidence.checks.push('successful deposit 7 -> 9 attributed to player');
  await command('replaceitem block 1 100 1 slot.container 0 diamond 5');
  await until(async()=> (await history()).items.some(r=>r.operation==='CHANGE'&&r.playerKey===null&&r.container.changes.some(c=>c.after?.count===5)));
  evidence.checks.push('external change is unattributed, not blamed on viewer');
  bot.queue('container_close',{window_id:window.window_id,window_type:window.window_type,server:false});await delay(300);
  await command('setblock 2 100 1 chest');
  await command('replaceitem block 1 100 1 slot.container 0 diamond 8');
  const priorOpen=opened.length;click({x:1,y:100,z:1});window=await until(()=>opened[priorOpen]);
  await until(()=>chestItem()?.count===8);
  await move(1,slot('container',0,chestItem().stack_id),slot('hotbar_and_inventory',2,inventory.get(2)?.stack_id??0));
  const paired=await until(async()=> (await history()).items.find(r=>r.operation==='TRANSFER'&&r.container.positions.length===2));
  assert.ok((await tool('get_container_history',{...location,x:2})).items.some(r=>r.eventId===paired.eventId));
  evidence.checks.push('real double chest transfer is queryable by either half');
  bot.queue('container_close',{window_id:window.window_id,window_type:window.window_type,server:false});await delay(300);
  // Create via actual in-game player command, then mutate by name through MCP.
  await command('tp ArchiveQA 0.5 100 0.5');await playerCommand('/project pos1');
  await command('tp ArchiveQA 4.5 100 4.5');await playerCommand('/project pos2');
  await playerCommand('/project create BuildQA');
  const project=await until(async()=>(await tool('list_construction_projects',{})).find(p=>p.name==='BuildQA'));
  await playerCommand('/qqbind');
  const code=await until(()=>received.map(p=>/QQ 绑定验证码 ([0-9A-F]{8})/.exec(p.message??'')).find(Boolean)?.[1]);
  await tool('bind_qq_account',{qqId:'12345678',code});
  const changed=await tool('update_construction_range',{qqId:'12345678',requestId:randomUUID(),name:'BuildQA',dimension:'minecraft:overworld',x1:0,z1:0,x2:5,z2:5});
  assert.equal(changed.revision,2);
  assert.equal((await tool('get_construction_project',{projectId:project.id,revision:1})).project.maxX,4);
  await command('tp ArchiveQA 0.5 100 0.5');
  evidence.checks.push('real player command creates project; bound MCP updates range by name and preserves old bounds');
  await command('gamemode creative ArchiveQA');
  await command('replaceitem entity ArchiveQA slot.hotbar 0 chest 1');await until(()=>inventory.get(0)?.count===1);
  await command('setblock 3 99 0 stone');await until(()=>updates.get('3,99,0'));
  click({x:3,y:99,z:0});
  const placed={...location,x:3,z:0};
  await until(async()=> (await tool('get_container_history',placed)).items.some(r=>r.operation==='PLACE'));
  driver.input([{action:'start_break',position:{x:3,y:100,z:0},face:1},{action:'predict_break',position:{x:3,y:100,z:0},face:1}],
    {request_id:requestId-=2,actions:[{type_id:'mine_block',legacy_type_id:11,hotbar_slot:0,predicted_durability:0,network_id:inventory.get(0)?.stack_id??0}],custom_names:[],cause:'chat_public'});
  await until(async()=> (await tool('get_container_history',placed)).items.some(r=>r.operation==='BREAK'));
  evidence.checks.push('real player placement and breaking retain coordinates and identity');
  const construction=await until(async()=>{const d=await tool('get_construction_project',{projectId:project.id});return d.statistics.materials.some(r=>r.operation==='BREAK'&&r.block==='minecraft:chest')?d:null;});
  assert.ok(construction.statistics.materials.some(r=>r.operation==='PLACE'&&r.block==='minecraft:chest'));
  await playerCommand('/project finish BuildQA');
  const frozen=await until(async()=>{const d=await tool('get_construction_project',{projectId:project.id});return d.project.status==='COMPLETE'?d:null;});
  await tool('resume_construction_project',{qqId:'12345678',requestId:randomUUID(),name:'BuildQA'});
  await playerCommand('/project range BuildQA');
  await until(async()=>(await tool('get_construction_project',{projectId:project.id})).revision===4);
  const old=await tool('get_construction_project',{projectId:project.id,revision:2});assert.deepEqual(old.statistics,frozen.statistics);assert.equal(old.project.maxX,5);
  const publicResult=await fetch(base+'/api/public/projects/'+project.id);assert.equal(publicResult.status,200);assert.doesNotMatch(await publicResult.text(),/xuid:|qqId/);
  const daily=await tool('get_server_daily_report',{date:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Hong_Kong'}).format(new Date())});assert.ok(daily.projects.length>=4);
  evidence.checks.push('actual placed/broken blocks feed project legend and contributions','game finish, AI resume, game range change preserve immutable phases','unauthenticated public project view and MCP daily report');
  bot.close(); await delay(500); await stopGame();
  evidence.history=await history();assert.ok(evidence.history.items.length>=4);
  evidence.checks.push('MCP reads historical evidence while game is offline');
  writeFileSync(path.join(qa,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({passed:true,checks:evidence.checks,evidence:path.join(qa,'evidence.json')}));
} finally {
  bot?.close();await stopGame();await client?.close();await transport?.close();
  if(backend?.exitCode===null){backend.kill();await once(backend,'exit');}
  writeFileSync(path.join(qa,'backend.log'),backendLog);writeFileSync(path.join(qa,'game.log'),gameLog);
}
