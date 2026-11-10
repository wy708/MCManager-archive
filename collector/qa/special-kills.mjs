import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {inputDriver} from './input-driver.mjs';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';

export async function verifySpecialKills({bot,command,until,diagnostics,tool,serverId,playerKey,reconnect}) {
  if(!process.argv.some(argument=>argument.startsWith('--probe-special-')))return verifySpecialAcceptance(arguments[0]);
  const actors=[],inventory=new Map();let snapshots=0;bot.on('add_entity',packet=>actors.push(packet));const driver=inputDriver(bot);
  bot.on('inventory_slot',packet=>{if(['inventory',0].includes(packet.window_id))inventory.set(packet.slot,packet.item);});bot.on('inventory_content',packet=>{if(['inventory',0].includes(packet.window_id)){packet.input.forEach((item,slot)=>inventory.set(slot,item));snapshots++;}});
  async function execute(text){command(text);await delay(250);}
  function chat(message){bot.queue('text',{category:'authored',type:'chat',needs_translation:false,source_name:bot.profile.name,xuid:'',platform_chat_id:'',has_filtered_message:false,message});}
  const query=()=>tool('get_player_statistics',{serverId,playerKey}),value=data=>BigInt(data.metrics.find(item=>item.key==='kills.mobs')?.value??'0');
  async function equip(type,count=1){await execute(`replaceitem entity ArchiveQA slot.hotbar 0 ${type} ${count}`);const before=snapshots;chat('[QA] sync inventory');await until(()=>snapshots>before);bot.queue('player_hotbar',{selected_slot:0,window_id:'inventory',select_slot:true});await delay(200);}
  function interact(target,action_type='attack'){bot.queue('inventory_transaction',{transaction:{legacy:{legacy_request_id:0},transaction_type:'item_use_on_entity',actions:[],transaction_data:{entity_runtime_id:target.runtime_id,action_type,hotbar_slot:0,held_item:inventory.get(0),player_pos:{...driver.position},click_pos:{x:0,y:1,z:0}}}});}
  await execute('gamemode creative ArchiveQA');await execute('execute in overworld run tp ArchiveQA 0.5 100 0.5');bot.queue('serverbound_loading_screen',{type:2});driver.setGrounded(true);await execute('gamerule mobgriefing false');await execute('gamerule domobspawning false');await execute('difficulty normal');await execute('fill -5 99 -5 8 99 8 bedrock');await execute('fill -5 100 -5 8 110 8 air');chat('[QA] enable kill diagnostics');await until(()=>diagnostics().includes('QA kill diagnostics enabled'));
  if(process.argv.includes('--probe-special-pet-offline')){
    await execute('tickingarea add circle 0 100 2 2 ArchiveSpecialQA true');await execute('kill @e[type=wolf]');await execute('kill @e[type=cow]');const initial=value(await query());let start=actors.length;await execute('summon wolf 2.5 100 0.5');const wolf=await until(()=>actors.slice(start).find(actor=>actor.entity_type==='minecraft:wolf'));await equip('bone',64);let tamed=false;
    for(let attempt=0;attempt<32&&!tamed;attempt++){interact(wolf,'interact');await delay(300);const offset=diagnostics().length;chat('[QA] inspect actor '+wolf.unique_id);await delay(200);tamed=diagnostics().slice(offset).includes('tame=true');}assert.equal(tamed,true);
    await equip('diamond');const offset=diagnostics().length;chat('[QA] inspect actor '+wolf.unique_id);await delay(200);if(diagnostics().slice(offset).includes('sitting=true')){interact(wolf,'interact');await delay(300);}
    start=actors.length;await execute('summon cow 0.5 100 2.5');await execute('effect @e[type=cow,c=1] slowness 30 255 true');const cow=await until(()=>actors.slice(start).find(actor=>actor.entity_type==='minecraft:cow'));const killedOffset=diagnostics().length;interact(cow);
    await until(async()=>{const offset=diagnostics().length;chat('[QA] inspect actor '+cow.unique_id);await delay(200);const state=diagnostics().slice(offset).match(/dead=false health=(\d+)/);return state&&Number(state[1])<9&&Number(state[1])>0;});
    bot=await reconnect(async()=>{await until(()=>diagnostics().slice(killedOffset).includes('QA mob death after: type=minecraft:cow'));});await delay(500);const increment=(value(await query())-initial).toString();console.log(JSON.stringify({stage:'actual-pet-after-owner-disconnect',increment,trace:diagnostics().slice(killedOffset).split(/\r?\n/).filter(line=>line.includes('QA ')||line.includes('disconnected')).slice(-20)}));await execute('kill @e[type=wolf]');await execute('tickingarea remove ArchiveSpecialQA');await execute('gamerule mobgriefing true');return {probeOnly:true,petOffline:true,increment};
  }
  const type=process.argv.includes('--probe-special-dragon')?'ender_dragon':process.argv.includes('--probe-special-slime')?'slime':'wither';
  await execute('tickingarea add circle 0 100 2 2 ArchiveSpecialQA true');await execute('kill @e[type='+type+']');const initial=value(await query()),offset=diagnostics().length,start=actors.length;await execute(`summon ${type} 0.5 100 2.5`);const target=await until(()=>actors.slice(start).find(actor=>actor.entity_type==='minecraft:'+type));
  if(type==='wither')await delay(13_000);
  chat('[QA] inspect actor '+target.unique_id);await delay(250);await execute(`damage @e[type=${type},c=1] 10000 override entity ArchiveQA`);
  if(process.argv.includes('--probe-special-offline'))bot=await reconnect(async()=>{await delay(13_000);});else await delay(13_000);
  chat('[QA] inspect actor '+target.unique_id);await delay(500);
  const increment=(value(await query())-initial).toString(),trace=diagnostics().slice(offset);console.log(JSON.stringify({stage:'special-console-source-diagnostic',type,uniqueId:String(target.unique_id),increment,trace:trace.split(/\r?\n/).filter(line=>line.includes('QA ')||line.includes('Applied damage')).slice(-35)}));
  await execute('kill @e[type='+type+']');await execute('tickingarea remove ArchiveSpecialQA');await execute('gamerule mobgriefing true');return {probeOnly:true,type,increment,controlledConsoleDamage:true};
}

