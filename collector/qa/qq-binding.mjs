import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyQqBinding({ bot, received, until, tool, serverId, playerKey }) {
  const qqId = '12345678';
  const before = received.length;
  bot.queue('command_request', {
    command: '/qqbind', origin: { type: 'Player', uuid: randomUUID(), request_id: '', player_entity_id: 0n },
    internal: false, version: 'Latest',
  });
  const response = await until(() => received.slice(before).find(packet => /QQ 绑定验证码 [0-9A-F]{8}/.test(packet.message)));
  const code = /QQ 绑定验证码 ([0-9A-F]{8})/.exec(response.message)[1];
  const existing = await tool('get_qq_binding', { serverId, qqId });
  assert.equal(existing.bound, false);
  const bound = await tool('bind_qq_account', { serverId, qqId, code });
  assert.equal(bound.binding.playerKey, playerKey);
  const retry = await tool('bind_qq_account', { serverId, qqId, code });
  assert.equal(retry.binding.id, bound.binding.id);
  const context = await tool('get_qq_player_context', { serverId, qqId });
  assert.equal(context.player.key, playerKey);
  assert.ok(context.statistics.metrics.some(row => row.key === 'chat.messages' && BigInt(row.value ?? '0') > 0n));
  if (process.argv.includes('--with-world-state')) {
    const state = await tool('get_qq_player_state', { serverId, qqId });
    assert.equal(state.status, 'READY');
    assert.equal(state.data.playerKey, playerKey);
  }
  const removed = await tool('unbind_qq_account', { serverId, qqId, bindingId: bound.binding.id });
  assert.equal(removed.bound, false);
  assert.equal((await tool('get_qq_binding', { serverId, qqId })).bound, false);
  return { playerCommandExecuted: true, privateCodeReceivedByActualGameClient: true,
    realMcpStdio: true, originalClaimRetriedWithoutNewBinding: true, boundPlayerContextMatched: true,
    explicitUnbindVerified: true, qqMessagesSent: false, actualDshHostTested: false };
}
