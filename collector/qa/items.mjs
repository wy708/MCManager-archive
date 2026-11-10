import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { inputDriver } from './input-driver.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';

export async function verifyItems({bot,command,until,diagnostics,tool,serverId,playerKey,cache,replayBatch}) {
  const inventory=new Map();
  let snapshots=0, projectiles=0;
  const blocks=new Map(),positionKey=pos=>`${pos.x},${pos.y},${pos.z}`;
  bot.on('inventory_slot',packet=>{if(['inventory',0].includes(packet.window_id))inventory.set(packet.slot,packet.item);});
  bot.on('inventory_content',packet=>{if(['inventory',0].includes(packet.window_id)){packet.input.forEach((item,slot)=>inventory.set(slot,item));snapshots++;}});
  bot.on('add_entity',packet=>{if(packet.entity_type==='minecraft:snowball')projectiles++;});
  bot.on('update_block',packet=>blocks.set(positionKey(packet.position),packet.block_runtime_id));
  const driver=inputDriver(bot);
  async function execute(text){command(text);await delay(150);}
  function chat(message){bot.queue('text',{category:'authored',type:'chat',needs_translation:false,source_name:bot.profile.name,xuid:'',platform_chat_id:'',has_filtered_message:false,message});}
  async function sync(){const before=snapshots;chat('[QA] sync inventory');await until(()=>snapshots>before);}
  const query=()=>tool('get_player_statistics',{serverId,playerKey});
  const value=(data,key)=>BigInt(data.metrics.find(metric=>metric.key===key)?.value??'0');
  const before=await query(),begin=(await tool('get_recent_activity',{serverId})).highWatermark;
  const delta=async key=>value(await query(),key)-value(before,key);
  async function waitDelta(key,expected){await until(async()=>await delta(key)===BigInt(expected));}
  async function inspect(type,count,remaining){const start=diagnostics().length;chat('[QA] inspect pickup');await until(()=>diagnostics().slice(start).includes(`type=minecraft:${type} inventory=${count} remaining=${remaining}`));}
  await execute('gamemode creative ArchiveQA');await execute('tp ArchiveQA 0.5 100 0.5');
  bot.queue('serverbound_loading_screen',{type:2});await delay(500);
  await execute('fill 0 99 0 4 99 4 stone');await execute('fill 0 100 0 4 104 4 air');
  await execute('kill @e[type=item]');await execute('clear ArchiveQA');
  driver.setGrounded(true);await execute('gamemode survival ArchiveQA');
  chat('[QA] spawn pickup diamonds');
  await until(()=>diagnostics().includes('QA pickup take: type=minecraft:diamond'));
  await sync();await until(()=>[...inventory.values()].some(item=>item.count===11));
  const diamondId=[...inventory.values()].find(item=>item.count===11).network_id;
  const diamonds=()=>[...inventory.values()].filter(item=>item.network_id===diamondId).reduce((sum,item)=>sum+item.count,0);
  assert.equal(diamonds(),11);await waitDelta('items.picked_up',11);console.log(JSON.stringify({stage:'actual-full-item-pickup',diamonds:diamonds()}));
  await execute('clear ArchiveQA');
  for(let i=0;i<9;i++)await execute(`replaceitem entity ArchiveQA slot.hotbar ${i} stone 64`);
  for(let i=0;i<27;i++)await execute(`replaceitem entity ArchiveQA slot.inventory ${i} stone 64`);
  await execute('replaceitem entity ArchiveQA slot.hotbar 0 diamond 60');await until(()=>diamonds()===60);
  chat('[QA] spawn pickup diamonds');await until(()=>diagnostics().includes('inventoryAfter=64'));await sync();await until(()=>diamonds()===64);
  await delay(1000);assert.equal(diamonds(),64);await inspect('diamond',64,7);await waitDelta('items.picked_up',15);console.log(JSON.stringify({stage:'actual-partial-item-pickup',diamonds:diamonds()}));
  assert.match(diagnostics(),/QA pickup take: type=minecraft:diamond org=11 itemBefore=11 inventoryBefore=60 inventoryAfter=64 result=false/);
  await execute('replaceitem entity ArchiveQA slot.inventory 26 air');await until(()=>diagnostics().includes('inventoryAfter=71'));await sync();await until(()=>diamonds()===71);
  await waitDelta('items.picked_up',22);
  console.log(JSON.stringify({stage:'actual-remainder-item-pickup',diamonds:diamonds()}));
  chat('[QA] spawn pickup dirt');await delay(1200);await inspect('dirt',0,5);assert.equal(await delta('items.picked_up'),22n);await execute('kill @e[type=item]');
  await execute('clear ArchiveQA');chat('[QA] spawn pickup emeralds');await until(()=>diagnostics().includes('QA emerald pickup cancelled'));await delay(500);await inspect('emerald',0,7);assert.equal(await delta('items.picked_up'),22n);await execute('kill @e[type=item]');
  console.log(JSON.stringify({stage:'actual-full-inventory-and-cancelled-pickups-excluded'}));
  const empty={network_id:0,count:0,metadata:0,has_stack_id:false,block_runtime_id:0,extra:{has_nbt:'false',can_place_on:[],can_destroy:[]}};
  function use(action='click_air',pos={x:0,y:100,z:1},runtime=0){
    driver.input(undefined,undefined,{legacy:{legacy_request_id:0},actions:[],data:{action_type:action,trigger_type:'player_input',block_position:pos,face:1,hotbar_slot:0,hand:'main_hand',held_item:inventory.get(0)??empty,player_pos:{...driver.position},click_pos:{x:0.5,y:1,z:0.5},block_runtime_id:runtime,client_prediction:'success',client_cooldown_state:'off'}});
  }
  async function equip(type,count){await execute(`replaceitem entity ArchiveQA slot.hotbar 0 ${type} ${count}`);await sync();assert.equal(inventory.get(0).count,count);bot.queue('player_hotbar',{selected_slot:0,window_id:'inventory',select_slot:true});await delay(150);}
  await sync();use();await delay(600);assert.equal(await delta('items.use_requests'),0n);
  await equip('diamond',1);use();await waitDelta('items.use_requests',1);await sync();assert.equal(inventory.get(0).count,1);
  await equip('snowball',3);use();await until(()=>diagnostics().includes('QA first snowball use cancelled'));await waitDelta('items.use_requests',2);await delay(500);await sync();assert.equal(inventory.get(0).count,3);assert.equal(projectiles,0);
  use();await waitDelta('items.use_requests',3);await delay(700);await sync();assert.equal(inventory.get(0).count,2);assert.equal(projectiles,1);
  await equip('stone',3);
  const floor={x:0,y:99,z:1};await execute('setblock 0 99 1 dirt');await execute('setblock 0 99 1 stone');
  const runtime=await until(()=>blocks.get(positionKey(floor)));use('click_block',floor,runtime);await waitDelta('items.use_requests',4);await delay(350);await sync();assert.equal(inventory.get(0).count,2);
  const cancelFloor={x:1,y:99,z:0};await execute('setblock 1 99 0 dirt');await execute('setblock 1 99 0 stone');
  use('click_block',cancelFloor,await until(()=>blocks.get(positionKey(cancelFloor))));await waitDelta('items.use_requests',5);await delay(500);await sync();assert.equal(inventory.get(0).count,2);
  assert.equal(await delta('items.picked_up'),22n,'Console inventory replacement is not item pickup');
  console.log(JSON.stringify({stage:'actual-item-use-requests',requests:5,cancelledSnowballExcludedFromConsumption:true,acceptedSnowballs:1}));
  const final=await query(),keys=['items.picked_up','items.use_requests'];
  assert.equal(value(final,'items.used')-value(before,'items.used'),2n,'Only the accepted snowball and block use should be confirmed');
  const feed=await tool('get_recent_activity',{serverId,playerKey,after:begin,limit:200});assert.equal(feed.hasMore,false);
  const events=feed.items.filter(item=>keys.includes(item.metric));
  const native=readdirSync(cache).filter(name=>name.endsWith('.pending')).map(name=>JSON.parse(readFileSync(path.join(cache,name),'utf8')).body);
  const ids=new Set(events.map(event=>event.eventId));assert.equal(ids.size,events.length);
  const nativeEvents=native.flatMap(body=>JSON.parse(body).events).filter(event=>ids.has(event.eventId));assert.equal(nativeEvents.length,events.length);
  for(const key of keys){const expected=await delta(key);assert.equal(events.filter(event=>event.metric===key).reduce((sum,event)=>sum+BigInt(event.value),0n),expected);assert.equal(nativeEvents.filter(event=>event.metric===key).reduce((sum,event)=>sum+BigInt(event.value),0n),expected);}
  const replay=await replayBatch(native.find(body=>JSON.parse(body).events.some(event=>ids.has(event.eventId))));assert.equal(replay.duplicateBatch,true);assert.equal(replay.acceptedEvents,0);
  const afterReplay=await query();for(const key of keys)assert.equal(value(afterReplay,key),value(final,key));
  return {fullPickup:11,partialPickup:4,partialPickupNativeReturn:false,remainderPickup:7,fullInventoryExcluded:true,cancelledPickupExcluded:true,actualClientInventory:true,useRequests:5,failedAndCancelledUseRequestsIncluded:true,successfulUses:2,requestsAndConfirmedUsesSeparated:true,emptyHandExcluded:true,consoleGivenItemsExcluded:true,actualSnowballConsumed:1,originalNativeSumsMatchMcp:true,nativeBatchReplayDeduplicated:true,totals:Object.fromEntries(keys.map(key=>[key,value(final,key).toString()]))};
}
