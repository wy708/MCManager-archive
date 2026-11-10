import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {inputDriver} from './input-driver.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';

export async function verifyPlacement({bot,command,until,diagnostics,tool,serverId,playerKey,cache,replayBatch}) {
  const updates=new Map(),markers=new Set(),inventory=new Map();let snapshots=0;
  const key=p=>`${p.x},${p.y},${p.z}`;
  bot.on('update_block',packet=>updates.set(key(packet.position),packet.block_runtime_id));
  bot.on('text',packet=>{if(packet.message?.includes('QA_PLACEMENT_READY')||packet.parameters?.includes('QA_PLACEMENT_READY'))markers.add('ready');});
  bot.on('inventory_slot',packet=>{if(['inventory',0].includes(packet.window_id))inventory.set(packet.slot,packet.item);});
  bot.on('inventory_content',packet=>{if(['inventory',0].includes(packet.window_id)){packet.input.forEach((item,slot)=>inventory.set(slot,item));snapshots++;}});
  const driver=inputDriver(bot),query=()=>tool('get_player_statistics',{serverId,playerKey});
  const value=data=>BigInt(data.metrics.find(metric=>metric.key==='blocks.placed')?.value??'0');
  const initial=value(await query());
  const start=(await tool('get_recent_activity',{serverId})).highWatermark;
  let expected=0;const cases=[];
  async function execute(text){command(text);await delay(200);}
  function chat(message){bot.queue('text',{category:'authored',type:'chat',needs_translation:false,source_name:bot.profile.name,xuid:'',platform_chat_id:'',has_filtered_message:false,message});}
  async function sync(){const before=snapshots;chat('[QA] sync inventory');await until(()=>snapshots>before);}
  async function equip(type,count=3){await execute(`replaceitem entity ArchiveQA slot.hotbar 0 ${type} ${count}`);await sync();assert.equal(inventory.get(0).count,count);bot.queue('player_hotbar',{selected_slot:0,window_id:'inventory',select_slot:true});await delay(200);}
  function use(pos){const runtime=updates.get(key(pos));assert.ok(runtime);driver.input(undefined,undefined,{legacy:{legacy_request_id:0},actions:[],data:{action_type:'click_block',trigger_type:'player_input',block_position:pos,face:1,hotbar_slot:0,hand:'main_hand',held_item:inventory.get(0),player_pos:{...driver.position},click_pos:{x:0.5,y:1,z:0.5},block_runtime_id:runtime,client_prediction:'success',client_cooldown_state:'off'}});}
  async function marker(conditions){markers.clear();await until(async()=>{await execute(`execute ${conditions} run say QA_PLACEMENT_READY`);return markers.has('ready');});}
  async function setBlock(p,type){await execute(`setblock ${p.x} ${p.y} ${p.z} air`);updates.delete(key(p));await execute(`setblock ${p.x} ${p.y} ${p.z} ${type}`);await until(()=>updates.get(key(p)));}
  async function check(name,increment){expected+=increment;await until(async()=>value(await query())-initial===BigInt(expected));cases.push({name,increment});console.log(JSON.stringify({stage:name,placedDelta:expected}));}
  async function unchanged(name){await delay(800);assert.equal(value(await query())-initial,BigInt(expected),name);cases.push({name,increment:0});console.log(JSON.stringify({stage:name,placedDelta:expected}));}
  await execute('gamemode creative ArchiveQA');await execute('tp ArchiveQA 0.5 100 0.5');bot.queue('serverbound_loading_screen',{type:2});driver.setGrounded(true);
  await execute('fill -1 99 -1 4 99 5 stone');await execute('fill -1 100 -1 4 104 5 air');await execute('clear ArchiveQA');await execute('gamemode survival ArchiveQA');
  await equip('wooden_door');await setBlock({x:2,y:99,z:1},'stone');use({x:2,y:99,z:1});
  await marker('if block 2 100 1 wooden_door if block 2 101 1 wooden_door');await sync();assert.equal(inventory.get(0).count,2);
  await delay(1200);console.log(JSON.stringify({stage:'real-two-cell-door',placedDelta:(value(await query())-initial).toString(),nativeDiagnostics:diagnostics().split('\n').filter(line=>line.includes('QA block use')).slice(-1)}));
  if(process.argv.includes('--probe-placement'))return {probeOnly:true};
  await check('survival-door-two-cells',2);
  const door={x:2,y:100,z:1};use(door);await marker('if block 2 100 1 wooden_door ["open_bit"=true]');await sync();assert.equal(inventory.get(0).count,2);await unchanged('opening-existing-door-excluded');
  await execute('gamemode creative ArchiveQA');await equip('wooden_door');await setBlock({x:3,y:99,z:1},'stone');use({x:3,y:99,z:1});await marker('if block 3 100 1 wooden_door if block 3 101 1 wooden_door if block 2 100 1 wooden_door if block 2 101 1 wooden_door');await sync();assert.equal(inventory.get(0).count,3);await check('creative-adjacent-door-only-new-cells',2);
  await execute('gamemode survival ArchiveQA');await equip('bed',1);await setBlock({x:0,y:99,z:2},'stone');use({x:0,y:99,z:2});await marker('if block 0 100 2 bed if block 0 100 3 bed');await sync();assert.equal(inventory.get(0).count,0);await check('survival-bed-two-cells',2);
  await equip('sunflower');await setBlock({x:3,y:99,z:0},'grass_block');use({x:3,y:99,z:0});await marker('if block 3 100 0 sunflower if block 3 101 0 sunflower');await sync();assert.equal(inventory.get(0).count,2);await check('two-cell-flower',2);
  await equip('oak_slab');await setBlock({x:0,y:99,z:1},'stone');use({x:0,y:99,z:1});await marker('if block 0 100 1 oak_slab');await sync();assert.equal(inventory.get(0).count,2);await check('single-slab',1);
  use({x:0,y:100,z:1});await marker('if block 0 100 1 oak_double_slab');await sync();assert.equal(inventory.get(0).count,1);await check('slab-merge-one-cell',1);
  await equip('snow_layer');await setBlock({x:2,y:99,z:2},'stone');use({x:2,y:99,z:2});await marker('if block 2 100 2 snow_layer');await sync();assert.equal(inventory.get(0).count,2);await check('single-snow-layer',1);
  use({x:2,y:100,z:2});await marker('if block 2 100 2 snow_layer ["height"=1]');await sync();assert.equal(inventory.get(0).count,1);await check('same-type-snow-layer-state-change',1);
  await equip('stone');await setBlock({x:0,y:99,z:4},'grass_block');await setBlock({x:0,y:100,z:4},'short_grass');use({x:0,y:100,z:4});await marker('if block 0 100 4 stone');await sync();assert.equal(inventory.get(0).count,2);await check('replaceable-grass-one-cell',1);
  await equip('wooden_door');await setBlock({x:1,y:99,z:0},'stone');use({x:1,y:99,z:0});await marker('if block 1 100 0 air if block 1 101 0 air');await sync();assert.equal(inventory.get(0).count,3);assert.match(diagnostics(),/QA cancellations|QA block use/);await unchanged('plugin-cancelled-door-excluded');
  await setBlock({x:2,y:101,z:3},'stone');await setBlock({x:2,y:99,z:3},'stone');use({x:2,y:99,z:3});await marker('if block 2 100 3 air if block 2 101 3 stone');await sync();assert.equal(inventory.get(0).count,3);await unchanged('obstructed-door-excluded');
  await execute('fill 0 100 2 0 101 3 air');await setBlock({x:0,y:100,z:3},'stone');await equip('bed',1);use({x:0,y:99,z:2});await marker('if block 0 100 2 air if block 0 100 3 stone');await sync();assert.equal(inventory.get(0).count,1);await unchanged('obstructed-bed-excluded');
  await equip('wooden_door');await setBlock({x:4,y:99,z:2},'stone');chat('[QA] cancel next door upper write');await until(()=>diagnostics().includes('QA door upper cancellation armed'));use({x:4,y:99,z:2});await until(()=>diagnostics().includes('QA door upper write cancelled'));await marker('if block 4 100 2 wooden_door if block 4 101 2 air');await sync();assert.equal(inventory.get(0).count,2);console.log(JSON.stringify({stage:'actual-upper-write-cancelled',remainingItem:inventory.get(0).count,delta:(value(await query())-initial).toString()}));await check('partial-door-only-one-committed-cell',1);
  await execute('gamemode adventure ArchiveQA');await equip('stone');await setBlock({x:4,y:99,z:0},'stone');use({x:4,y:99,z:0});await marker('if block 4 100 0 air');await sync();assert.equal(inventory.get(0).count,3);await unchanged('adventure-denied-excluded');
  await execute('setblock 4 100 4 stone');await unchanged('console-world-changes-excluded');await execute('gamemode creative ArchiveQA');
  const final=await query(),metric=final.metrics.find(metric=>metric.key==='blocks.placed');assert.equal(value(final)-initial,14n);assert.ok(metric.measurements.some(item=>item.quality==='EXACT'&&item.algorithmVersion==='native-placement-v2'));
  const activity=await tool('get_recent_activity',{serverId,playerKey,after:start,limit:200});assert.equal(activity.hasMore,false);
  const events=activity.items.filter(event=>event.metric==='blocks.placed'),ids=new Set(events.map(event=>event.eventId));assert.equal(ids.size,14);assert.equal(events.length,14);
  const originals=readdirSync(cache).filter(name=>name.endsWith('.pending')).map(name=>JSON.parse(readFileSync(path.join(cache,name),'utf8')).body);
  const native=originals.flatMap(body=>JSON.parse(body).events).filter(event=>ids.has(event.eventId));assert.equal(native.length,14);
  const subjects=Object.fromEntries([...new Set(native.map(event=>event.subject))].map(subject=>[subject,native.filter(event=>event.subject===subject).reduce((sum,event)=>sum+Number(event.value),0)]));
  console.log(JSON.stringify({stage:'native-placement-subjects',subjects}));
  assert.deepEqual(subjects,{'minecraft:wooden_door':5,'minecraft:bed':2,'minecraft:sunflower':2,'minecraft:oak_slab':1,'minecraft:oak_double_slab':1,'minecraft:snow_layer':2,'minecraft:stone':1});
  const replay=await replayBatch(originals.find(body=>JSON.parse(body).events.some(event=>ids.has(event.eventId))));assert.equal(replay.duplicateBatch,true);assert.equal(replay.acceptedEvents,0);assert.equal(value(await query()),value(final));
  return {cases,placed:14,originalNativeSubjects:subjects,originalNativeSumsMatchMcp:true,nativeBatchReplayDeduplicated:true,total:metric.value,quality:'EXACT',algorithmVersion:'native-placement-v2'};
}