async function verifySpecialAcceptance({bot,command,until,diagnostics,tool,serverId,playerKey,reconnect,cache,replayBatch,restartForPet}) {
  let driver=inputDriver(bot),snapshots=0,expected=0;const inventory=new Map(),actors=[],removed=new Set(),cases=[];
  function watch(client){client.on('add_entity',packet=>actors.push(packet));client.on('remove_entity',packet=>removed.add(String(packet.entity_id_self)));client.on('inventory_slot',packet=>{if(['inventory',0].includes(packet.window_id))inventory.set(packet.slot,packet.item);});client.on('inventory_content',packet=>{if(['inventory',0].includes(packet.window_id)){packet.input.forEach((item,slot)=>inventory.set(slot,item));snapshots++;}});}watch(bot);
  async function execute(text){command(text);await delay(250);}
  function chat(message){bot.queue('text',{category:'authored',type:'chat',needs_translation:false,source_name:bot.profile.name,xuid:'',platform_chat_id:'',has_filtered_message:false,message});}
  const query=dimension=>tool('get_player_statistics',{serverId,playerKey,...(dimension?{dimension}:{})}),value=(data,key='kills.mobs')=>BigInt(data.metrics.find(item=>item.key===key)?.value??'0');
  async function equip(type,count=1){await execute(`replaceitem entity ArchiveQA slot.hotbar 0 ${type} ${count}`);const before=snapshots;chat('[QA] sync inventory');await until(()=>snapshots>before);bot.queue('player_hotbar',{selected_slot:0,window_id:'inventory',select_slot:true});await delay(200);}
  function attack(target,action_type='attack'){bot.queue('inventory_transaction',{transaction:{legacy:{legacy_request_id:0},transaction_type:'item_use_on_entity',actions:[],transaction_data:{entity_runtime_id:target.runtime_id,action_type,hotbar_slot:0,held_item:inventory.get(0),player_pos:{...driver.position},click_pos:{x:0,y:1,z:0}}}});}
  async function inspect(target){const offset=diagnostics().length;chat('[QA] inspect actor '+target.unique_id);const state=await until(()=>diagnostics().slice(offset).match(new RegExp(`QA actor snapshot: id=${target.unique_id} type=([^ ]+) dead=(true|false) health=(-?\\d+) burning=(true|false) tame=(true|false) sitting=(true|false) owner=([^ ]+)`)));return {type:state[1],dead:state[2]==='true',health:Number(state[3]),tame:state[5]==='true',sitting:state[6]==='true',owner:state[7]};}
  async function spawn(type,{z=2.5,x=0.5,dimension}={}){const offset=actors.length;await execute(`${dimension?'execute in '+dimension+' run ':''}summon ${type} ${x} 100 ${z}`);return until(()=>actors.slice(offset).find(actor=>actor.entity_type==='minecraft:'+type));}
  function finalDeath(target,offset=0){return diagnostics().slice(offset).includes(`QA mob death after: type=${target.entity_type} id=${target.unique_id} dead=true`);}
  async function settle(name,increment){expected+=increment;await delay(800);await until(async()=>value(await query())-initial===BigInt(expected));assert.equal(value(await query(),'kills.players'),initialPlayers);cases.push({name,increment});console.log(JSON.stringify({stage:name,kills:expected}));}
  async function preparePlayer(){driver.setGrounded(true);await execute('gamemode creative ArchiveQA');await execute('execute in overworld run tp ArchiveQA 0.5 100 0.5');bot.queue('serverbound_loading_screen',{type:2});}
  async function leaveUntil(action){bot=await reconnect(action);driver=inputDriver(bot);watch(bot);await preparePlayer();}
  async function lethal(target,type){const offset=diagnostics().length;for(let attempt=0;attempt<12;attempt++){await execute(`tp @e[type=${type},c=1] 0.5 100 2.5`);attack(target);await delay(600);if(finalDeath(target,offset)||diagnostics().slice(offset).includes(`QA special death after: type=${target.entity_type} id=${target.unique_id} dead=true`))return offset;}throw new Error('Actual client could not deliver lethal damage to '+type);}
  await preparePlayer();await execute('gamerule mobgriefing false');await execute('gamerule domobspawning false');await execute('difficulty normal');await execute('tickingarea add circle 0 100 2 2 ArchiveSpecialQA true');await execute('fill -5 99 -5 8 99 8 bedrock');await execute('fill -5 100 -5 8 110 8 air');
  for(const type of ['wither','ender_dragon','slime','magma_cube','wolf','cow'])await execute('kill @e[type='+type+']');
  await execute('effect ArchiveQA clear');chat('[QA] enable kill diagnostics');await until(()=>diagnostics().includes('QA kill diagnostics enabled'));
  const initialData=await query(),initial=value(initialData),initialPlayers=value(initialData,'kills.players'),begin=(await tool('get_recent_activity',{serverId})).highWatermark;
  async function tameWolf() {
    const wolf = await spawn('wolf',{x:2.5,z:0.5});
    await equip('bone',64);
    for (let attempt=0;attempt<32;attempt++) {
      if (attempt % 4 === 0)
        await execute('execute as ArchiveQA run tp @e[type=wolf,c=1] 2.5 100 0.5');
      attack(wolf,'interact');
      await delay(300);
      const pet = await inspect(wolf);
      if (pet.tame) {
        assert.equal(pet.owner,'ArchiveQA');
        return {wolf,pet};
      }
    }
    assert.fail('Native wolf was never tamed by the actual player');
  }
  if (restartForPet) {
    const {wolf} = await tameWolf();
    await execute('tag @e[type=wolf,c=1] add ArchivePetRestartQA');
    assert.equal(value(await query()),initial);
    actors.length = 0;
    const {observer,...restart} = await restartForPet(watch);
    bot = observer;
    driver = inputDriver(bot);
    await execute('gamemode creative ArchivePetQA');
    await execute('execute in overworld run tp ArchivePetQA 0.5 100 0.5');
    bot.queue('serverbound_loading_screen',{type:2});
    driver.setGrounded(true);
    chat('[QA] enable kill diagnostics');
    await until(()=>diagnostics().includes('QA kill diagnostics enabled'));
    await until(()=>actors.some(actor=>actor.entity_type==='minecraft:wolf' && actor.unique_id===wolf.unique_id));
    assert.doesNotMatch(diagnostics(), /Player connected: ArchiveQA(?:,|\s|$)/);

    async function offlineDeath(replaceOwner) {
      const cow = await spawn('cow');
      await execute('effect @e[type=cow,c=1] slowness 30 255 true');
      const offset = diagnostics().length;
      chat(`[QA] offline wolf target ${wolf.unique_id} ${cow.unique_id} ${Number(replaceOwner)}`);
      const trace = await until(()=>diagnostics().slice(offset).match(new RegExp(
        `QA offline wolf target: wolf=${wolf.unique_id} cow=${cow.unique_id} owner=(-?\\d+) replaced=${replaceOwner} currentOwner=(-?\\d+) offline=true`)));
      if (replaceOwner) assert.notEqual(trace[1],trace[2]);
      else assert.equal(trace[1],trace[2]);
      await until(()=>finalDeath(cow,offset));
      assert.match(diagnostics().slice(offset), new RegExp(
        `QA mob death before: type=minecraft:cow id=${cow.unique_id} dead=false cause=entity_attack child=false parentId=${wolf.unique_id} `));
      return {victimId:String(cow.unique_id), ownerId:trace[1]};
    }
    const credited = await offlineDeath(false);
    await settle('saved-wolf-kill-after-real-game-process-restart',1);
    const rejected = await offlineDeath(true);
    assert.equal(rejected.ownerId,credited.ownerId);
    await settle('changed-native-owner-rejects-saved-credit',0);
    const result = await tool('get_recent_activity',{serverId,playerKey,after:begin,limit:200});
    assert.equal(result.hasMore,false);
    const kills = result.items.filter(event=>event.metric==='kills.mobs');
    assert.equal(kills.length,1);
    const originals = readdirSync(cache).filter(name=>name.endsWith('.pending'))
      .map(name=>JSON.parse(readFileSync(path.join(cache,name),'utf8')).body);
    const original = originals.find(body=>JSON.parse(body).events.some(event=>event.eventId===kills[0].eventId));
    assert.ok(original);
    const batch = JSON.parse(original);
    const algorithmVersion = batch.capabilities.find(cap=>cap.metric==='kills.mobs')?.algorithmVersion;
    assert.equal(algorithmVersion,'native-kill-source-v3');
    const native = batch.events.find(event=>event.eventId===kills[0].eventId);
    assert.equal(native.subject,'minecraft:cow');
    assert.equal(native.dimension,'minecraft:overworld');
    assert.equal(native.player.name,'ArchiveQA');
    assert.equal(native.value,1);
    assert.ok(Date.parse(native.playerObservedAt)<Date.parse(native.at));
    const replay = await replayBatch(original);
    assert.equal(replay.duplicateBatch,true);
    assert.equal(replay.acceptedEvents,0);
    assert.equal(value(await query())-initial,1n);
    await execute('kill @e[tag=ArchivePetRestartQA]');
    await execute('tickingarea remove ArchiveSpecialQA');
    await execute('gamerule mobgriefing true');
    const final = await query();
    return {cases,credited,rejected,wolfId:String(wolf.unique_id),bootId:batch.collector.bootId,...restart,
      algorithmVersion,increments:{'kills.mobs':1,'kills.players':0},
      originalNativeSubjects:{'kills.mobs':{'minecraft:cow':1}},
      totals:{'kills.mobs':value(final).toString(),'kills.players':value(final,'kills.players').toString()},
      ownerStayedOffline:true,originalNativeSumsMatchMcp:true,nativeBatchReplayDeduplicated:true};
  }
  await equip('diamond_sword');await execute('effect ArchiveQA strength 600 20 true');
  const wither=await spawn('wither');await delay(13_000);await execute('tp @e[type=wither,c=1] 0.5 100 2.5');const before=await inspect(wither);assert.ok(before.health>0&&!before.dead);
  let offset=diagnostics().length;chat('[QA] cancel next attack');await until(()=>diagnostics().slice(offset).includes('QA attack cancellation armed'));attack(wither);await until(()=>diagnostics().slice(offset).includes('QA lethal attack cancelled'));const untouched=await inspect(wither);assert.equal(untouched.dead,false);assert.equal(untouched.health,before.health);await settle('cancelled-wither-attack-does-not-create-pending-credit',0);
  offset=await lethal(wither,'wither');assert.equal((await inspect(wither)).dead,true);assert.equal(finalDeath(wither,offset),false);await settle('wither-animation-is-not-final-settlement',0);attack(wither);await settle('repeat-hit-during-wither-animation-is-not-a-second-kill',0);
  await leaveUntil(async()=>{await until(()=>finalDeath(wither,offset));const trace=diagnostics().slice(offset),left=trace.indexOf('Player disconnected: ArchiveQA'),final=trace.indexOf(`QA mob death before: type=minecraft:wither id=${wither.unique_id}`);assert.ok(left>=0&&final>left);await settle('wither-final-death-after-source-player-disconnected',1);});
  await equip('diamond_sword');await execute('effect ArchiveQA strength 600 20 true');const replaced=await spawn('wither');await delay(13_000);offset=await lethal(replaced,'wither');assert.equal((await inspect(replaced)).dead,true);chat('[QA] replace wither source '+replaced.unique_id);await until(()=>diagnostics().slice(offset).includes('QA wither source replaced:'));await settle('replaced-wither-source-not-counted-during-animation',0);await until(()=>finalDeath(replaced,offset));assert.match(diagnostics().slice(offset),new RegExp(`QA mob death before: type=minecraft:wither id=${replaced.unique_id} dead=false cause=fall`));await settle('replaced-final-damage-source-rejects-old-player-snapshot',0);
  const dragon=await spawn('ender_dragon');offset=await lethal(dragon,'ender_dragon');await until(()=>finalDeath(dragon,offset));await settle('actual-client-ender-dragon-kill',1);attack(dragon);await settle('repeated-dragon-corpse-hit-excluded',0);
  for(const type of ['slime','magma_cube']){
    await execute('fill -32 99 -32 32 99 32 bedrock');
    const parent=await spawn(type);const start=actors.length;offset=diagnostics().length;chat('[QA] large slime '+parent.unique_id);await until(()=>diagnostics().slice(offset).includes('QA actual large slime:'));offset=await lethal(parent,type);await until(()=>finalDeath(parent,offset));await settle('actual-large-'+type+'-death',1);
    const child=await until(()=>actors.slice(start).find(actor=>actor.entity_type==='minecraft:'+type&&String(actor.unique_id)!==String(parent.unique_id)));await execute(`effect @e[type=${type}] slowness 30 255 true`);await settle(type+'-child-spawn-is-not-a-kill',0);
    // Select this actual child explicitly; sibling entities are not damage targets.
    await execute(`tp ArchiveQA ${child.position.x} ${child.position.y} ${child.position.z-2}`);offset=diagnostics().length;for(let attempt=0;attempt<12&&!finalDeath(child,offset);attempt++){attack(child);await delay(650);}await until(()=>finalDeath(child,offset));await settle('actual-'+type+'-child-death',1);
    for(let pass=0;pass<3;pass++)await execute('kill @e[type='+type+']');await execute('tp ArchiveQA 0.5 100 0.5');
  }
  await execute('effect ArchiveQA clear');const {wolf,pet}=await tameWolf();await equip('diamond');if(pet.sitting){attack(wolf,'interact');await until(async()=>!(await inspect(wolf)).sitting);}
  const cow=await spawn('cow');await execute('effect @e[type=cow,c=1] slowness 30 255 true');offset=diagnostics().length;attack(cow);await until(async()=>{const state=await inspect(cow);return !state.dead&&state.health>0&&state.health<9;});await settle('actual-tamed-wolf-attack-has-not-yet-killed-target',0);
  await leaveUntil(async()=>{await until(()=>finalDeath(cow,offset));const trace=diagnostics().slice(offset);assert.ok(trace.indexOf('Player disconnected: ArchiveQA')>=0&&trace.indexOf(`QA mob death before: type=minecraft:cow id=${cow.unique_id}`)>trace.indexOf('Player disconnected: ArchiveQA'));await settle('actual-tamed-wolf-kill-after-owner-disconnected',1);});await execute('kill @e[type=wolf]');
  const netherBefore=await query('minecraft:nether'),overworldBefore=await query('minecraft:overworld');await execute('execute in nether run tp ArchiveQA 0.5 100 0.5');await until(()=>driver.changes.at(-1)?.dimension===1);await execute('execute in nether run fill -3 99 -3 5 99 6 bedrock');await execute('execute in nether run fill -3 100 -3 5 106 6 air');await equip('diamond_sword');await execute('effect ArchiveQA strength 30 20 true');const netherCow=await spawn('cow',{dimension:'nether'});offset=diagnostics().length;attack(netherCow);await until(()=>finalDeath(netherCow,offset));await settle('actual-nether-kill-uses-victim-dimension',1);assert.equal(value(await query('minecraft:nether'))-value(netherBefore),1n);assert.equal(value(await query('minecraft:overworld')),value(overworldBefore));await execute('execute in overworld run tp ArchiveQA 0.5 100 0.5');await until(()=>driver.changes.at(-1)?.dimension===0);await execute('effect ArchiveQA clear');await execute('tickingarea remove ArchiveSpecialQA');await execute('gamerule mobgriefing true');
  const final=await query(),activity=[];let cursor=begin;for(let page=0;page<100;page++){const result=await tool('get_recent_activity',{serverId,playerKey,after:cursor,limit:200});activity.push(...result.items);if(!result.hasMore)break;assert.notEqual(result.nextCursor,cursor);cursor=result.nextCursor;assert.ok(page<99);}
  const events=activity.filter(event=>event.metric==='kills.mobs'),ids=new Set(events.map(event=>event.eventId));assert.equal(events.length,8);assert.equal(ids.size,8);assert.equal(activity.some(event=>event.metric==='kills.players'),false);
  const original=readdirSync(cache).filter(name=>name.endsWith('.pending')).map(name=>JSON.parse(readFileSync(path.join(cache,name),'utf8')).body),native=original.flatMap(body=>JSON.parse(body).events).filter(event=>ids.has(event.eventId));assert.equal(native.length,8);
  const subjects=Object.fromEntries([...new Set(native.map(event=>event.subject))].map(subject=>[subject,native.filter(event=>event.subject===subject).reduce((sum,event)=>sum+Number(event.value),0)]));assert.deepEqual(subjects,{'minecraft:wither':1,'minecraft:ender_dragon':1,'minecraft:slime':2,'minecraft:magma_cube':2,'minecraft:cow':2});assert.equal(native.filter(event=>event.dimension==='minecraft:nether').length,1);assert.equal(native.filter(event=>event.dimension==='minecraft:overworld').length,7);assert.ok(final.metrics.find(item=>item.key==='kills.mobs').measurements.some(item=>item.algorithmVersion==='native-kill-source-v3'&&item.quality==='EXACT'));
  const replay=await replayBatch(original.find(body=>JSON.parse(body).events.some(event=>ids.has(event.eventId))));assert.equal(replay.duplicateBatch,true);assert.equal(replay.acceptedEvents,0);assert.equal(value(await query()),value(final));
  return {cases,increments:{'kills.mobs':8,'kills.players':0},originalNativeSubjects:{'kills.mobs':subjects},originalNativeSumsMatchMcp:true,nativeBatchReplayDeduplicated:true,totals:{'kills.mobs':value(final).toString(),'kills.players':value(final,'kills.players').toString()},quality:'EXACT',algorithmVersion:'native-kill-source-v3',witherSourceOfflineRetained:true,changedSourceRejected:true,petOwnerOfflineRetained:true,splitChildrenCountedOnlyAtDeath:true,netherKillDimensionVerified:true};
}
