import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inputDriver } from './input-driver.mjs';

export async function verifyLevels({ bot, command, until, tool, serverId, playerKey, cache, reconnect, replayBatch }) {
  const statistic = dimension => tool('get_player_statistics', { serverId, playerKey, ...(dimension ? { dimension } : {}) });
  const maximum = summary => Number(summary.metrics.find(item => item.key === 'level.max')?.value ?? 0);
  const begin = (await tool('get_recent_activity', { serverId })).highWatermark;
  const activity = async () => {
    const page = await tool('get_recent_activity', { serverId, playerKey, after: begin, limit: 200 });
    assert.equal(page.hasMore, false);
    return page.items.filter(item => item.metric === 'level.max');
  };
  const initial = maximum(await statistic()), peak = initial + 37, higherPeak = peak + 11;
  assert.ok(higherPeak < 100000, 'Use an isolated player with a bounded level baseline');
  let clientLevel;
  const clientLevels = [];
  function watch(client) {
    client.on('update_attributes', packet => {
      if (String(packet.runtime_entity_id) !== String(client.startGameData.runtime_entity_id)) return;
      for (const attribute of packet.attributes) if (attribute.name === 'minecraft:player.level') {
        clientLevel = attribute.current; clientLevels.push(attribute.current);
      }
    });
  }
  watch(bot);
  const driver = inputDriver(bot);
  async function execute(text) { command(text); await delay(250); }
  async function waitLevel(value) {
    await until(() => clientLevel === value);
    return until(async () => (await activity()).some(item => Number(item.value) === value));
  }
  await execute('gamemode creative ArchiveQA');
  await execute('xp 1L ArchiveQA'); await until(() => clientLevel >= 1);
  await execute('xp -1000000L ArchiveQA'); await waitLevel(0);
  await execute('xp 13L ArchiveQA'); await delay(800);
  assert.equal(clientLevel, 0); assert.ok(!(await activity()).some(item => Number(item.value) === 13));
  console.log(JSON.stringify({ stage: 'actual-zero-level-and-cancelled-level-request', observedClientLevel: clientLevel }));

  await execute(`xp ${peak}L ArchiveQA`); await waitLevel(peak);
  await until(async () => maximum(await statistic()) === peak);
  await execute(`xp -${peak - 2}L ArchiveQA`); await waitLevel(2);
  assert.equal(maximum(await statistic()), peak);
  await execute('xp 13 ArchiveQA'); await delay(600); assert.equal(clientLevel, 2);
  await execute('xp 17 ArchiveQA'); await until(() => clientLevel === 3); await waitLevel(3);
  assert.equal(maximum(await statistic()), peak);
  await execute('xp -1000000L ArchiveQA'); await waitLevel(0);
  await execute(`xp ${higherPeak}L ArchiveQA`); await waitLevel(higherPeak);
  await until(async () => maximum(await statistic()) === higherPeak);
  const metric = (await statistic()).metrics.find(item => item.key === 'level.max');
  assert.ok(metric.measurements.some(item => item.quality === 'OBSERVED' && item.algorithmVersion === 'native-level-observed-v1' && Number(item.value) === higherPeak));
  console.log(JSON.stringify({ stage: 'actual-level-max-not-sum', initial, peak, higherPeak, observedClientLevels: clientLevels }));

  await execute(`xp -${higherPeak - 2}L ArchiveQA`); await waitLevel(2);
  if (![0, 'overworld'].includes(bot.startGameData.dimension)) {
    const count = driver.changes.length; await execute('execute in overworld run tp ArchiveQA 0.5 100 0.5');
    await until(() => driver.changes.length > count && driver.changes.at(-1).dimension === 0, 45000);
  }
  const changes = driver.changes.length;
  await execute('execute in nether run tp ArchiveQA 0.5 100 0.5');
  await until(() => driver.changes.length > changes && driver.changes.at(-1).dimension === 1, 45000);
  const netherObservation = await until(async () => (await activity()).find(item => item.dimension === 'minecraft:nether' && Number(item.value) === 2));
  const netherMetric = (await statistic('minecraft:nether')).metrics.find(item => item.key === 'level.max');
  assert.ok(netherMetric.measurements.some(item => item.quality === 'OBSERVED' && Number(item.value) === 2));
  // An unchanged level must still get a later sample: otherwise a later day's
  // date filter would incorrectly show no observations for a long online session.
  const periodic = await until(async () => (await activity()).find(item => item.dimension === 'minecraft:nether'
    && Number(item.value) === 2 && Date.parse(item.occurredAt) - Date.parse(netherObservation.occurredAt) >= 55000), 75000);
  console.log(JSON.stringify({ stage: 'actual-unchanged-level-republished', intervalMillis: Date.parse(periodic.occurredAt) - Date.parse(netherObservation.occurredAt) }));
  const returning = driver.changes.length;
  await execute('execute in overworld run tp ArchiveQA 0.5 100 0.5');
  await until(() => driver.changes.length > returning && driver.changes.at(-1).dimension === 0, 45000);
  const reconnectedAt = Date.now();
  bot = await reconnect(); watch(bot); inputDriver(bot);
  await until(async () => (await activity()).some(item => Date.parse(item.occurredAt) >= reconnectedAt && Number(item.value) <= 2));
  assert.equal(maximum(await statistic()), higherPeak);
  assert.equal(maximum((await tool('get_player_context', {serverId,playerKey})).statistics), higherPeak);
  let nativeBatch, nativeEvent;
  await until(() => {
    for (const file of readdirSync(cache).filter(name => name.endsWith('.pending'))) {
      const record = JSON.parse(readFileSync(path.join(cache, file), 'utf8')), batch = JSON.parse(record.body);
      const event = batch.events.find(item => item.metric === 'level.max' && item.player.identity === playerKey.slice(5) && item.value === higherPeak);
      if (event) { nativeBatch = record.body; nativeEvent = event; return true; }
    }
    return false;
  });
  const replay = await replayBatch(nativeBatch);
  assert.equal(replay.duplicateBatch, true); assert.equal(replay.acceptedEvents, 0);
  assert.equal(maximum(await statistic()), higherPeak);
  return { actualClientLevelUpdates: clientLevels, initialMaximum: initial, firstPeak: peak, higherPeak,
    actualZeroRecorded: true, cancelledLevelAndExperienceExcluded: true, decreasesDoNotLowerMaximum: true,
    maximumNotSum: true, lowerLevelInNewDimensionRecorded: true, unchangedObservationIntervalMillis: Date.parse(periodic.occurredAt) - Date.parse(netherObservation.occurredAt),
    reconnectPreservesMaximum: true, nativeBatchReplayDeduplicated: true, nativeMaximumEventId: nativeEvent.eventId,
    mcpPlayerContextIncludesMaximum: true, quality: 'OBSERVED', algorithmVersion: 'native-level-observed-v1', preEnableHistoryClaimed: false };
}
