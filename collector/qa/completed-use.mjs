import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {inputDriver} from './input-driver.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';

export async function verifyCompletedUses({bot,command,until,diagnostics,tool,serverId,playerKey,cache,replayBatch}) {
  const inventory=new Map();let snapshots=0;
  const blocks=new Map(),markers=new Set(),projectiles=new Map(),armor=new Map();
  const posKey=pos=>`${pos.x},${pos.y},${pos.z}`;
  bot.on('update_block',packet=>blocks.set(posKey(packet.position),packet.block_runtime_id));
  bot.on('text',packet=>{for(const marker of ['QA_USE_HOE_READY','QA_BUCKET_FILLED','QA_BUCKET_POURED'])if(packet.message?.includes(marker)||packet.parameters?.includes(marker))markers.add(marker);});
  bot.on('add_entity',packet=>projectiles.set(packet.entity_type,(projectiles.get(packet.entity_type)??0)+1));
  bot.on('mob_armor_equipment',packet=>{if(String(packet.runtime_entity_id)===String(bot.entityId))armor.set(0,packet.helmet);});
  const attributes=new Map();bot.on('update_attributes',packet=>{if(String(packet.runtime_entity_id)===String(bot.entityId))for(const item of packet.attributes)attributes.set(item.name,item.current);});
  bot.on('inventory_slot',packet=>{if(['inventory',0].includes(packet.window_id))inventory.set(packet.slot,packet.item);if(packet.window_id==='armor')armor.set(packet.slot,packet.item);});
  bot.on('inventory_content',packet=>{if(['inventory',0].includes(packet.window_id)){packet.input.forEach((item,slot)=>inventory.set(slot,item));snapshots++;}if(packet.window_id==='armor')packet.input.forEach((item,slot)=>armor.set(slot,item));});
  const driver=inputDriver(bot);
  const query=()=>tool('get_player_statistics',{serverId,playerKey});
  const value=data=>BigInt(data.metrics.find(metric=>metric.key==='items.used')?.value??'0');
  const initial=value(await query());
  const begin=(await tool('get_recent_activity',{serverId})).highWatermark;
  const used=async()=>value(await query())-initial;
  const waitUsed=expected=>until(async()=>await used()===BigInt(expected));
  async function execute(text){command(text);await delay(200);}
  function chat(message){bot.queue('text',{category:'authored',type:'chat',needs_translation:false,source_name:bot.profile.name,xuid:'',platform_chat_id:'',has_filtered_message:false,message});}
  async function sync(){const before=snapshots;chat('[QA] sync inventory');await until(()=>snapshots>before);}
  async function equip(type,count){await execute(`replaceitem entity ArchiveQA slot.hotbar 0 ${type} ${count}`);await sync();assert.equal(inventory.get(0).count,count);bot.queue('player_hotbar',{selected_slot:0,window_id:'inventory',select_slot:true});await delay(200);}
  function use(action_type='click_air',pos={x:0,y:100,z:1},runtime=0){driver.input(undefined,undefined,{legacy:{legacy_request_id:0},actions:[],data:{action_type,trigger_type:'player_input',block_position:pos,face:1,hotbar_slot:0,hand:'main_hand',held_item:inventory.get(0),player_pos:{...driver.position},click_pos:{x:0.5,y:1,z:0.5},block_runtime_id:runtime,client_prediction:'success',client_cooldown_state:'off'}});}
  function release(action_type='release'){bot.queue('inventory_transaction',{transaction:{legacy:{legacy_request_id:0},transaction_type:'item_release',actions:[],transaction_data:{action_type,hotbar_slot:0,held_item:inventory.get(0),head_pos:{...driver.position}}}});}
  async function select(slot,type){bot.queue('player_hotbar',{selected_slot:slot,window_id:'inventory',select_slot:true});bot.queue('mob_equipment',{runtime_entity_id:bot.entityId,item:inventory.get(slot),slot,selected_slot:slot,window_id:'inventory'});await delay(200);const start=diagnostics().length;chat('[QA] selected item');await until(()=>diagnostics().slice(start).includes(`QA selected item: type=minecraft:${type}`));}
  async function setBlock(pos,type){await execute(`setblock ${pos.x} ${pos.y} ${pos.z} air`);blocks.delete(posKey(pos));await execute(`setblock ${pos.x} ${pos.y} ${pos.z} ${type}`);return until(()=>blocks.get(posKey(pos)));}
  async function marker(command,expected){markers.delete(expected);await until(async()=>{await execute(command);return markers.has(expected);});}
  const callbacks=()=>[...diagnostics().matchAll(/QA committed use callback: type=([^ ]+) method=(\d+) consume=(true|false) before=(\d+) after=(\d+)/g)].map(match=>({type:match[1],method:Number(match[2]),consume:match[3]==='true',before:Number(match[4]),after:Number(match[5])}));
  await execute('gamemode creative ArchiveQA');await execute('tp ArchiveQA 0.5 100 0.5');bot.queue('serverbound_loading_screen',{type:2});await delay(500);
  await execute('fill 0 99 0 4 99 4 stone');await execute('fill 0 100 0 4 104 4 air');driver.setGrounded(true);
  await execute('clear ArchiveQA');await execute('difficulty peaceful');await execute('gamerule domobspawning false');await execute('gamemode survival ArchiveQA');
  if(process.argv.includes('--probe-use-bow')) {
    await execute('gamemode creative ArchiveQA');await equip('bow',1);use();await delay(1100);release();await delay(600);await sync();
    console.log(JSON.stringify({stage:'isolated-creative-bow-probe',used:(await used()).toString(),arrows:projectiles.get('minecraft:arrow')??0}));
    return {probeOnly:true,bowDiagnosticOnly:true};
  }
  if(process.argv.includes('--probe-use-tools')) {
    await equip('iron_hoe',1);const dirt={x:0,y:99,z:2};use('click_block',dirt,await setBlock(dirt,'dirt'));await delay(700);await sync();
    console.log(JSON.stringify({stage:'isolated-tool-probe',used:(await used()).toString(),item:inventory.get(0)}));
    use('click_block',dirt,blocks.get(posKey(dirt)));await delay(700);
    return {probeOnly:true,toolDiagnosticOnly:true};
  }
  await execute('effect ArchiveQA saturation 5 20 true');await until(()=>attributes.get('minecraft:player.hunger')===20);await equip('apple',3);use();await delay(2000);await sync();assert.equal(inventory.get(0).count,2);assert.equal(callbacks().length,1);
  console.log(JSON.stringify({stage:'actual-full-hunger-food-game-accepted',observedHunger:20}));
  await until(async()=>await used()===1n);
  await execute('difficulty normal');await execute('effect ArchiveQA clear');await execute('effect ArchiveQA hunger 5 100 true');await until(()=>attributes.get('minecraft:player.hunger')<18);await execute('effect ArchiveQA clear');
  await equip('apple',3);use();await delay(250);release();await delay(2000);await sync();assert.equal(inventory.get(0).count,3);assert.equal(callbacks().length,1);
  console.log(JSON.stringify({stage:'actual-food-release-interrupted'}));
  assert.equal(await used(),1n);
  await execute('replaceitem entity ArchiveQA slot.hotbar 1 diamond 1');await sync();use();await delay(250);await select(1,'diamond');await delay(2000);await sync();assert.equal(inventory.get(0).count,3);assert.equal(callbacks().length,1);assert.equal(await used(),1n);await select(0,'apple');
  console.log(JSON.stringify({stage:'actual-food-slot-switch-interrupted'}));
  use();await delay(2200);await sync();assert.equal(inventory.get(0).count,2);assert.equal(callbacks().length,2);assert.equal(callbacks()[1].method,1);
  console.log(JSON.stringify({stage:'actual-food-completed',callbacks:callbacks()}));
  await waitUsed(2);
  for(let i=0;i<3;i++)bot.queue('completed_using_item',{used_item_id:inventory.get(0).network_id,use_method:'eat'});
  await delay(600);await sync();assert.equal(inventory.get(0).count,2);assert.equal(callbacks().length,2);assert.equal(await used(),2n);
  console.log(JSON.stringify({stage:'repeated-client-completion-notifications-excluded'}));
  await execute('effect ArchiveQA hunger 30 100 true');await until(()=>attributes.get('minecraft:player.hunger')<18);await execute('effect ArchiveQA clear');await equip('apple',3);chat('[QA] cancel next food completion');await until(()=>diagnostics().includes('QA food completion cancellation armed'));use();await until(()=>diagnostics().includes('QA food completion cancelled'));await sync();assert.equal(inventory.get(0).count,3);assert.equal(await used(),2n);
  console.log(JSON.stringify({stage:'actual-plugin-cancelled-food-completion-excluded'}));
  await equip('diamond',1);use();await delay(600);assert.equal(await used(),2n);
  await equip('snowball',3);use();await until(()=>diagnostics().includes('QA first snowball use cancelled'));await delay(500);await sync();assert.equal(inventory.get(0).count,3);assert.equal(await used(),2n);
  use();await delay(700);await sync();assert.equal(inventory.get(0).count,2);assert.equal(projectiles.get('minecraft:snowball'),1);await waitUsed(3);
  await equip('stone',3);const floor={x:0,y:99,z:1};use('click_block',floor,await setBlock(floor,'stone'));await waitUsed(4);await sync();assert.equal(inventory.get(0).count,2);
  const denied={x:1,y:99,z:0};use('click_block',denied,await setBlock(denied,'stone'));await delay(500);await sync();assert.equal(inventory.get(0).count,2);assert.equal(await used(),4n);
  await execute('gamemode creative ArchiveQA');await equip('snowball',3);use();await delay(700);await sync();assert.equal(inventory.get(0).count,3);assert.equal(projectiles.get('minecraft:snowball'),2);await waitUsed(5);await execute('gamemode survival ArchiveQA');
  console.log(JSON.stringify({stage:'instant-creative-and-block-uses-confirmed',successfulUses:5}));
  const dirt={x:0,y:99,z:2};await equip('iron_hoe',1);use('click_block',dirt,await setBlock(dirt,'dirt'));await marker('execute if block 0 99 2 farmland run say QA_USE_HOE_READY','QA_USE_HOE_READY');await waitUsed(6);
  use('click_block',dirt,await until(()=>blocks.get(posKey(dirt))));await delay(500);assert.equal(await used(),6n);
  const gate={x:2,y:100,z:0};await setBlock(gate,'fence_gate');await delay(250);const closedGate=blocks.get(posKey(gate));use('click_block',gate,closedGate);await until(()=>blocks.get(posKey(gate))!==closedGate);await delay(500);assert.equal(await used(),6n,'Opening a gate must not count as using the held hoe');
  await execute('gamemode creative ArchiveQA');use('click_block',dirt,await setBlock(dirt,'dirt'));await marker('execute if block 0 99 2 farmland run say QA_USE_HOE_READY','QA_USE_HOE_READY');await waitUsed(7);await execute('gamemode survival ArchiveQA');
  const water={x:2,y:100,z:1};await equip('bucket',1);const bucketId=inventory.get(0).network_id;use('click_block',water,await setBlock(water,'water'));await marker('execute if block 2 100 1 air run say QA_BUCKET_FILLED','QA_BUCKET_FILLED');await sync();assert.notEqual(inventory.get(0).network_id,bucketId);await waitUsed(8);
  const pour={x:2,y:99,z:3};use('click_block',pour,await setBlock(pour,'stone'));await marker('execute if block 2 100 3 water run say QA_BUCKET_POURED','QA_BUCKET_POURED');await sync();assert.equal(inventory.get(0).network_id,bucketId);await waitUsed(9);
  await equip('iron_helmet',1);const helmetId=inventory.get(0).network_id;use();await delay(700);await sync();assert.equal(inventory.get(0).count,0);await until(()=>armor.get(0)?.network_id===helmetId);await waitUsed(10);
  await equip('bow',1);await execute('replaceitem entity ArchiveQA slot.hotbar 1 air');use();await delay(900);release();await delay(500);assert.equal(await used(),10n);assert.equal(projectiles.get('minecraft:arrow')??0,0);
  await execute('replaceitem entity ArchiveQA slot.hotbar 1 arrow 3');await sync();use();await delay(1100);release();await delay(600);await sync();assert.equal(inventory.get(1).count,2);assert.equal(projectiles.get('minecraft:arrow'),1);await waitUsed(11);
  const bowDamage=inventory.get(0).extra?.nbt?.nbt?.value?.Damage?.value;assert.equal(typeof bowDamage,'number');
  await execute('gamemode creative ArchiveQA');await execute('replaceitem entity ArchiveQA slot.hotbar 1 air');await sync();use();await delay(1100);release();await delay(600);await sync();assert.equal(inventory.get(1).count,0);assert.equal(inventory.get(0).extra?.nbt?.nbt?.value?.Damage?.value,bowDamage);assert.equal(projectiles.get('minecraft:arrow'),2);await waitUsed(12);
  console.log(JSON.stringify({stage:'tool-bucket-armor-and-charged-shot-confirmed',successfulUses:12}));
  await execute('difficulty peaceful');
  const final=await query(),metric=final.metrics.find(metric=>metric.key==='items.used');
  assert.equal(value(final)-initial,12n);assert.ok(metric.measurements.some(item=>item.quality==='EXACT'&&item.algorithmVersion==='native-item-confirmed-v2'));
  const activity=await tool('get_recent_activity',{serverId,playerKey,after:begin,limit:200});assert.equal(activity.hasMore,false);
  const events=activity.items.filter(event=>event.metric==='items.used'),ids=new Set(events.map(event=>event.eventId));assert.equal(ids.size,12);assert.equal(events.length,12);
  const original=readdirSync(cache).filter(name=>name.endsWith('.pending')).map(name=>JSON.parse(readFileSync(path.join(cache,name),'utf8')).body);
  const native=original.flatMap(body=>JSON.parse(body).events).filter(event=>ids.has(event.eventId));assert.equal(native.length,12);
  const subjects=Object.fromEntries([...new Set(native.map(event=>event.subject))].map(subject=>[subject,native.filter(event=>event.subject===subject).reduce((sum,event)=>sum+Number(event.value),0)]));
  assert.deepEqual(subjects,{'minecraft:apple':2,'minecraft:snowball':2,'minecraft:stone':1,'minecraft:iron_hoe':2,'minecraft:bucket':1,'minecraft:water_bucket':1,'minecraft:iron_helmet':1,'minecraft:bow':2});
  assert.equal(events.reduce((sum,event)=>sum+BigInt(event.value),0n),12n);
  const replay=await replayBatch(original.find(body=>JSON.parse(body).events.some(event=>ids.has(event.eventId))));assert.equal(replay.duplicateBatch,true);assert.equal(replay.acceptedEvents,0);assert.equal(value(await query()),value(final));
  return {peacefulFullHungerActuallyConsumed:true,releaseInterrupted:true,slotSwitchInterrupted:true,completedFood:true,repeatedCompletionNotificationsExcluded:true,pluginCancelledCompletionExcluded:true,instantAndCreativeUses:true,toolAndBucketChanges:true,gateInteractionNotCountedAsToolUse:true,armorEquipped:true,survivalChargedShotOnlyWithAmmo:true,creativeChargedShotWithoutAmmoOrDamage:true,successfulUses:12,originalNativeSubjects:subjects,originalNativeSumsMatchMcp:true,nativeBatchReplayDeduplicated:true,total:metric.value,quality:'EXACT',algorithmVersion:'native-item-confirmed-v2',callbacks:callbacks()};
}
