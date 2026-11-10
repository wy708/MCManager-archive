import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inputDriver } from './input-driver.mjs';

export const dimensionNames = ['minecraft:overworld', 'minecraft:nether', 'minecraft:the_end'];
const value = (summary, key) => BigInt(summary?.metrics.find(metric => metric.key === key)?.value ?? '0');
const currentAlgorithm = summary => (summary?.metrics.find(metric => metric.key === 'online.millis')?.measurements ?? [])
  .filter(item => item.quality === 'EXACT' && item.algorithmVersion === 'native-dimension-v2').reduce((sum, item) => sum + BigInt(item.value), 0n);
export async function verifyDimensions({ bot, command, until, tool, serverId, playerKey, baselines, cache }) {
  const driver = inputDriver(bot);
  const sessionId = (await tool('get_player_context', { serverId, playerKey })).sessions[0].sessionId;
  command('gamemode creative ArchiveQA'); await delay(250);
  if (![0, 'overworld'].includes(bot.startGameData.dimension)) {
    command('execute in overworld run tp ArchiveQA 0.5 100 0.5');
    await until(() => driver.changes.at(-1)?.dimension === 0, 45_000); await delay(350);
  }
  const begin = (await tool('get_recent_activity', { serverId })).highWatermark;
  const changes = [1, 0, 1, 2, 0]; let lastCursor = begin; const durations = [];
  for (const [index, target] of changes.entries()) {
    const previousCount = driver.changes.length, started = Date.now();
    const name = ['overworld', 'nether', 'the_end'][target];
    command(`execute in ${name} run tp ArchiveQA 0.5 100 0.5`);
    await until(() => driver.changes.length > previousCount && driver.changes.at(-1).dimension === target, 45_000);
    const page = await until(async () => {
      const page = await tool('get_recent_activity', { serverId, playerKey, after: lastCursor });
      return page.items.some(item => item.metric === 'dimension.visits' && item.dimension === dimensionNames[target]) ? page : null;
    });
    lastCursor = page.nextCursor; durations.push(Date.now() - started);
    console.log(JSON.stringify({ stage: 'actual-dimension-transition', to: name, milliseconds: durations.at(-1) }));
    if (index === 0 || target === 2) await delay(1250); else await delay(150);
  }
  command('execute in overworld run tp ArchiveQA 1.5 100 0.5'); await delay(250);
  const activity = await tool('get_recent_activity', { serverId, playerKey, after: begin, limit: 200 });
  const visits = activity.items.filter(item => item.metric === 'dimension.visits'); assert.equal(visits.length, 5);
  assert.deepEqual(visits.map(item => item.dimension), changes.map(id => dimensionNames[id]));
  assert.ok(durations[2] < 5000, 'Warm nether re-entry must complete within the periodic checkpoint interval');
  const baseline = baselines[playerKey] ?? dimensionNames.map(() => null);
  const online = await until(async () => {
    const before = (await tool('get_player_context', { serverId, playerKey })).sessions[0];
    assert.equal(before.sessionId, sessionId, 'Dimension transfer must not split the online session');
    const summaries = await Promise.all(dimensionNames.map(dimension => tool('get_player_statistics', { serverId, playerKey, dimension })));
    const after = (await tool('get_player_context', { serverId, playerKey })).sessions[0];
    if (before.checkpointAt !== after.checkpointAt) return null;
    const all = readdirSync(cache).filter(name => name.endsWith('.pending')).flatMap(name => JSON.parse(JSON.parse(readFileSync(path.join(cache, name), 'utf8')).body).events);
    const records = all.filter(event => event.kind === 'SESSION' && event.sessionId === sessionId && Date.parse(event.at) <= Date.parse(after.checkpointAt)).sort((a, b) => a.sequence - b.sequence);
    if (!records.length || records.at(-1).onlineMillis !== Number(after.onlineMillis)) return null;
    const expected = new Map(dimensionNames.map(name => [name, 0n])); let previous = 0n;
    for (const [index, record] of records.entries()) {
      assert.equal(record.sequence, index, 'Current session native cache must remain consecutive');
      const elapsed = BigInt(record.onlineMillis); expected.set(record.dimension, expected.get(record.dimension) + elapsed - previous); previous = elapsed;
    }
    for (const [index, name] of dimensionNames.entries()) {
      assert.equal(value(summaries[index], 'online.millis') - value(baseline[index], 'online.millis'), expected.get(name));
      assert.equal(currentAlgorithm(summaries[index]) - currentAlgorithm(baseline[index]), expected.get(name), 'Current dimension boundaries must keep the new algorithm identity');
      const expectedVisits = all.filter(event => event.kind === 'COUNTER' && event.metric === 'dimension.visits' && event.dimension === name && Date.parse(event.at) >= Date.parse(before.startedAt) && Date.parse(event.at) <= Date.parse(after.checkpointAt)).length;
      assert.equal(value(summaries[index], 'dimension.visits') - value(baseline[index], 'dimension.visits'), BigInt(expectedVisits));
    }
    assert.equal([...expected.values()].reduce((sum, value) => sum + value, 0n), BigInt(after.onlineMillis));
    assert.ok(expected.get('minecraft:nether') >= 1250n); assert.ok(expected.get('minecraft:the_end') >= 1250n);
    return Object.fromEntries([...expected].map(([name, millis]) => [name, millis.toString()]));
  });
  return { actualClientDimensionPackets: 5, confirmedTransitionEvents: 5, sameDimensionTeleportNotCounted: true, singleSessionPreserved: true, warmReentryBelowCheckpointInterval: true, onlineMillisMatchOriginalNativeBoundaries: true, algorithmVersionVerified: 'native-dimension-v2', onlineMillisByDimension: online };
}
