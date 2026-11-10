import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {inputDriver} from './input-driver.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';

export async function verifyCrops({bot,command,until,diagnostics,tool,serverId,playerKey,cache,replayBatch}) {
  const updates=new Map(),inventory=new Map();let snapshots=0,markers=0;
  const key=p=>`${p.x},${p.y},${p.z}`;
  bot.on('update_block',packet=>updates.set(key(packet.position),packet.block_runtime_id));
  bot.on('text',packet=>{if(packet.message?.includes('QA_CROP_READY')||packet.parameters?.includes('QA_CROP_READY'))markers++;});
  bot.on('inventory_slot',packet=>{if(['inventory',0].includes(packet.window_id))inventory.set(packet.slot,packet.item);});
  bot.on('inventory_content',packet=>{if(['inventory',0].includes(packet.window_id)){packet.input.forEach((item,slot)=>inventory.set(slot,item));snapshots++;}});
  const driver=inputDriver(bot),query=()=>tool('get_player_statistics',{serverId,playerKey});
  const value=(data,metric)=>BigInt(data.metrics.find(item=>item.key===metric)?.value??'0');
  const initial=await query(),expected={'crops.planted':0,'crops.harvested':0,'crops.interacted':0,'blocks.mined':0};
  const start=(await tool('get_recent_activity',{serverId})).highWatermark;let requestId=-1;
  const cases=[];
  async function execute(text){command(text);await delay(200);}
  async function illuminate(){await execute('setblock -1 101 2 glowstone');await execute('setblock 1 101 2 glowstone');}
  function chat(message){bot.queue('text',{category:'authored',type:'chat',needs_translation:false,source_name:bot.profile.name,xuid:'',platform_chat_id:'',has_filtered_message:false,message});}
  async function sync(){const before=snapshots;chat('[QA] sync inventory');await until(()=>snapshots>before);}
  async function equip(type,count=3){await execute(`replaceitem entity ArchiveQA slot.hotbar 0 ${type} ${count}`);await sync();assert.equal(inventory.get(0).count,count);bot.queue('player_hotbar',{selected_slot:0,window_id:'inventory',select_slot:true});await delay(150);}
  async function setBlock(p,type){await execute(`setblock ${p.x} ${p.y} ${p.z} air`);updates.delete(key(p));if(type==='air')return;await execute(`setblock ${p.x} ${p.y} ${p.z} ${type}`);if(p.x===0&&p.z===2){const offset=diagnostics().length;chat('[QA] crop snapshot');const match=await until(()=>diagnostics().slice(offset).match(new RegExp(`QA crop snapshot: y=${p.y} type=([^ ]+) runtime=(\\d+)`)));assert.equal(match[1],'minecraft:'+type.split(' ')[0]);updates.set(key(p),Number(match[2])|0);}else await until(()=>updates.get(key(p)));}
  function use(pos,face=1){assert.ok(updates.get(key(pos)));driver.input(undefined,undefined,{legacy:{legacy_request_id:0},actions:[],data:{action_type:'click_block',trigger_type:'player_input',block_position:pos,face,hotbar_slot:0,hand:'main_hand',held_item:inventory.get(0),player_pos:{...driver.position},click_pos:{x:0.5,y:face===0?0:1,z:0.5},block_runtime_id:updates.get(key(pos)),client_prediction:'success',client_cooldown_state:'off'}});}
  function breakBlock(pos){driver.input([{action:'start_break',position:pos,face:1},{action:'predict_break',position:pos,face:1}],{request_id:requestId-=2,actions:[{type_id:'mine_block',legacy_type_id:11,hotbar_slot:0,predicted_durability:0,network_id:inventory.get(0)?.stack_id??0}],custom_names:[],cause:'chat_public'});}
  async function marker(conditions){const before=markers;await until(async()=>{await execute(`execute ${conditions} run say QA_CROP_READY`);return markers>before;});}
  async function check(name,metric,increment){if(metric)expected[metric]+=increment;await until(async()=>{const data=await query();return Object.entries(expected).every(([metric,total])=>value(data,metric)-value(initial,metric)===BigInt(total));});cases.push({name,metric,increment});console.log(JSON.stringify({stage:name,...expected}));}
  await execute('gamemode creative ArchiveQA');await execute('tp ArchiveQA 0.5 100 0.5');bot.queue('serverbound_loading_screen',{type:2});driver.setGrounded(true);
  await execute('fill -2 99 -1 4 99 5 stone');await execute('fill -2 100 1 4 104 5 air');await illuminate();await execute('kill @e[type=item]');await execute('clear ArchiveQA');await execute('time set noon');await execute('gamerule randomtickspeed 0');await execute('gamemode survival ArchiveQA');
  if(process.argv.includes('--probe-crop-occupied')) {
    await setBlock({x:0,y:99,z:2},'farmland');await setBlock({x:0,y:100,z:2},'stone');await equip('wheat_seeds');use({x:0,y:99,z:2});await marker('if block 0 100 2 stone');await execute('fill -1 100 1 1 103 3 air');await illuminate();await setBlock({x:0,y:99,z:2},'farmland');await setBlock({x:0,y:100,z:2},'wheat ["growth"=0]');use({x:0,y:99,z:2});await delay(700);await marker('if block 0 100 2 wheat ["growth"=0]');await sync();assert.equal(inventory.get(0).count,3);await check('occupied-and-existing-crop-probe',null,0);return {probeOnly:true};
  }
  if(process.argv.includes('--probe-crop-pitcher')) {
    await execute('gamemode creative ArchiveQA');await equip('diamond_hoe',1);await setBlock({x:0,y:99,z:2},'farmland');await setBlock({x:0,y:100,z:2},'pitcher_crop ["growth"=4,"upper_block_bit"=false]');await setBlock({x:0,y:101,z:2},'pitcher_crop ["growth"=4,"upper_block_bit"=true]');chat('[QA] crop snapshot');await delay(200);breakBlock({x:0,y:101,z:2});await marker('if block 0 100 2 air if block 0 101 2 air');await delay(1200);const data=await query();console.log(JSON.stringify({stage:'actual-pitcher-upper-break-probe',mined:(value(data,'blocks.mined')-value(initial,'blocks.mined')).toString(),harvested:(value(data,'crops.harvested')-value(initial,'crops.harvested')).toString()}));return {probeOnly:true};
  }
  const plants=[['wheat_seeds','wheat','farmland'],['carrot','carrots','farmland'],['potato','potatoes','farmland'],['beetroot_seeds','beetroot','farmland'],['nether_wart','nether_wart','soul_sand'],['pumpkin_seeds','pumpkin_stem','farmland'],['melon_seeds','melon_stem','farmland'],['torchflower_seeds','torchflower_crop','farmland'],['pitcher_pod','pitcher_crop','farmland'],['sweet_berries','sweet_berry_bush','grass_block']];
  for(const [seed,crop,soil] of plants){await execute('fill 0 100 2 0 103 2 air');await setBlock({x:0,y:99,z:2},soil);await equip(seed);use({x:0,y:99,z:2});await marker(`if block 0 100 2 ${crop}`);await sync();assert.equal(inventory.get(0).count,2);await check('planted-'+crop,'crops.planted',1);}
  await execute('fill 0 100 2 0 103 2 air');await setBlock({x:0,y:100,z:2},'jungle_log');await equip('cocoa_beans');use({x:0,y:100,z:2},3);await marker('if block 0 100 3 cocoa');await sync();assert.equal(inventory.get(0).count,2);await check('planted-cocoa','crops.planted',1);
  await execute('fill 0 100 2 0 103 3 air');await setBlock({x:0,y:103,z:2},'stone');await equip('glow_berries');use({x:0,y:103,z:2},0);await marker('if block 0 102 2 cave_vines');await sync();assert.equal(inventory.get(0).count,2);await check('planted-cave-vines','crops.planted',1);
  chat('[QA] crop snapshot');await delay(300);
  if(process.argv.includes('--probe-crops'))return {probeOnly:true,cases,planted:expected['crops.planted']};
  await execute('gamemode creative ArchiveQA');await equip('diamond_hoe',1);
  async function prepare(type,soil='farmland') {await execute('fill -1 100 1 1 103 3 air');await illuminate();await setBlock({x:0,y:99,z:2},soil);await setBlock({x:0,y:100,z:2},type);}
  async function harvest(name,type,ripe,soil='farmland') {await prepare(type,soil);breakBlock({x:0,y:100,z:2});await marker('if block 0 100 2 air');expected['blocks.mined']++;await check(name,'crops.harvested',ripe?1:0);}
  for(const type of ['wheat','carrots','potatoes','beetroot']) {
    await harvest('unripe-'+type,type+' ["growth"=6]',false);
    await harvest('mature-'+type,type+' ["growth"=7]',true);
  }
  await harvest('unripe-nether-wart','nether_wart ["age"=2]',false,'soul_sand');await harvest('mature-nether-wart','nether_wart ["age"=3]',true,'soul_sand');
  for(const age of [1,2]) {await execute('fill -1 100 1 1 103 3 air');await execute('fill -1 100 1 1 100 3 jungle_log');await setBlock({x:0,y:100,z:2},`cocoa ["age"=${age}]`);breakBlock({x:0,y:100,z:2});await marker('if block 0 100 2 air');expected['blocks.mined']++;await check('cocoa-age-'+age,'crops.harvested',age===2?1:0);}
  await harvest('mature-stem-is-not-fruit','pumpkin_stem ["growth"=7]',false);await harvest('mature-pumpkin','pumpkin',true,'stone');
  await harvest('mature-melon-stem-is-not-fruit','melon_stem ["growth"=7]',false);await harvest('mature-melon','melon_block',true,'stone');
  await harvest('unripe-torchflower','torchflower_crop ["growth"=1]',false);await harvest('mature-torchflower','torchflower',true,'grass_block');
  await harvest('unripe-pitcher','pitcher_crop ["growth"=2]',false);
  await prepare('pitcher_crop ["growth"=4,"upper_block_bit"=false]');await setBlock({x:0,y:101,z:2},'pitcher_crop ["growth"=4,"upper_block_bit"=true]');await marker('if block 0 100 2 pitcher_crop ["growth"=4] if block 0 101 2 pitcher_crop ["upper_block_bit"=true]');chat('[QA] crop snapshot');await delay(200);breakBlock({x:0,y:101,z:2});await marker('if block 0 100 2 air if block 0 101 2 air');expected['blocks.mined']+=2;await check('mature-pitcher-both-parts-on-upper-break','crops.harvested',2);
  await prepare('pitcher_crop ["growth"=4,"upper_block_bit"=false]');await setBlock({x:0,y:101,z:2},'pitcher_crop ["growth"=4,"upper_block_bit"=true]');breakBlock({x:0,y:100,z:2});await marker('if block 0 100 2 air if block 0 101 2 air');expected['blocks.mined']+=2;await check('mature-pitcher-both-parts-on-lower-break','crops.harvested',2);
  await prepare('pitcher_crop ["growth"=4,"upper_block_bit"=false]');await setBlock({x:0,y:101,z:2},'pitcher_crop ["growth"=4,"upper_block_bit"=true]');chat('[QA] replace next pitcher residual');await until(()=>diagnostics().includes('QA pitcher replacement armed'));breakBlock({x:0,y:101,z:2});await until(()=>diagnostics().includes('QA pitcher residual replaced: type=minecraft:stone'));await marker('if block 0 100 2 stone if block 0 101 2 air');expected['blocks.mined']++;await delay(1200);await check('intervening-replacement-invalidates-deferred-half','crops.harvested',1);
  await harvest('harvestable-but-not-fully-mature-bush','sweet_berry_bush ["growth"=2]',false,'grass_block');await harvest('fully-mature-bush','sweet_berry_bush ["growth"=3]',true,'grass_block');
  for(const type of ['cave_vines_head_with_berries','cave_vines_body_with_berries','cave_vines']) {await execute('fill -1 100 1 1 103 3 air');await setBlock({x:0,y:101,z:2},'stone');await setBlock({x:0,y:100,z:2},type);breakBlock({x:0,y:100,z:2});await marker('if block 0 100 2 air');expected['blocks.mined']++;await check('broken-'+type,'crops.harvested',type==='cave_vines'?0:1);}
  // Existing maturity, natural growth and fertilization are not new planting.
  await prepare('wheat ["growth"=6]');await execute('setblock 1 99 2 water');await execute('gamerule randomtickspeed 4096');await marker('if block 0 100 2 wheat ["growth"=7]');await execute('gamerule randomtickspeed 0');await check('actual-natural-growth-excluded',null,0);
  await prepare('air');await equip('wheat_seeds');use({x:0,y:99,z:2});await marker('if block 0 100 2 wheat ["growth"=0]');await sync();assert.equal(inventory.get(0).count,3);await check('creative-planting','crops.planted',1);
  await setBlock({x:0,y:100,z:2},'wheat ["growth"=6]');await equip('bone_meal');use({x:0,y:100,z:2});await marker('if block 0 100 2 wheat ["growth"=7]');await check('fertilization-is-not-planting',null,0);
  await execute('gamemode survival ArchiveQA');await equip('diamond_hoe',1);breakBlock({x:0,y:100,z:2});await marker('if block 0 100 2 air');driver.input([{action:'abort_break',position:{x:0,y:100,z:2},face:1}]);expected['blocks.mined']++;await check('survival-mature-wheat','crops.harvested',1);
  await execute('kill @e[type=item]');await delay(300);await equip('wheat_seeds');await setBlock({x:0,y:99,z:2},'stone');use({x:0,y:99,z:2});await marker('if block 0 100 2 air');await sync();assert.equal(inventory.get(0).count,3);await check('invalid-soil-excluded',null,0);
  await setBlock({x:0,y:99,z:2},'farmland');await setBlock({x:0,y:100,z:2},'stone');use({x:0,y:99,z:2});await marker('if block 0 100 2 stone');await sync();assert.equal(inventory.get(0).count,3);await check('occupied-planting-position-excluded',null,0);
  await prepare('wheat ["growth"=0]');use({x:0,y:99,z:2});await marker('if block 0 100 2 wheat ["growth"=0]');await sync();assert.equal(inventory.get(0).count,3);await check('existing-crop-is-not-new-planting',null,0);
  await setBlock({x:1,y:99,z:0},'farmland');use({x:1,y:99,z:0});await marker('if block 1 100 0 air');await sync();assert.equal(inventory.get(0).count,3);await check('plugin-cancelled-planting-excluded',null,0);
  await execute('gamemode adventure ArchiveQA');await execute('setblock 0 100 2 air');await setBlock({x:0,y:99,z:2},'farmland');use({x:0,y:99,z:2});await marker('if block 0 100 2 air');await sync();assert.equal(inventory.get(0).count,3);await check('adventure-planting-denied',null,0);
  await setBlock({x:0,y:100,z:2},'wheat ["growth"=7]');breakBlock({x:0,y:100,z:2});await delay(600);await marker('if block 0 100 2 wheat ["growth"=7]');await check('adventure-harvest-denied',null,0);
  await execute('gamemode creative ArchiveQA');await equip('diamond_hoe',1);await setBlock({x:2,y:99,z:0},'farmland');await setBlock({x:2,y:100,z:0},'wheat ["growth"=7]');breakBlock({x:2,y:100,z:0});await delay(600);await marker('if block 2 100 0 wheat ["growth"=7]');await check('plugin-cancelled-mature-harvest-excluded',null,0);
  await execute('gamemode survival ArchiveQA');await equip('diamond',1);
  for(const growth of [2,3]) {await prepare(`sweet_berry_bush ["growth"=${growth}]`,'grass_block');use({x:0,y:100,z:2});await marker('if block 0 100 2 sweet_berry_bush ["growth"=1]');await check('interacted-bush-stage-'+growth,'crops.interacted',1);use({x:0,y:100,z:2});await delay(500);await check('repeated-empty-bush-excluded',null,0);}
  for(const type of ['cave_vines_head_with_berries','cave_vines_body_with_berries']) {await execute('fill -1 100 1 1 103 3 air');await setBlock({x:0,y:101,z:2},'stone');await setBlock({x:0,y:100,z:2},type);use({x:0,y:100,z:2});await marker('if block 0 100 2 cave_vines');await check('interacted-'+type,'crops.interacted',1);use({x:0,y:100,z:2});await delay(500);await check('repeated-empty-vine-excluded',null,0);}
  await setBlock({x:2,y:99,z:1},'grass_block');await setBlock({x:2,y:100,z:1},'sweet_berry_bush ["growth"=3]');chat('[QA] cancel next berry interaction');await until(()=>diagnostics().includes('QA berry interaction cancellation armed'));use({x:2,y:100,z:1});await until(()=>diagnostics().includes('QA berry interaction cancelled'));await marker('if block 2 100 1 sweet_berry_bush ["growth"=3]');await check('plugin-cancelled-berry-harvest-excluded',null,0);
  await setBlock({x:0,y:100,z:2},'cave_vines_head_with_berries');const cancelStart=diagnostics().length;chat('[QA] cancel next berry interaction');await until(()=>diagnostics().slice(cancelStart).includes('QA berry interaction cancellation armed'));use({x:0,y:100,z:2});await until(()=>diagnostics().slice(cancelStart).includes('QA berry interaction cancelled'));await marker('if block 0 100 2 cave_vines_head_with_berries');await check('plugin-cancelled-glow-berry-harvest-excluded',null,0);
  await execute('gamerule randomtickspeed 3');
  const final=await query(),metrics=Object.keys(expected),totals=Object.fromEntries(metrics.map(metric=>[metric,value(final,metric).toString()]));
  const activity=await tool('get_recent_activity',{serverId,playerKey,after:start,limit:200});assert.equal(activity.hasMore,false);
  const events=activity.items.filter(event=>metrics.includes(event.metric)),ids=new Set(events.map(event=>event.eventId));assert.equal(ids.size,events.length);
  const used=activity.items.filter(event=>event.metric==='items.used');assert.equal(used.some(event=>event.subject==='minecraft:diamond'),false,'Holding a diamond while picking berries is not using the diamond');
  assert.equal(used.reduce((sum,event)=>sum+Number(event.value),0),14);
  const original=readdirSync(cache).filter(name=>name.endsWith('.pending')).map(name=>JSON.parse(readFileSync(path.join(cache,name),'utf8')).body);
  const native=original.flatMap(body=>JSON.parse(body).events).filter(event=>ids.has(event.eventId));assert.equal(native.length,events.length);
  const subjects=Object.fromEntries(metrics.map(metric=>[metric,Object.fromEntries([...new Set(native.filter(event=>event.metric===metric).map(event=>event.subject))].map(subject=>[subject,native.filter(event=>event.metric===metric&&event.subject===subject).reduce((sum,event)=>sum+Number(event.value),0)]))]));
  for(const metric of metrics){assert.equal(native.filter(event=>event.metric===metric).reduce((sum,event)=>sum+Number(event.value),0),expected[metric]);assert.ok(final.metrics.find(item=>item.key===metric).measurements.some(item=>item.quality==='EXACT'&&item.algorithmVersion===(metric==='blocks.mined'?'native-mining-v2':'native-crop-state-v1')));}
  console.log(JSON.stringify({stage:'native-crop-subjects',subjects,expected}));
  assert.deepEqual(subjects['crops.planted'],{'minecraft:wheat':2,'minecraft:carrots':1,'minecraft:potatoes':1,'minecraft:beetroot':1,'minecraft:nether_wart':1,'minecraft:pumpkin_stem':1,'minecraft:melon_stem':1,'minecraft:torchflower_crop':1,'minecraft:pitcher_crop':1,'minecraft:sweet_berry_bush':1,'minecraft:cocoa':1,'minecraft:cave_vines':1});
  assert.deepEqual(subjects['crops.harvested'],{'minecraft:wheat':2,'minecraft:carrots':1,'minecraft:potatoes':1,'minecraft:beetroot':1,'minecraft:nether_wart':1,'minecraft:cocoa':1,'minecraft:pumpkin':1,'minecraft:melon_block':1,'minecraft:torchflower':1,'minecraft:pitcher_crop':5,'minecraft:sweet_berry_bush':1,'minecraft:cave_vines':2});
  assert.deepEqual(subjects['crops.interacted'],{'minecraft:sweet_berry_bush':2,'minecraft:cave_vines':2});
  const replay=await replayBatch(original.find(body=>JSON.parse(body).events.some(event=>ids.has(event.eventId))));assert.equal(replay.duplicateBatch,true);assert.equal(replay.acceptedEvents,0);const afterReplay=await query();for(const metric of metrics)assert.equal(value(afterReplay,metric),value(final,metric));
  return {cases,increments:expected,originalNativeSubjects:subjects,originalNativeSumsMatchMcp:true,blockInteractionExcludedFromHeldItemUses:true,actualItemUses:14,nativeBatchReplayDeduplicated:true,totals,quality:'EXACT',algorithmVersion:'native-crop-state-v1'};
}
