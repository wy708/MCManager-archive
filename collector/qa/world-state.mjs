import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { localGameClient } from './http-client.mjs';

export async function verifyWorldState({ bot, tool, serverId, playerKey, command, until, reconnect }) {
  async function execute(text) { command(text); await delay(300); }
  const coordinates = { serverId, dimension: 'minecraft:overworld', x: 2, y: 100, z: 2 };
  const query = (name, args = {}) => tool(name, { serverId, ...args });
  await execute('gamemode creative ArchiveQA');
  await execute('tp ArchiveQA 0.5 100 0.5');
  await execute('fill -4 99 -4 8 99 8 bedrock');
  await execute('setblock 2 100 2 air');
  await execute('setblock 2 100 2 furnace');
  await execute('replaceitem block 2 100 2 slot.container 0 raw_iron 32');
  await execute('replaceitem entity ArchiveQA slot.hotbar 0 diamond 7');
  const world = await query('get_world_state');
  assert.equal(world.status, 'READY');
  assert.ok(world.data.players.some(player => player.playerKey === playerKey));
  await execute('weather rain');
  await delay(1500);
  const rainy = await query('get_world_state');
  assert.equal(rainy.status, 'READY');
  assert.ok(rainy.data.rainLevel > 0);
  await execute('weather clear');
  const player = await query('get_player_state', { playerKey });
  assert.equal(player.status, 'READY');
  assert.equal(player.data.playerKey, playerKey);
  assert.equal(player.data.inventory.slots[0].item, 'minecraft:diamond');
  assert.equal(player.data.inventory.slots[0].count, 7);
  assert.ok(player.data.health >= 0);
  const block = await tool('inspect_block', coordinates);
  assert.equal(block.status, 'READY');
  assert.equal(block.data.block, 'minecraft:furnace');
  const cold = await tool('inspect_container', coordinates);
  assert.equal(cold.status, 'READY');
  assert.equal(cold.data.container.slots[0].item, 'minecraft:raw_iron');
  assert.equal(cold.data.container.slots[0].count, 32);
  assert.equal(cold.data.container.slots[1].count, 0);
  assert.equal(cold.data.furnace.burnTicksRemaining, 0);
  await execute('replaceitem block 2 100 2 slot.container 1 coal 4');
  const burning = await tool('inspect_container', coordinates);
  assert.equal(burning.status, 'READY');
  assert.ok(burning.data.furnace.burnTicksRemaining > 0);
  await execute('replaceitem block 2 100 2 slot.container 2 iron_ingot 64');
  const blocked = await tool('inspect_container', coordinates);
  assert.equal(blocked.data.container.slots[2].count, 64);
  await execute('setblock 4 100 2 chest');
  await execute('replaceitem block 4 100 2 slot.container 5 diamond 7');
  const chest = await tool('inspect_container', { ...coordinates, x: 4 });
  assert.equal(chest.data.container.slots[5].item, 'minecraft:diamond');
  assert.equal(chest.data.container.slots[5].count, 7);
  await execute('summon cow 5 100 3');
  const area = await query('scan_nearby', { ...coordinates, radius: 4 });
  assert.equal(area.status, 'READY');
  assert.ok(area.data.blocks.some(block => block.x === 2 && block.y === 100 && block.z === 2));
  const cow = area.data.entities.find(actor => actor.type === 'minecraft:cow');
  assert.ok(cow && cow.health > 0 && cow.maxHealth >= cow.health);
  const far = await tool('inspect_block', { ...coordinates, x: 9876543, z: 9876543 });
  assert.equal(far.status, 'CHUNK_UNLOADED');
  await until(async () => {
    const saved = await query('get_last_player_snapshot', { playerKey });
    return saved.status === 'HISTORY' && saved.snapshot.data.inventory.slots[0].count === 7;
  });
  let observer, observerError;
  try {
    observer = await localGameClient('http://127.0.0.1:19152', 'ArchiveWorldQA', error => { observerError = error; });
    let spawned = false;
    observer.on('spawn', () => { spawned = true; });
    observer.on('disconnect', packet => { observerError = new Error('World observer disconnected: ' + JSON.stringify(packet)); });
    await until(() => { if (observerError) throw observerError; return spawned; }, 45000);
    observer.queue('serverbound_loading_screen', { type: 2 });
    await execute('tp ArchiveWorldQA 0.5 100 0.5');
    await reconnect(async () => {
      const offline = await query('get_player_state', { playerKey });
      assert.equal(offline.status, 'PLAYER_OFFLINE');
      assert.equal(offline.lastKnown.data.playerKey, playerKey);
      assert.ok(Date.parse(offline.lastKnown.observedAt) <= Date.parse(offline.observedAt));
      const retained = await tool('inspect_container', coordinates);
      assert.equal(retained.status, 'READY');
      assert.ok(retained.data.furnace.burnTicksRemaining > 0);
    });
    if (observerError) throw observerError;
  } finally { observer?.close(); }
  return { realMcpStdio: true, currentWorldAndPlayerRead: true, actualInventoryMatched: true,
    actualFurnaceWithoutFuelObserved: true, actualBurningFurnaceObserved: true, actualChestContentsMatched: true,
    actualWeatherChangeObserved: true, fullFurnaceOutputObserved: true,
    loadedAreaScanned: true, unloadedChunkReportedHonestly: true, offlinePlayerReturnedHistoricalSnapshot: true,
    actualNearbyLivingEntityHealthRead: true,
    offlineOwnerFurnaceStillQueriedInLoadedChunk: true, commandsExecutedOnlyForQaFixtures: true };
}
