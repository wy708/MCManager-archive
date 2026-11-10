import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { GameAiMailbox } from './game-ai.mjs';

const serverId = '11111111-1111-4111-8111-111111111111';
const key = 'group:123456789';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcm-game-ai-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'requests'));
  let now = Date.now(), enabled = true, wakes = [];
  const config = { schema: 1, enabled: true, serverId, groupKey: key, directory };
  const callbacks = { allowed: k => enabled && k === key, wake: async k => { wakes.push(k); return true; }, now: () => now,
    sensitive: text => text.includes('password=') };
  const mailbox = new GameAiMailbox(config, callbacks);
  const request = (overrides = {}) => ({ schema: 1, requestId: crypto.randomUUID(), serverId, playerKey: 'xuid:1234',
    player: { name: 'FixturePlayer', identityType: 'XUID', identity: '1234' }, dimension: 'overworld', position: { x: 1, y: 70, z: 2 },
    question: '我的熔炉为什么不烧？', createdAt: now, expiresAt: now + 300000, ...overrides });
  const put = async r => fs.writeFile(mailbox.file('requests', r.requestId), JSON.stringify(r));
  const response = r => fs.readFile(mailbox.file('responses', r.requestId), 'utf8').then(JSON.parse);
  return { directory, config, callbacks, mailbox, request, put, response, wakes,
    advance: ms => { now += ms; }, pause: () => { enabled = false; } };
}
test('routes two concurrent players by per-request capability, never by supplied display name', async t => {
  const f = await fixture(t), a = f.request(), b = f.request({ playerKey: 'xuid:9999' });
  await f.put(a); await f.put(b); await f.mailbox.scan();
  assert.deepEqual(f.wakes, [key]);
  assert.equal(f.mailbox.prompt('group:1127805616'), '');
  assert.equal(f.mailbox.prompt('private:1234'), '');
  const ra = f.mailbox.pending.get(a.requestId), rb = f.mailbox.pending.get(b.requestId);
  assert.match(f.mailbox.prompt(key), /MINECRAFT_GAME/);
  await assert.rejects(f.mailbox.reply(`game:${b.requestId}`, ra.token, { messages: '错发' }), { statusCode: 403 });
  assert.equal(f.mailbox.acceptsToken('汉'.repeat(56)), false);
  const result = await f.mailbox.reply(`game:${a.requestId}`, ra.token, { messages: '先检查燃料。' });
  assert.equal(result.queued, true); assert.equal(result.delivered, false);
  assert.equal((await f.response(a)).playerKey, a.playerKey);
  assert.equal((await f.mailbox.reply(`game:${a.requestId}`, ra.token, { messages: '先检查燃料。' })).duplicate, true);
  await assert.rejects(f.mailbox.reply(`game:${a.requestId}`, ra.token, { messages: '覆盖答案' }), { statusCode: 409 });
  await f.mailbox.reply(`game:${b.requestId}`, rb.token, { messages: ['检查熔炼配方。', '注意记录时间。'] });
  assert.equal((await f.response(b)).playerKey, b.playerKey);
  assert.equal(f.mailbox.hasPending(key), false);
});
test('expired, paused, oversized, sensitive and QQ-directed answers fail closed', async t => {
  const f = await fixture(t), a = f.request(); await f.put(a); await f.mailbox.scan();
  const token = f.mailbox.pending.get(a.requestId).token;
  for (const body of [{messages: 'x'.repeat(1501)}, {messages: 'password=badsecret'}, {messages: token},
    {messages: '§k文字'}, {messages: '答案', atUserId: '1234'}, {messages: '答案', replyToMessageId: 3}]) {
    await assert.rejects(f.mailbox.reply(`game:${a.requestId}`, token, body));
  }
  f.advance(300001);
  assert.equal(f.mailbox.acceptsToken(token), false);
  await assert.rejects(f.mailbox.reply(`game:${a.requestId}`, token, { messages: '迟到' }), { statusCode: 410 });
  await f.mailbox.scan(); assert.equal(f.mailbox.pending.size, 0);
  const b = f.request(); await f.put(b); f.pause(); await f.mailbox.scan();
  assert.equal(f.mailbox.pending.size, 0);
});
test('completed responses survive bridge restart without spending another model turn', async t => {
  const f = await fixture(t), a = f.request(); await f.put(a); await f.mailbox.scan();
  await f.mailbox.reply(`game:${a.requestId}`, f.mailbox.pending.get(a.requestId).token, { messages: '已回答' });
  const restarted = new GameAiMailbox(f.config, f.callbacks); await restarted.scan();
  assert.equal(restarted.pending.size, 0); assert.equal(f.wakes.length, 1);
  assert.equal((await f.response(a)).text, '已回答');
});
test('bounded inbox ignores foreign servers, stale or malformed requests; wake retries are bounded', async t => {
  const f = await fixture(t);
  await f.put(f.request({ serverId: crypto.randomUUID() }));
  await f.put(f.request({ playerKey: '../../someone' }));
  await f.put(f.request({ question: 'x'.repeat(8192) }));
  await f.put(f.request({ createdAt: Date.now() - 400000, expiresAt: Date.now() - 100000 }));
  await f.mailbox.scan(); assert.equal(f.mailbox.pending.size, 0);
  for (let i = 0; i < 24; i++) await f.put(f.request({ playerKey: `xuid:${i + 1}` }));
  await f.mailbox.scan(); assert.equal(f.mailbox.pending.size, 16);
  await f.mailbox.scan(); assert.equal(f.wakes.length, 1);
  for (let i = 0; i < 4; i++) { f.advance(31000); await f.mailbox.scan(); }
  assert.equal(f.wakes.length, 3);
});
test('concurrent identical replies write once; changed replies cannot race the first answer', async t => {
  const f = await fixture(t), a = f.request(); await f.put(a); await f.mailbox.scan();
  const token = f.mailbox.pending.get(a.requestId).token;
  const results = await Promise.allSettled([
    f.mailbox.reply(`game:${a.requestId}`, token, { messages: '第一个' }),
    f.mailbox.reply(`game:${a.requestId}`, token, { messages: '第二个' })
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.response(a)).text, '第一个');
});
