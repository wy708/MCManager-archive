import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifySessionLifecycle({ context, command, diagnostics, until, readContext, readChat, reconnect, bot, received }) {
  const initial = context.sessions[0];
  assert.equal(initial.startReason, 'JOIN');
  const startCount = context.statistics.sessionCount;
  const joins = context.statistics.confirmedJoinCount;
  assert.ok(Number.isInteger(joins) && joins > 0);
  const metric = (current, key) => BigInt(current.statistics.metrics.find(item => item.key === key).value ?? 0);
  const previousOnline = metric(context, 'online.millis') - BigInt(initial.onlineMillis);
  const firstVisits = metric(context, 'dimension.visits');
  const ids = [initial.sessionId];
  const gaps = [];

  const waitForSegment = async (action, delayMillis = 0) => {
    const current = await until(async () => {
      const value = await readContext();
      return !ids.includes(value.sessions[0]?.sessionId) && !value.sessions[0]?.ended ? value : null;
    }, 45_000);
    const [newest, old] = current.sessions;
    assert.equal(old.sessionId, ids.at(-1));
    assert.equal(old.endReason, 'CAPTURE_STOPPED');
    assert.equal(newest.startReason, 'OBSERVED');
    const gap = Date.parse(newest.startedAt) - Date.parse(old.checkpointAt);
    assert.ok(gap >= delayMillis, `${action} did not preserve the collection gap`);
    ids.push(newest.sessionId);
    gaps.push({ action, millis: gap });
    assert.equal(current.statistics.sessionCount, startCount + ids.length - 1);
    assert.equal(current.statistics.confirmedJoinCount, joins);
    assert.equal(metric(current, 'dimension.visits'), firstVisits);
    console.log(JSON.stringify({ stage: 'collection-resumed-without-a-join', action, gapMillis: gap }));
  };

  command('ll disable archive-collector');
  await until(() => /Collector stopped: \d+ durable pending events, 0 unpersisted events, 0 rejected submissions/.test(diagnostics()));
  const chat = '采集停用期间的游戏发言 ' + randomUUID();
  bot.queue('text', { category: 'authored', type: 'chat', needs_translation: false, source_name: bot.profile.name,
    xuid: '', platform_chat_id: '', has_filtered_message: false, message: chat });
  await until(() => received.some(packet => packet.message === chat));
  await delay(2500);
  command('ll enable archive-collector');
  await waitForSegment('disable/enable', 2500);
  assert.ok(!(await readChat()).items.some(item => item.text === chat));

  command('ll reactivate archive-collector');
  await waitForSegment('reactivate');
  command('ll reload archive-collector');
  await waitForSegment('reload');

  await reconnect();
  const rejoined = await until(async () => {
    const value = await readContext();
    return !ids.includes(value.sessions[0]?.sessionId) && value.sessions[0]?.startReason === 'JOIN' ? value : null;
  });
  ids.push(rejoined.sessions[0].sessionId);
  assert.equal(rejoined.statistics.confirmedJoinCount, joins + 1);
  assert.equal(rejoined.statistics.sessionCount, startCount + ids.length - 1);
  assert.equal(metric(rejoined, 'dimension.visits'), firstVisits + 1n);

  return async () => {
    const final = await readContext();
    const sessions = ids.map(id => final.sessions.find(row => row.sessionId === id));
    assert.ok(sessions.every(row => row?.ended));
    assert.deepEqual(sessions.map(row => row.startReason), ['JOIN', 'OBSERVED', 'OBSERVED', 'OBSERVED', 'JOIN']);
    assert.deepEqual(sessions.map(row => row.endReason), ['CAPTURE_STOPPED', 'CAPTURE_STOPPED', 'CAPTURE_STOPPED', 'NORMAL', 'NORMAL']);
    let observed = 0n;
    for (const row of sessions) {
      assert.equal(BigInt(row.onlineMillis), BigInt(Date.parse(row.checkpointAt) - Date.parse(row.startedAt)));
      observed += BigInt(row.onlineMillis);
    }
    assert.equal(metric(final, 'online.millis') - previousOnline, observed);
    return { sessionIds: ids, gaps, initialConfirmedJoinCount: joins, finalConfirmedJoinCount: joins + 1,
      observedMillis: observed.toString(), dimensionEntriesOnlyOnJoin: true, chatWhileDisabledWasNotIngested: true };
  };
}
