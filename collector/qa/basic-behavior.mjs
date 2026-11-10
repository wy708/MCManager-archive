import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { inputDriver } from './input-driver.mjs';

export async function verifyBasicBehavior({ bot, command, until, tool, serverId, playerKey, deathByZombie = false }) {
  const query = () => tool('get_player_statistics', { serverId, playerKey });
  const value = (summary, key) => BigInt(summary.metrics.find(metric => metric.key === key)?.value ?? '0');
  const before = await query(); const updates = new Map(); let held;
  const activityStart = (await tool('get_recent_activity', { serverId })).highWatermark;
  let survival = false;
  const key = position => `${position.x},${position.y},${position.z}`;
  bot.on('update_block', packet => updates.set(key(packet.position), packet.block_runtime_id));
  bot.on('inventory_slot', packet => { if (['inventory', 0].includes(packet.window_id) && packet.slot === 0) held = packet.item; });
  bot.on('inventory_content', packet => { if (['inventory', 0].includes(packet.window_id)) held = packet.input[0]; });
  const empty = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0, extra: { has_nbt: 'false', can_place_on: [], can_destroy: [] } };
  const { position: actorPosition, input } = inputDriver(bot);
  let requestId = -1;
  async function consoleCommand(text) { command(text); await delay(250); }
  async function setBlock(position, name) {
    await consoleCommand(`setblock ${position.x} ${position.y} ${position.z} air`);
    updates.delete(key(position)); await consoleCommand(`setblock ${position.x} ${position.y} ${position.z} ${name}`);
    return until(() => updates.get(key(position)) !== undefined && updates.get(key(position)));
  }
  function use(action, position, runtime, item = empty) {
    if (action === 'break_block') {
      if (survival) {
        input([{ action: 'start_break', position, face: 1 }]);
        setTimeout(() => input([{ action: 'predict_break', position, face: 1 }], { request_id: requestId -= 2, actions: [{ type_id: 'mine_block', legacy_type_id: 11, hotbar_slot: 0, predicted_durability: 1, network_id: held?.stack_id ?? 0 }], custom_names: [], cause: 'chat_public' }), 1200).unref();
        return;
      }
      input([{ action: 'start_break', position, face: 1 }, { action: 'predict_break', position, face: 1 }],
        { request_id: requestId -= 2, actions: [{ type_id: 'mine_block', legacy_type_id: 11, hotbar_slot: 0, predicted_durability: 0, network_id: held?.stack_id ?? 0 }], custom_names: [], cause: 'chat_public' }); return;
    }
    input(undefined, undefined, { legacy: { legacy_request_id: 0 }, actions: [],
      data: { action_type: action, trigger_type: 'player_input', block_position: position, face: 1, hotbar_slot: 0, hand: 'main_hand', held_item: item,
        player_pos: actorPosition, click_pos: { x: 0.5, y: 1, z: 0.5 }, block_runtime_id: runtime, client_prediction: 'success', client_cooldown_state: 'off' } });
  }
  await consoleCommand('op ArchiveQA');
  await consoleCommand('kill @e[type=xp_orb]'); await consoleCommand('kill @e[type=item]');
  await consoleCommand('gamemode creative ArchiveQA');
  await consoleCommand('fill -3 99 -3 3 99 3 stone');
  await consoleCommand('tp ArchiveQA 0.5 100 0.5');
  bot.queue('serverbound_loading_screen', { type: 2 });
  await consoleCommand('replaceitem entity ArchiveQA slot.hotbar 0 diamond_pickaxe 1');
  await until(() => held?.count === 1); bot.queue('player_hotbar', { selected_slot: 0, window_id: 'inventory', select_slot: true });
  const targets = [{ x: 1, y: 100, z: 0 }, { x: 1, y: 100, z: 1 }, { x: 1, y: 100, z: -1 }];
  for (const [index, name] of ['stone', 'oak_log', 'diamond_ore'].entries()) {
    const position = targets[index]; const runtime = await setBlock(position, name); use('break_block', position, runtime);
    await delay(300); console.log(JSON.stringify({ stage: 'break-request-sent', runtimeBefore: runtime, runtimeAfter: updates.get(key(position)) }));
    await until(async () => value(await query(), 'blocks.mined') === value(before, 'blocks.mined') + BigInt(index + 1));
    console.log(JSON.stringify({ stage: 'native-mining-confirmed', block: name }));
  }
  const mined = await query(); assert.equal(BigInt(mined.woodBlocks), BigInt(before.woodBlocks ?? '0') + 1n); assert.equal(BigInt(mined.oreBlocks), BigInt(before.oreBlocks ?? '0') + 1n);
  use('break_block', targets[0], updates.get(key(targets[0])) ?? 0); await delay(600);
  await consoleCommand('gamemode adventure ArchiveQA');
  const denied = await setBlock(targets[0], 'stone'); use('break_block', targets[0], denied); await delay(800);
  assert.equal(value(await query(), 'blocks.mined'), value(before, 'blocks.mined') + 3n);
  await consoleCommand('gamemode survival ArchiveQA'); survival = true;
  const survivalBlock = { x: 0, y: 100, z: -1 }; const survivalRuntime = await setBlock(survivalBlock, 'stone'); use('break_block', survivalBlock, survivalRuntime);
  await until(async () => value(await query(), 'blocks.mined') === value(before, 'blocks.mined') + 4n);
  survival = false;
  await consoleCommand('gamemode creative ArchiveQA');
  const guarded = { x: 2, y: 100, z: 0 }; const guardedRuntime = await setBlock(guarded, 'stone');
  use('break_block', guarded, guardedRuntime); await delay(800);
  assert.equal(value(await query(), 'blocks.mined'), value(before, 'blocks.mined') + 4n);
  await consoleCommand('replaceitem entity ArchiveQA slot.hotbar 0 stone 8');
  await until(() => held?.count === 8);
  bot.queue('player_hotbar', { selected_slot: 0, window_id: 'inventory', select_slot: true });
  const floor = { x: 0, y: 99, z: 1 }, placed = { x: 0, y: 100, z: 1 };
  await consoleCommand(`setblock ${placed.x} ${placed.y} ${placed.z} air`);
  const floorRuntime = await setBlock(floor, 'stone');
  use('click_block', floor, floorRuntime, held);
  await until(async () => value(await query(), 'blocks.placed') === value(before, 'blocks.placed') + 1n);
  console.log(JSON.stringify({ stage: 'native-placement-confirmed' }));
  const guardedFloor = { x: -1, y: 99, z: 0 }; const guardedFloorRuntime = await setBlock(guardedFloor, 'stone');
  use('click_block', guardedFloor, guardedFloorRuntime, held); await delay(800);
  assert.equal(value(await query(), 'blocks.placed'), value(before, 'blocks.placed') + 1n);
  await consoleCommand('gamemode adventure ArchiveQA');
  use('click_block', { x: -1, y: 99, z: 1 }, floorRuntime, held); await delay(800);
  assert.equal(value(await query(), 'blocks.placed'), value(before, 'blocks.placed') + 1n);
  await consoleCommand('xp 13 ArchiveQA'); await delay(500);
  assert.equal(value(await query(), 'experience.gained'), value(before, 'experience.gained'));
  await consoleCommand('xp 17 ArchiveQA');
  await until(async () => value(await query(), 'experience.gained') === value(before, 'experience.gained') + 17n);
  await consoleCommand('xp -1L ArchiveQA'); await consoleCommand('xp 3 ArchiveQA');
  await until(async () => value(await query(), 'experience.gained') === value(before, 'experience.gained') + 20n);
  await consoleCommand('xp 1000 ArchiveQA');
  await until(async () => value(await query(), 'experience.gained') === value(before, 'experience.gained') + 1020n);
  await consoleCommand('xp 10000 ArchiveQA');
  await until(async () => value(await query(), 'experience.gained') === value(before, 'experience.gained') + 11020n);
  if (deathByZombie) { await consoleCommand('difficulty normal'); await consoleCommand('gamerule domobspawning false'); await consoleCommand('time set night'); await consoleCommand('kill @e[type=zombie]'); await consoleCommand('summon zombie 2 100 2'); }
  await consoleCommand('gamemode survival ArchiveQA');
  await consoleCommand(deathByZombie ? 'damage ArchiveQA 1000 entity_attack entity @e[type=zombie,c=1]' : 'damage ArchiveQA 1000 fall');
  await until(async () => value(await query(), 'deaths') === value(before, 'deaths') + 1n);
  const context = await tool('get_player_context', { serverId, playerKey }); assert.equal(context.deaths[0].cause, deathByZombie ? 'entity_attack' : 'fall');
  if (deathByZombie) assert.equal(context.deaths[0].killerType, 'minecraft:zombie');
  await consoleCommand('damage ArchiveQA 1000 fall'); await delay(500);
  assert.equal(value(await query(), 'deaths'), value(before, 'deaths') + 1n);
  if (deathByZombie) await consoleCommand('difficulty peaceful');
  const activity = await tool('get_recent_activity', { serverId, playerKey, after: activityStart, limit: 100 }); assert.equal(activity.hasMore, false);
  const total = metric => activity.items.filter(item => item.metric === metric && item.kind === 'COUNTER').reduce((sum, item) => sum + BigInt(item.value), 0n);
  assert.equal(total('blocks.mined'), 4n); assert.equal(total('blocks.placed'), 1n); assert.equal(total('experience.gained'), 11020n);
  assert.equal(activity.items.filter(item => item.kind === 'DEATH').length, 1);
  assert.ok(activity.items.every(item => item.source === 'PLAYER')); assert.equal(new Set(activity.items.map(item => item.eventId)).size, activity.items.length);
  return { actualMining: true, survivalMining: true, woodAndOreSubcategories: true, airAndAdventureMiningExcluded: true, cancelledMiningExcluded: true, actualPlacement: true, adventurePlacementExcluded: true, cancelledPlacementExcluded: true, cancelledExperienceExcluded: true, positiveExperiencePoints: '11020', levelConsumptionNotSubtracted: true, actualDeathCause: context.deaths[0].cause, killerType: context.deaths[0].killerType, repeatedDeadDamageNotCounted: true, mcpReadActualBehaviorStream: true };
}
