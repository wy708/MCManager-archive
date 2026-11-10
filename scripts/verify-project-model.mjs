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
  for(const s of [gameProcess.stdout,gameProcess.stderr])s.on('data',c=>{gameLog+=c;writeFileSync(path.join(qa,'model-game.log'),gameLog);});
  await until(()=>gameLog.includes('Native dimension completion subscription established'),90000);
  assert.doesNotMatch(gameLog,/Couldn't find:|Collector could not start|Unsupported runtime/);
  let botError; bot=await localGameClient('http://127.0.0.1:19461','ArchiveQA',e=>{botError=e;});
  let spawned=false; const inventory=new Map(),containerSlots=new Map(),updates=new Map(),opened=[],responses=[];
  const biomeDefinitions=new Map(),biomePackets=new Map();
  // This isolated vanilla world has no custom biomes. Use the pinned Bedrock registry
  // when the server does not send a definition packet (the Java registry has different IDs).
  for(const b of JSON.parse(readFileSync(path.join(root,'.tools/scene-runtime-release-033/packs/base_resource_pack/translation/minecraft/bedrock/bedrock_biomes.json'),'utf8')))biomeDefinitions.set(b.id,'minecraft:'+b.name);
  bot.on('biome_definition_list',p=>{for(const b of p.biome_definitions){const name=p.string_list[b.name_index];biomeDefinitions.set(b.biome_id,name.includes(':')?name:'minecraft:'+name);}});
  bot.on('level_chunk',p=>{if(p.dimension===0&&!p.cache_enabled){biomePackets.set(`${p.x},${p.z}`,p);if(p.x===0&&p.z===0)writeFileSync(path.join(qa,'biome-network-packet.json'),JSON.stringify(p));}});
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
  const drops=[];bot.on('add_item_entity',packet=>drops.push(packet));
  const signEditors=[];bot.on('open_sign',packet=>signEditors.push(packet));
  function click(pos,face=1){driver.input(undefined,undefined,{legacy:{legacy_request_id:0},actions:[],data:{action_type:'click_block',trigger_type:'player_input',block_position:pos,face,hotbar_slot:0,hand:'main_hand',held_item:inventory.get(0)??{network_id:0},player_pos:{...driver.position},click_pos:{x:.5,y:.5,z:.5},block_runtime_id:updates.get(`${pos.x},${pos.y},${pos.z}`),client_prediction:'success',client_cooldown_state:'off'}});}
  await command('tp ArchiveQA 0.5 100 0.5'); bot.queue('serverbound_loading_screen',{type:2});
  await command('fill -3 99 -3 5 99 5 bedrock'); await command('fill -3 100 -3 5 104 5 air');

  await command('fill 0 100 0 7 106 7 air');
  await command('fill 0 99 0 7 99 7 stone_bricks');
  await command('fill 0 100 0 0 103 7 oak_planks');
  await command('fill 7 100 0 7 103 7 oak_planks');
  await command('fill 0 100 7 7 103 7 oak_planks');
  await command('fill 1 100 0 6 101 0 glass');
  await command('fill 0 104 0 7 104 7 stone_slab');
  await command('setblock 2 100 2 oak_stairs');
  await command('setblock 1 100 5 grass_block');
  await command('setblock 2 101 5 oak_leaves');
  await command('setblock 1 100 1 diamond_block');
  await command('kill @e[type=cow]');
  await command('kill @e[type=armor_stand]');
  await command('summon cow 3 100 3');await command('effect @e[type=cow] slowness 9999 255 true');
  await command('summon armor_stand 4 100 4');
  await command('replaceitem entity @e[type=armor_stand] slot.armor.head 0 diamond_helmet');
  await command('setblock 3 100 1 air');
  await command('clear ArchiveQA');await command('tp ArchiveQA 3.5 100 2.5');
  await command('gamemode survival ArchiveQA');
  await command('setblock 3 99 1 stone');await command('setblock 3 99 1 stone_bricks');
  await command('replaceitem entity ArchiveQA slot.hotbar 0 oak_sign 1');
  await until(()=>inventory.get(0)?.count===1&&inventory.get(0)?.network_id>0);
  bot.queue('player_hotbar',{selected_slot:0,window_id:'inventory',select_slot:true});
  await until(()=>updates.get('3,99,1'));
  click({x:3,y:99,z:1});
  await until(()=>signEditors.length,10000);
  const tag=(type,value)=>({type,value});
  bot.queue('block_entity_data',{position:{x:3,y:100,z:1},nbt:{type:'compound',name:'',value:{id:tag('string','Sign'),x:tag('int',3),y:tag('int',100),z:tag('int',1),IsFrontText:tag('byte',1),FrontText:tag('compound',{Text:tag('string','工程小屋\n1b'),SignTextColor:tag('int',-16777216),IgnoreLighting:tag('byte',0)}),BackText:tag('compound',{Text:tag('string','背面'),SignTextColor:tag('int',-16777216),IgnoreLighting:tag('byte',0)})}}});
  await command('setblock 5 101 6 frame ["facing_direction"=2]');
  await command('tp ArchiveQA 5.5 100 4.5');await command('replaceitem entity ArchiveQA slot.hotbar 0 diamond 1');click({x:5,y:101,z:6},2);await delay(500);
  await command('tp @e[type=cow] 3 100 3');
  await command('setblock 1 101 6 diamond_block');await command('setblock 1 101 6 air destroy');await until(()=>drops.length>0);
  const project=await admin(`/api/servers/${server.id}/projects`,{requestId:randomUUID(),action:'CREATE',name:'ModelQA',dimension:'minecraft:overworld',x1:0,z1:0,x2:7,z2:7});
  async function model(revision=1,projectId=project.projectId){let next=null;const parts=[];do{const r=await fetch(base+`/api/public/projects/${projectId}/phases/${revision}/model`+(next?'?after='+encodeURIComponent(next):''));assert.equal(r.status,200);const page=await r.json();parts.push(...page.sections);next=page.next;assert.ok(parts.length<1000);}while(next);return parts;}
  function block(parts,x,y,z,extra=false){const part=parts.find(p=>p.x<=x&&p.x+8>x&&p.y<=y&&p.y+8>y&&p.z<=z&&p.z+8>z);if(!part)return null;const index=(y-part.y)*64+(z-part.z)*8+(x-part.x);let cursor=0;const runs=extra?part.data.scene.extraRuns:part.data.runs;for(let i=0;i<runs.length;i+=2){cursor+=runs[i+1];if(index<cursor)return part.data.palette[runs[i]];}return null;}
  await until(async()=>block(await model(),1,100,1)?.name==='minecraft:diamond_block',90000);
  let parts=await model();assert.equal(block(parts,2,100,2).name,'minecraft:oak_stairs');assert.ok(block(parts,2,100,2).states.includes('states'));
  evidence.checks.push('real native scan records pre-existing blocks and states at their Y coordinates');
  console.log('QA: initial 3D capture ready');
  await until(async()=> {const data=await model();writeFileSync(path.join(qa,'scene-progress.json'),JSON.stringify(data.map(p=>p.data)));return data.some(p=>p.data.scene?.entities?.some(e=>e.type==='minecraft:armor_stand' && e.data.Armor?.some(i=>i.Name==='minecraft:diamond_helmet')))},90000);
  await until(async()=> (await model()).some(p=>p.data.scene?.entities?.some(e=>e.type==='minecraft:cow')),90000);
  const sceneParts=await model();
  writeFileSync(path.join(qa,'model-debug-sections.json'),JSON.stringify(sceneParts.map(p=>p.data)));
  const entities=sceneParts.flatMap(p=>p.data.scene?.entities??[]);
  assert.ok(entities.some(e=>e.type==='minecraft:cow'));assert.ok(entities.every(e=>!['minecraft:item','minecraft:player'].includes(e.type)),'Dropped items and players must not enter the project scene');
  await until(async()=> (await model()).some(p=>p.data.scene?.blockEntities?.some(b=>b.data.FrontText?.Text?.includes('工程小屋'))),90000);
  await until(async()=> (await model()).some(p=>p.data.scene?.blockEntities?.some(b=>b.data.Item?.Name==='minecraft:diamond')),90000);
  assert.ok(sceneParts.every(p=>p.data.scene?.extraRuns?.length>=2));
  for(const part of sceneParts){const {biomePalette,biomeRuns}=part.data.scene;assert.ok(biomePalette?.length,"Actual biome palette missing");assert.ok(biomePalette.every(b=>/^minecraft:[a-z0-9_]+$/.test(b)&&b!=="minecraft:the_void"));assert.equal(biomeRuns.filter((_,i)=>i%2).reduce((a,b)=>a+b,0),512);}
  for(const entity of entities)for(const forbidden of ['Inventory','EnderChestInventory','OwnerNew'])assert.equal(entity.data[forbidden],undefined);
  evidence.biomes=[...new Set(sceneParts.flatMap(p=>p.data.scene.biomePalette))];
  const {verifyNetworkBiomes}=await import('./verify-network-biomes.mjs');
  evidence.biomeCellsCompared=verifyNetworkBiomes(sceneParts.map(p=>p.data),biomePackets,biomeDefinitions);
  assert.ok(evidence.biomeCellsCompared>=512,'Collector must match the biome data sent to the game client');
  evidence.checks.push('real BDS 1.26.61.1 biome names and 512-cell runs received and validated by backend');
  evidence.checks.push('real native scene captures cow, equipped armor stand, sign visual data and extra block layer without private inventory');
  console.log('QA: complete-scene capture fields ready');
  const updateStarted=Date.now();await command('setblock 1 100 1 air');
  await until(async()=>block(await model(),1,100,1)?.name==='minecraft:air',20000);
  evidence.removalLatencyMs=Date.now()-updateStarted;
  await command('setblock 1 100 1 gold_block');await until(async()=>block(await model(),1,100,1)?.name==='minecraft:gold_block',20000);
  evidence.checks.push('native block writes trigger incremental refresh; removal clears the previous voxel');
  await delay(1500);parts=await model();
  for(const p of parts){assert.ok(p.x>=0&&p.x<8&&p.z>=0&&p.z<8);}
  writeFileSync(path.join(qa,'model-real-sections.json'),JSON.stringify(parts.map(p=>p.data)));
  await admin(`/api/servers/${server.id}/projects`,{requestId:randomUUID(),action:'COMPLETE',projectId:project.projectId});
  const frozen=await model();await command('setblock 1 100 1 diamond_block');await delay(2000);assert.deepEqual(await model(),frozen);
  evidence.checks.push('completion freezes uploaded model despite subsequent world changes');
  if(process.env.MCM_SCENE_RUNNER){
    const prefix=`/api/public/projects/${project.projectId}/phases/1/scene`;
    const sceneState=await until(async()=>{const state=await(await fetch(base+prefix+'/status')).json();assert.notEqual(state.state,'FAILED',state.message);return state.state==='READY'?state:null;},150000);
    const scene=await(await fetch(base+prefix+'/'+sceneState.build+'/scene.json')).json();
    assert.ok(scene.issues.every(issue=>issue==="部分区域尚无群系记录，植物与水面采用默认配色"));
    assert.ok(scene.models.some(m=>m.x===1&&m.y===100&&m.z===5&&m.faces.some(f=>f.vertexColor&&f.vertexColor[1]>f.vertexColor[0])),"Grass block must receive a visible plant tint");
    for(const type of ['minecraft:cow','minecraft:armor_stand','minecraft:diamond_helmet'])assert.ok(scene.models.some(m=>m.type===type&&m.faces.length>0),'Missing '+type);
    for(const texture of new Set(scene.models.flatMap(m=>m.faces.map(f=>f.texture))))assert.equal((await fetch(base+prefix+'/'+sceneState.build+'/'+texture)).status,200);
    const exportPrefix=`/api/servers/${server.id}/projects/${project.projectId}/phases/1/scene-export`;
    assert.equal((await fetch(base+exportPrefix+'/status')).status,401);
    assert.equal((await fetch(base+exportPrefix+'/'+sceneState.build)).status,401);
    assert.equal((await fetch(base+prefix+'/'+sceneState.build+'/scene-building.glb')).status,404);
    for(const includeCreatures of [false,true]){
      const response=await request(exportPrefix+'/'+sceneState.build+'?includeCreatures='+includeCreatures);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);
      const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.toString('ascii',0,4),'glTF');assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);
      const document=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));assert.equal(document.extras.includesCreatures,includeCreatures);assert.ok(document.images.length>0);assert.ok(document.images.every(i=>i.bufferView!==undefined&&!i.uri));
      writeFileSync(path.join(qa,includeCreatures?'scene-all.glb':'scene-building.glb'),bytes);
    }
    evidence.checks.push('administrator downloads self-contained GLB with embedded textures; anonymous requests and public GLB paths are denied');
    const {verifyProjectScenePage}=await import('./verify-scene-page.mjs');
    await verifyProjectScenePage(base,project.projectId,cookies);
    evidence.checks.push('real captured scene bakes on the backend and renders in the public project page on desktop and mobile');
  }
  // Two isolated trays exercise actual flowing blocks, not just source identifiers in a synthetic palette.
  await command('tp ArchiveQA 23 104 4');await command('tickingarea add circle 23 100 4 1 flowqa');await command('gamerule dofiretick false');await command('gamerule randomtickspeed 0');await command('fill 16 99 0 31 103 8 glass');
  await command('fill 17 100 1 22 103 7 air');await command('fill 24 100 1 29 103 7 air');
  await command('setblock 18 100 2 flowing_water');await command('setblock 25 100 2 flowing_lava');
  await command('setblock 20 100 5 water');await command('setblock 20 100 5 oak_stairs');
  const fluids=await admin(`/api/servers/${server.id}/projects`,{requestId:randomUUID(),action:'CREATE',name:'FlowQA',dimension:'minecraft:overworld',x1:16,z1:0,x2:31,z2:8});
  await until(async()=>{const parts=await model(1,fluids.projectId);writeFileSync(path.join(qa,'fluid-progress.json'),JSON.stringify(parts));return block(parts,19,100,2)?.name?.includes('water')&&block(parts,26,100,2)?.name?.includes('lava')},90000);
  const fluidParts=await model(1,fluids.projectId);writeFileSync(path.join(qa,'fluid-real-sections.json'),JSON.stringify(fluidParts.map(p=>p.data)));
  assert.equal(block(fluidParts,20,100,5).name,'minecraft:oak_stairs');assert.match(block(fluidParts,20,100,5,true).name,/water/);
  assert.ok(block(fluidParts,19,100,2).states.includes('liquid_depth'));assert.ok(block(fluidParts,26,100,2).states.includes('liquid_depth'));
  await command('setblock 18 100 2 air');await command('setblock 25 100 2 air');await command('setblock 20 100 5 stone');await command('setblock 20 100 5 air');
  await until(async()=>{const parts=await model(1,fluids.projectId);writeFileSync(path.join(qa,'fluid-progress.json'),JSON.stringify(parts));return block(parts,19,100,2)?.name==='minecraft:air'&&block(parts,26,100,2)?.name==='minecraft:air'},90000);
  evidence.checks.push('real water and lava flowing beyond their sources and waterlogged stairs are captured with liquid depth; removed flows disappear after rescan');
  await admin(`/api/servers/${server.id}/projects`,{requestId:randomUUID(),action:'RESUME',projectId:project.projectId});
  await until(async()=>block(await model(2),1,100,1)?.name==='minecraft:diamond_block',90000);assert.deepEqual(await model(),frozen);
  evidence.checks.push('resumed project records new phase while previous model remains immutable');
  bot.close();await stopGame();assert.equal(block(await model(2),1,100,1)?.name,'minecraft:diamond_block');
  evidence.checks.push('public model remains readable while game is offline');
  writeFileSync(path.join(qa,'model-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:true,...evidence}));
}finally{
  bot?.close();await stopGame();await client?.close();await transport?.close();
  if(backend?.exitCode===null){backend.kill();await once(backend,'exit');}
  writeFileSync(path.join(qa,'model-backend.log'),backendLog);writeFileSync(path.join(qa,'model-game.log'),gameLog);
}
