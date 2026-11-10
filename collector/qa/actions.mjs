import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inputDriver } from './input-driver.mjs';

export async function verifyActions({bot,command,until,tool,serverId,playerKey,diagnostics,cache,reconnect,replayBatch}) {
  const query = () => tool('get_player_statistics',{serverId,playerKey});
  const value = (summary,key) => BigInt(summary.metrics.find(item=>item.key===key)?.value??'0');
  let driver=inputDriver(bot);
  const trackMarkers=new Set();
  function watchMarkers(client) { client.on('text',packet=>{
    for(const marker of ['QA_TRACK_FLOOR_READY','QA_TRACK_CLEAR_READY','QA_NETHER_FLOOR_READY','QA_NETHER_CLEAR_READY'])
      if(packet.message?.includes(marker)||packet.parameters?.includes(marker))trackMarkers.add(marker);
  }); } watchMarkers(bot);
  console.log(JSON.stringify({stage:'action-client-movement-handshake',data:Object.fromEntries(Object.entries(bot.startGameData).filter(([key])=>/tick|movement|authoritative/.test(key)))},(_key,value)=>typeof value==='bigint'?value.toString():value));
  async function execute(text) {command(text);await delay(250);}
  function text(message) {bot.queue('text',{category:'authored',type:'chat',needs_translation:false,source_name:bot.profile.name,xuid:'',platform_chat_id:'',has_filtered_message:false,message});}
  async function action(name,{sneak=false,sprint=false,expectSneak=sneak,expectSprint=sprint}={}) {
    const start=diagnostics().length, flags={start_sneak:'start_sneaking',stop_sneak:'stop_sneaking',start_sprint:'start_sprinting',stop_sprint:'stop_sprinting'};
    driver.setFlags([...(sneak?['sneaking','sneak_down','sneak_current_raw']:[]),...(sprint?['sprinting','up']:[])]);
    driver.input(undefined,undefined,undefined,{inputData:[flags[name],...(name==='start_sneak'?['sneak_pressed_raw']:name==='stop_sneak'?['sneak_released_raw']:[])]});
    await until(()=>diagnostics().slice(start).includes(`QA state: sneak=${expectSneak} sprint=${expectSprint} alive=true`));
  }
  await execute('gamemode creative ArchiveQA');
  await execute('tp ArchiveQA 0.5 100 0.5');
  bot.queue('serverbound_loading_screen',{type:2});
  await execute('tickingarea add -4 0 -4 4 128 256 ArchiveActionQA true');
  for(let attempt=0;attempt<20;attempt++) {
    await execute('fill -4 99 -4 4 99 256 stone');await execute('fill -4 100 -4 4 104 256 air');
    await execute('execute if block 0 99 256 stone run say QA_TRACK_FLOOR_READY');
    await execute('execute if block 0 100 1 air run say QA_TRACK_CLEAR_READY');
    if(trackMarkers.size===2)break;
    await delay(500);
  }
  assert.equal(trackMarkers.size,2,'The actual client must receive both loaded, unobstructed game track confirmations');
  driver.setGrounded(true);
  await action('stop_sneak');await action('stop_sprint');await delay(400);
  const before=await query(), begin=(await tool('get_recent_activity',{serverId})).highWatermark;
  const delta=async key=>value(await query(),key)-value(before,key);
  const waitDelta=async(key,expected)=>until(async()=>await delta(key)===BigInt(expected));
  // The first start and first active stop are cancelled by the separate QA mod.
  await action('start_sneak',{expectSneak:false});await delay(400);assert.equal(await delta('actions.sneak_starts'),0n);
  await action('start_sneak',{sneak:true});await waitDelta('actions.sneak_starts',1);
  await action('start_sneak',{sneak:true});await delay(400);assert.equal(await delta('actions.sneak_starts'),1n);
  await delay(1100);await action('stop_sneak',{sneak:true,expectSneak:true});await delay(500);
  await action('stop_sneak');await until(async()=>await delta('actions.sneak_millis')>=1500n);
  const sneaked=await delta('actions.sneak_millis');await action('stop_sneak');await delay(700);assert.equal(await delta('actions.sneak_millis'),sneaked);
  console.log(JSON.stringify({stage:'actual-sneak-start-stop-cancellation-and-dedup',millis:sneaked.toString()}));

  await execute('gamemode survival ArchiveQA');await execute('effect ArchiveQA saturation 10 255 true');await execute('effect ArchiveQA instant_health 1 255 true');
  await action('start_sprint',{sprint:true});await waitDelta('actions.sprint_starts',1);
  await action('start_sprint',{sprint:true});await delay(5200);
  assert.equal(await delta('actions.sprint_starts'),1n);
  assert.equal([...diagnostics().matchAll(/QA state: sneak=(true|false) sprint=(true|false) alive=(true|false)/g)].at(-1)?.[2],'true','Game sprint state must still be active at its checkpoint');
  const checkpoint=await delta('actions.sprint_millis');assert.ok(checkpoint>=4500n,'An active sprint must be checkpointed before stopping');
  await action('stop_sprint');await until(async()=>await delta('actions.sprint_millis')>checkpoint);
  const sprinted=await delta('actions.sprint_millis');await action('stop_sprint');await delay(600);assert.equal(await delta('actions.sprint_millis'),sprinted);
  console.log(JSON.stringify({stage:'actual-sprint-checkpoint-and-dedup',checkpoint:checkpoint.toString(),millis:sprinted.toString()}));

  for (const mode of ['sneak','sprint']) {
    await action(mode==='sneak'?'start_sneak':'start_sprint',{[mode]:true});
    await waitDelta(`actions.${mode}_starts`,2);await delay(900);
    // Drain the client's held-state packets before the server-side setter.
    // Otherwise a queued, genuine start can race the setter and re-enter sneak.
    driver.setPaused(true);await delay(300);
    const start=diagnostics().length;text('[QA] force action stop');
    await until(()=>diagnostics().slice(start).includes(`before=${mode==='sneak'},${mode==='sprint'} after=false,false`));
    driver.setFlags([]);driver.setPaused(false);
    await until(async()=>await delta(`actions.${mode}_millis`)>(mode==='sneak'?sneaked:sprinted));
  }

  await action('start_sprint',{sprint:true});await waitDelta('actions.sprint_starts',3);await delay(1000);
  let offlineMillis;
  bot=await reconnect(async()=>{
    offlineMillis=await delta('actions.sprint_millis');await delay(1200);
    assert.equal(await delta('actions.sprint_millis'),offlineMillis,'Offline time must not grow action duration');
  });
  watchMarkers(bot);driver=inputDriver(bot);driver.setGrounded(true);await execute('gamemode survival ArchiveQA');await action('stop_sneak');await action('stop_sprint');
  assert.equal(await delta('actions.sprint_starts'),3n);
  console.log(JSON.stringify({stage:'actual-active-sprint-disconnect',millis:offlineMillis.toString()}));

  const jumps=()=>[...diagnostics().matchAll(/QA jump event (\d+): cancelled=(true|false)/g)];
  for(let attempt=0;attempt<8&&jumps().length<3;attempt++) {
    await execute('tp ArchiveQA 0.5 100 0.5');await delay(500);
    const pos={...driver.position,x:driver.position.x+0.05,y:driver.position.y+0.42,z:driver.position.z+0.05};
    driver.input(undefined,undefined,undefined,{inputData:['jumping','start_jumping'],position:pos,delta:{x:0.05,y:0.42,z:0.05}});
    await delay(350);
    if(jumps().length===1)assert.equal(await delta('actions.jumps'),0n);
  }
  assert.ok(jumps().length>=3,'Real input must trigger the pinned LeviLamina jump event');
  const acceptedJumps=jumps().filter(match=>match[2]==='false').length;
  await waitDelta('actions.jumps',acceptedJumps);
  driver.input(undefined,undefined,undefined,{position:{...driver.position,y:driver.position.y+0.42}});await delay(400);
  assert.equal(await delta('actions.jumps'),BigInt(acceptedJumps));
  for(const action_id of ['swing_arm','swing_arm','wake_up','swing_arm'])bot.queue('animate',{action_id,runtime_entity_id:bot.entityId,data:0,has_swing_source:false});
  await waitDelta('actions.swings',3);
  console.log(JSON.stringify({stage:'actual-jump-swing-events',jumpEvents:jumps().length,cancelledJumps:1,acceptedJumps,swings:3}));

  const netherQuery=()=>tool('get_player_statistics',{serverId,playerKey,dimension:'minecraft:nether'});
  const beforeNether=value(await netherQuery(),'actions.sneak_millis');
  const sessionBeforeTransfer=(await tool('get_player_context',{serverId,playerKey})).sessions[0].sessionId;
  await execute('gamemode creative ArchiveQA');await action('start_sneak',{sneak:true});await waitDelta('actions.sneak_starts',3);
  let transferCount=driver.changes.length;
  await execute('execute in nether run tp ArchiveQA 0.5 100 0.5');
  await until(()=>driver.changes.length>transferCount&&driver.changes.at(-1).dimension===1,45000);
  // A solid/low Nether landing can legitimately prevent standing up.
  // Prepare room for the actual stop instead of treating that refusal as loss.
  await execute('execute in nether run tickingarea add -4 0 -4 4 127 4 ArchiveActionNetherQA true');
  for(let attempt=0;attempt<20;attempt++) {
    await execute('execute in nether run fill -3 99 -3 3 99 3 stone');
    await execute('execute in nether run fill -3 100 -3 3 104 3 air');
    await execute('execute in nether if block 0 99 0 stone run say QA_NETHER_FLOOR_READY');
    await execute('execute in nether if block 0 102 0 air run say QA_NETHER_CLEAR_READY');
    if(trackMarkers.has('QA_NETHER_FLOOR_READY')&&trackMarkers.has('QA_NETHER_CLEAR_READY'))break;
    await delay(500);
  }
  assert.ok(trackMarkers.has('QA_NETHER_FLOOR_READY')&&trackMarkers.has('QA_NETHER_CLEAR_READY'),'The Nether landing must be loaded and have actual headroom');
  await delay(1500);await action('stop_sneak');
  const netherMillis=await until(async()=>{const delta=value(await netherQuery(),'actions.sneak_millis')-beforeNether;return delta>=900n?delta:null;});
  transferCount=driver.changes.length;
  await execute('execute in overworld run tp ArchiveQA 0.5 100 0.5');
  await until(()=>driver.changes.length>transferCount&&driver.changes.at(-1).dimension===0,45000);
  assert.equal((await tool('get_player_context',{serverId,playerKey})).sessions[0].sessionId,sessionBeforeTransfer);
  console.log(JSON.stringify({stage:'actual-active-sneak-dimension-transfer',netherMillis:netherMillis.toString(),sameSession:true}));

  await execute('gamemode survival ArchiveQA');await execute('setblock 0 100 3 stone');await execute('setblock 0 101 3 stone');
  const beforeCollision=await delta('actions.sprint_millis');
  await action('start_sprint',{sprint:true});await waitDelta('actions.sprint_starts',4);
  await until(()=>[...diagnostics().matchAll(/QA state: sneak=(true|false) sprint=(true|false) alive=(true|false)/g)].at(-1)?.[2]==='false');
  await until(async()=>await delta('actions.sprint_millis')>beforeCollision);
  const collided=await delta('actions.sprint_millis');await delay(800);assert.equal(await delta('actions.sprint_millis'),collided);
  await action('stop_sprint');await execute('setblock 0 100 3 air');await execute('setblock 0 101 3 air');
  console.log(JSON.stringify({stage:'actual-collision-stops-sprint',millis:(collided-beforeCollision).toString()}));

  const deathStarts=await delta('actions.sneak_starts')+1n;
  await execute('tp ArchiveQA 0.5 100 0.5');await action('start_sneak',{sneak:true});await waitDelta('actions.sneak_starts',deathStarts);
  await execute('gamemode survival ArchiveQA');await delay(900);
  const beforeDeath=await delta('actions.sneak_millis');
  await execute('damage ArchiveQA 1000 fall');driver.setFlags([]);
  await until(async()=>value(await query(),'deaths')===value(before,'deaths')+1n);
  await until(async()=>await delta('actions.sneak_millis')>beforeDeath);
  const ended=await delta('actions.sneak_millis');await delay(1200);assert.equal(await delta('actions.sneak_millis'),ended,'Dead time must not grow action duration');

  const activity=await tool('get_recent_activity',{serverId,playerKey,after:begin,limit:200});assert.equal(activity.hasMore,false);
  const actions=activity.items.filter(item=>item.metric?.startsWith('actions.'));
  const final=await query(), keys=['actions.jumps','actions.swings','actions.sneak_starts','actions.sneak_millis','actions.sprint_starts','actions.sprint_millis'];
  for(const key of keys) {
    const sum=actions.filter(item=>item.metric===key).reduce((total,item)=>total+BigInt(item.value),0n);
    assert.equal(sum,value(final,key)-value(before,key));
    assert.ok(final.metrics.find(item=>item.key===key).measurements.some(item=>item.quality==='EXACT'&&item.algorithmVersion==='native-action-state-v1'));
  }
  const actionIds=new Set(actions.map(item=>item.eventId));assert.equal(actionIds.size,actions.length);
  const cached=readdirSync(cache).filter(name=>name.endsWith('.pending')).map(file=>JSON.parse(readFileSync(path.join(cache,file),'utf8')).body);
  const batches=cached.filter(body=>JSON.parse(body).events.some(event=>actionIds.has(event.eventId)));
  const events=batches.flatMap(body=>JSON.parse(body).events).filter(event=>actionIds.has(event.eventId));
  assert.equal(events.length,actions.length);
  for(const key of keys)assert.equal(events.filter(event=>event.metric===key).reduce((sum,event)=>sum+BigInt(event.value),0n),await delta(key));
  const replay=await replayBatch(batches[0]);assert.equal(replay.duplicateBatch,true);assert.equal(replay.acceptedEvents,0);
  const afterReplay=await query();for(const key of keys)assert.equal(value(afterReplay,key),value(final,key));
  await execute('tickingarea remove ArchiveActionQA');
  await execute('execute in nether run tickingarea remove ArchiveActionNetherQA');
  return {testTrackPrepared:true,cancelledSneakStartAndStopExcluded:true,repeatedStartsAndStopsDeduplicated:true,sprintCheckpointBeforeStop:true,
    forcedSetterStopsSettled:true,activeDisconnectSettled:true,offlineTimeExcluded:true,actualDeathSettled:true,deadTimeExcluded:true,
    activeDimensionTransferSettled:true,netherSneakMillis:netherMillis.toString(),dimensionTransferPreservesSession:true,collisionStopsSettled:true,
    jumpEvents:jumps().length,cancelledJumps:1,acceptedJumps,swings:3,nonJumpInputAndOtherAnimationsExcluded:true,
    originalNativeSumsMatchMcp:true,nativeBatchReplayDeduplicated:true,algorithmVersion:'native-action-state-v1',
    increments:Object.fromEntries(keys.map(key=>[key,(value(final,key)-value(before,key)).toString()])),
    totals:Object.fromEntries(keys.map(key=>[key,value(final,key).toString()]))};
}
