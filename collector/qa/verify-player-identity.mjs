import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { assertServerStopped } from '../../backup/src/processes.mjs';
import { localGameClient } from './http-client.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tools = path.join(root, '.tools'), source = path.join(tools, 'game-qa-26.51.8');
assert.equal(JSON.parse(readFileSync(path.join(source, 'qa-provenance.json'), 'utf8')).owner, 'MCManager-archive-isolated-qa');
await assertServerStopped(source);
const fixture = mkdtempSync(path.join(tools, 'player-identity-qa-'));
const runId = randomUUID().slice(0, 7), firstName = 'QAOld' + runId, currentName = 'QANew' + runId;
const profileId = randomUUID(), otherId = randomUUID(), playerKey = 'uuid:' + profileId, otherKey = 'uuid:' + otherId;
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname, '127.0.0.1');
const env = Object.fromEntries(readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('MCM_') && line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const cookies = new Map(), worlds = [];
let csrf, agentId, mcp, game, bot, gameError;

async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers } });
  for (const cookie of response.headers.getSetCookie()) {
    const first = cookie.split(';')[0], equal = first.indexOf('=');
    cookies.set(first.slice(0, equal), first.slice(equal + 1));
  }
  return response;
}
async function api(endpoint, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await request(endpoint, { method, headers: csrf ? { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' } : {},
    body: data === undefined ? undefined : JSON.stringify(data) });
  assert.ok(response.ok, `${method} ${endpoint}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function tool(name, args) {
  const result = await mcp.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, name);
  return result.structuredContent.data;
}
async function until(action, stage, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (gameError) throw gameError;
    if (game?.exited) throw new Error(`Game exited during ${stage}. See ${game.log}`);
    const result = await action();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out during ${stage}. See ${game?.log ?? fixture}`);
}
const stat = (serverId, key, dimension) => api('/api/statistics/summary?' + new URLSearchParams({
  ...(serverId ? { serverId } : {}), ...(key ? { playerKey: key } : {}), ...(dimension ? { dimension } : {}),
}));
const metric = (summary, key) => summary.metrics.find(item => item.key === key)?.value;

async function makeWorld(letter, port) {
  const worldName = `Identity-${letter}-${runId}`;
  const archive = await api('/api/servers', { name: `跨服身份实服验收 ${letter} · ${runId}`,
    description: 'MCManager-archive isolated player identity QA', startDate: '2020-01-01' });
  const world = { ...archive, worldName, port, directory: path.join(fixture, letter) };
  worlds.push(world);
  world.token = (await api(`/api/servers/${world.id}/collector-credential`, {})).token;
  mkdirSync(world.directory);
  for (const entry of ['bedrock_server_mod.exe', 'PreLoader.dll', 'PreLoaderConfig.json', 'bedrock_runtime_data',
    'definitions', 'behavior_packs', 'resource_packs', 'world_templates', 'profanity_filter.wlist',
    'plugins/LeviLamina/LeviLamina.dll', 'plugins/LeviLamina/manifest.json', 'plugins/LeviLamina/CrashLogger.exe',
    'plugins/LeviLamina/lang']) {
    const target = path.join(world.directory, entry);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(source, entry), target, { recursive: true });
  }
  const loaderConfig = path.join(world.directory, 'plugins/LeviLamina/config');
  mkdirSync(loaderConfig);
  cpSync(path.join(root, 'collector/qa/LeviLamina.Config.json'), path.join(loaderConfig, 'Config.json'));
  const collector = path.join(world.directory, 'plugins/archive-collector');
  cpSync(path.join(root, 'collector/bin/archive-collector'), collector, { recursive: true, filter: file => !file.endsWith('.pdb') });
  mkdirSync(path.join(collector, 'config'));
  writeFileSync(path.join(collector, 'config/config.json'), JSON.stringify({ enabled: true, serverId: world.id, token: world.token, endpoint: base + '/api/ingest/v1/batches' }));
  world.configWritten = true;
  writeFileSync(path.join(world.directory, 'server.properties'), [
    `server-name=${worldName}`, `level-name=${worldName}`, 'level-type=FLAT', `level-seed=${port}`,
    'gamemode=creative', 'force-gamemode=true', 'difficulty=peaceful', 'allow-cheats=true', 'online-mode=false',
    'allow-list=false', `server-port=${port}`, `server-portv6=${port + 1}`, 'server-ip=127.0.0.1', 'transport=nethernet',
    'enable-lan-visibility=false', 'max-players=2', 'view-distance=5', 'tick-distance=4', 'emit-server-telemetry=false',
  ].join('\n') + '\n');
  return world;
}
async function start(world) {
  await assertServerStopped(world.directory);
  const child = spawn(path.join(world.directory, 'bedrock_server_mod.exe'), [], { cwd: world.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const run = { child, output: '', log: path.join(world.directory, 'identity-qa.log'), exited: false };
  run.done = new Promise(resolve => child.once('exit', code => { run.exited = true; resolve(code); }));
  child.once('error', error => { gameError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { run.output += chunk; appendFileSync(run.log, chunk); });
  game = run;
  await until(() => run.output.includes('Server started') && run.output.includes('Player session checkpoints and confirmed public chat capture enabled'), 'server startup', 60_000);
}
async function stop() {
  const run = game;
  run.child.stdin.write('stop\n');
  const code = await Promise.race([run.done, delay(30_000, undefined, { ref: false }).then(() => { throw new Error(`Stop timed out. See ${run.log}`); })]);
  assert.equal(code, 0);
  assert.match(run.output, /Quit correctly/);
  game = undefined;
}
async function play(world, name, uuid, xp, level) {
  const key = 'uuid:' + uuid;
  const sessionState = { closing: false };
  bot = await localGameClient(`http://127.0.0.1:${world.port}`, name, error => { if (!sessionState.closing) gameError = error; }, uuid, uuid);
  let spawned = false, observedLevel;
  const received = [];
  bot.on('spawn', () => { spawned = true; });
  bot.on('text', packet => received.push(packet));
  bot.on('update_attributes', packet => {
    if (String(packet.runtime_entity_id) === String(bot?.entityId))
      for (const attribute of packet.attributes) if (attribute.name === 'minecraft:player.level') observedLevel = attribute.current;
  });
  await until(() => spawned, `${name} spawn`, 45_000);
  assert.equal(bot.startGameData.level_id, world.worldName);
  bot.queue('serverbound_loading_screen', { type: 2 });
  const message = `身份实服验收 ${randomUUID()}`;
  bot.queue('text', { category: 'authored', type: 'chat', needs_translation: false, source_name: name,
    xuid: '', platform_chat_id: '', has_filtered_message: false, message });
  await until(() => received.some(packet => packet.message === message), `${name} native chat`);
  const chat = await until(async () => {
    const page = await tool('get_chat_messages', { serverId: world.id });
    return page.items.find(row => row.text === message);
  }, `${name} MCP chat`);
  assert.equal(chat.playerKey, key, 'Stable UUID must come from the actual native player');
  game.child.stdin.write(`xp ${xp} ${name}\nxp ${level}L ${name}\n`);
  await until(() => observedLevel === level, `${name} client experience level`);
  const summary = await until(async () => {
    const value = await tool('get_player_statistics', { serverId: world.id, playerKey: key });
    return metric(value, 'level.max') === String(level) && metric(value, 'experience.gained') === String(xp) ? value : null;
  }, `${name} native statistics`);
  assert.equal(summary.confirmedJoinCount, 1);
  sessionState.closing = true; bot.close(); bot = undefined;
  const context = await until(async () => {
    const value = await tool('get_player_context', { serverId: world.id, playerKey: key });
    return value.sessions[0]?.endReason === 'NORMAL' ? value : null;
  }, `${name} session end`);
  assert.equal(context.player.name, name);
  const online = metric(context.statistics, 'online.millis');
  assert.equal(online, context.sessions[0].onlineMillis);
  assert.ok(BigInt(online) > 0n);
  console.log(JSON.stringify({ stage: 'native-player-identity-confirmed', archive: world.worldName, name, key, xp, level, online }));
  return { key, name, xp, level, online, chatId: chat.eventId };
}

try {
  csrf = await api('/api/auth/csrf');
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { [csrf.headerName]: csrf.token },
    body: new URLSearchParams({ username: env.MCM_ADMIN_USERNAME ?? 'admin', password: env.MCM_ADMIN_PASSWORD }) })).status, 204);
  csrf = await api('/api/auth/csrf');
  const before = await stat();
  const first = await makeWorld('A', 19252), second = await makeWorld('B', 19254);
  const agent = await api('/api/agents', { name: '跨服身份实服验收 ' + runId,
    grants: worlds.map(world => ({ serverId: world.id, scopes: ['STATS_READ', 'CHAT_READ'] })) });
  agentId = agent.account.id;
  mcp = new Client({ name: 'native-player-identity-verifier', version: '0.1.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/src/server.mjs')], env: { MCM_MCP_API_URL: base, MCM_AGENT_TOKEN: agent.token }, stderr: 'inherit' }));
  await start(first);
  const a = await play(first, firstName, profileId, 2, 5);
  await stop();
  await start(second);
  const b = await play(second, currentName, profileId, 3, 9);
  const sameName = await play(second, currentName, otherId, 5, 14);
  await stop();

  const cache = path.join(first.directory, 'plugins/archive-collector/data/outbox/acknowledged');
  let original;
  for (const name of readdirSync(cache)) {
    if (!name.endsWith('.pending')) continue;
    const { body } = JSON.parse(readFileSync(path.join(cache, name), 'utf8'));
    if (JSON.parse(body).events.some(event => event.eventId === a.chatId)) { original = body; break; }
  }
  assert.ok(original);
  const replay = await request('/api/ingest/v1/batches', { method: 'POST', headers: { Authorization: 'Bearer ' + first.token, 'Content-Type': 'application/json' }, body: original });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicateBatch, true);
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: before.statisticsZone });
  assert.equal((await api(`/api/servers/${first.id}/archive`, { endDate: day })).status, 'ARCHIVED');
  assert.equal((await stat()).playerCount - before.playerCount, 2);
  assert.equal((await stat(first.id)).playerCount, 1);
  assert.equal((await stat(second.id)).playerCount, 2);
  const profile = await api(`/api/players/${encodeURIComponent(playerKey)}`);
  assert.equal(profile.player.name, currentName);
  assert.deepEqual(profile.names.map(row => row.name), [currentName, firstName]);
  assert.deepEqual(profile.servers.map(row => [row.serverId, row.serverStatus]), [[first.id, 'ARCHIVED'], [second.id, 'RECORDING']]);
  const same = await api('/api/players?' + new URLSearchParams({ serverId: second.id, search: currentName }));
  assert.deepEqual(new Set(same.items.map(row => row.key)), new Set([playerKey, otherKey]));
  const alias = await api('/api/players?' + new URLSearchParams({ search: firstName }));
  assert.deepEqual(alias.items.map(row => row.key), [playerKey]);
  const total = await stat(undefined, playerKey);
  assert.equal(metric(total, 'experience.gained'), '5');
  assert.equal(metric(total, 'level.max'), '9');
  assert.equal(metric(total, 'chat.messages'), '2');
  assert.equal(metric(total, 'online.millis'), (BigInt(a.online) + BigInt(b.online)).toString());
  assert.equal(metric(await stat(undefined, playerKey, 'minecraft:overworld'), 'experience.gained'), '5');
  assert.equal(metric(await stat(undefined, playerKey, 'minecraft:nether'), 'experience.gained'), null);
  assert.equal((await request('/api/statistics/summary?' + new URLSearchParams({ serverId: first.id, playerKey: otherKey }))).status, 404);
  assert.equal(metric(await stat(second.id, otherKey), 'experience.gained'), '5');
  const localA = await tool('get_player_context', { serverId: first.id, playerKey });
  const localB = await tool('get_player_context', { serverId: second.id, playerKey });
  assert.deepEqual(localA.names.map(row => row.name), [firstName]);
  assert.deepEqual(localB.names.map(row => row.name), [currentName]);
  assert.deepEqual([metric(localA.statistics, 'experience.gained'), metric(localB.statistics, 'experience.gained')], ['2', '3']);
  const missing = await mcp.callTool({ name: 'get_player_context', arguments: { serverId: first.id, playerKey: otherKey } });
  assert.equal(missing.isError, true);
  const evidence = { verifiedAt: new Date().toISOString(), realGameplay: true, runtime: 'BDS 1.26.51.1 / LeviLamina 26.51.8',
    fixture, first: { id: first.id, archiveName: first.name, ...a }, second: { id: second.id, archiveName: second.name, ...b },
    sameName, playerKey, otherKey, firstName, currentName, total: { xp: 5, level: 9, online: metric(total, 'online.millis') },
    isolatedWorlds: true, archivedWorldIncluded: true, originalBatchReplayDeduplicated: true, scopedMcpNames: true, day };
  writeFileSync(path.join(tools, 'native-player-identity-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  bot?.close();
  if (game && !game.exited) {
    if (game.child.pid) {
      game.child.stdin.write('stop\n');
      await Promise.race([game.done, delay(5000, undefined, { ref: false })]);
      if (!game.exited) { game.child.kill(); await game.done; }
    }
  }
  await mcp?.close();
  if (agentId) await api(`/api/agents/${agentId}`, undefined, 'DELETE').catch(() => {});
  for (const world of worlds) {
    await api(`/api/servers/${world.id}/collector-credential`, undefined, 'DELETE').catch(() => {});
    if (world.configWritten) writeFileSync(path.join(world.directory, 'plugins/archive-collector/config/config.json'), JSON.stringify({ enabled: false, serverId: '', token: '', endpoint: base + '/api/ingest/v1/batches' }));
  }
}
