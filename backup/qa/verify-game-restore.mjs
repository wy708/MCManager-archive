import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { localGameClient } from '../../collector/qa/http-client.mjs';
import { inputDriver } from '../../collector/qa/input-driver.mjs';
import { createStoppedBackup, inspectBackup, restoreBackup } from '../src/archive.mjs';
import { canonicalJson, contains } from '../src/paths.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(project, '.tools/game-qa-26.51.8'), owner = JSON.parse(readFileSync(path.join(source, 'qa-provenance.json')));
assert.equal(owner.owner, 'MCManager-archive-isolated-qa'); assert.ok(contains(path.join(project, '.tools'), source));
const serverId = JSON.parse(readFileSync(path.join(source, 'live-chat-fixture.json'))).serverId;
const environment = Object.fromEntries(readFileSync(path.join(project, '.env'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('MCM_') && line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'; assert.equal(new URL(base).hostname, '127.0.0.1');
const run = randomUUID(), directory = path.join(project, '.tools', 'backup-qa-' + run), archive = path.join(directory, 'full-server.tar.gz');
// A new isolated offline identity for this run, retained across all reconnects.
// This does not use or claim Xbox authentication.
const offlineIdentity = randomUUID();
await mkdir(directory); writeFileSync(path.join(directory, '.qa-owner'), run);
const log = path.join(directory, 'game.log'); let game, client, mcp, failure, csrf, agentId;
const cookies = new Map();
async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, { ...options, redirect: 'error', headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers }, signal: AbortSignal.timeout(30000) });
  for (const cookie of response.headers.getSetCookie()) { const at = cookie.indexOf('='); cookies.set(cookie.slice(0, at), cookie.slice(at + 1).split(';')[0]); }
  return response;
}
async function admin(endpoint, body, method = 'POST') {
  const response = await request(endpoint, { method, headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `Admin request failed: HTTP ${response.status}`); return response.status === 204 ? null : response.json();
}
async function tool(name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, `MCP ${name} failed`); return result.structuredContent.data;
}
async function until(action, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (failure) throw failure; if (game?.exited) throw new Error(`Owned test game exited: ${game.exitCode}`); const result = await action(); if (result) return result; await delay(100); }
  throw new Error('Restore verification timed out; inspect the owned backup QA game.log');
}
async function launch(root) {
  assert.ok(root === source || contains(directory, root)); failure = undefined;
  const child = spawn(path.join(root, 'bedrock_server_mod.exe'), [], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, root, output: '', exited: false, exitCode: null };
  state.exit = new Promise((resolve, reject) => { child.once('exit', code => { state.exited = true; state.exitCode = code; resolve(code); }); child.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { state.output += chunk; appendFileSync(log, chunk); }); game = state;
  await until(() => /Player session checkpoints and confirmed public chat capture enabled/.test(state.output), 60000);
  await until(() => /Server started/.test(state.output), 60000);
  return state;
}
async function connect() {
  const state = { expectedClose: false, texts: [], held: null };
  state.bot = await localGameClient('http://127.0.0.1:19152', 'ArchiveQA', error => { if (!state.expectedClose) failure = error; }, offlineIdentity);
  const bot = state.bot;
  bot.on('text', packet => state.texts.push(packet));
  bot.on('inventory_content', packet => { if (['inventory', 0].includes(packet.window_id)) state.held = packet.input[0]; });
  bot.on('inventory_slot', packet => { if (['inventory', 0].includes(packet.window_id) && packet.slot === 0) state.held = packet.item; });
  bot.on('disconnect', packet => { if (!state.expectedClose) failure = new Error('Owned test player disconnected: ' + packet.reason); });
  let spawned = false; bot.on('spawn', () => { spawned = true; }); client = state; await until(() => spawned, 45000); inputDriver(bot); return state;
}
const command = async text => { game.child.stdin.write(text + '\n'); await delay(250); };
async function proveBlock(state, expected) {
  const marker = 'MCM_RESTORE_PROOF_' + randomUUID();
  await command(`execute if block 2 105 2 ${expected} run say ${marker}`);
  await until(() => state.texts.some(packet => packet.message.includes(marker)), 10000);
}
async function sendChat(state, text) {
  state.bot.queue('text', { category: 'authored', type: 'chat', needs_translation: false, source_name: state.bot.profile.name, xuid: '', platform_chat_id: '', has_filtered_message: false, message: text });
  await until(() => state.texts.some(packet => packet.message === text));
}
async function disconnect(playerKey) {
  if (client) { client.expectedClose = true; client.bot.close(); client = null; }
  await until(async () => (await tool('get_player_context', { serverId, playerKey })).sessions[0].ended);
}
async function stop() {
  const state = game; state.child.stdin.write('stop\n');
  assert.equal(await Promise.race([state.exit, delay(45000, undefined, { ref: false }).then(() => { throw new Error('Owned test game did not stop'); })]), 0);
  assert.match(state.output, /0 durable pending events, 0 unpersisted events, 0 rejected submissions/); game = null;
}

try {
  csrf = await (await request('/api/auth/csrf')).json();
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { [csrf.headerName]: csrf.token }, body: new URLSearchParams({ username: environment.MCM_ADMIN_USERNAME ?? 'admin', password: environment.MCM_ADMIN_PASSWORD }) })).status, 204);
  csrf = await (await request('/api/auth/csrf')).json();
  let token = (await admin(`/api/servers/${serverId}/collector-credential`)).token;
  await writeFile(path.join(source, 'plugins/archive-collector/config/config.json'), canonicalJson({ enabled: true, serverId, token, endpoint: base + '/api/ingest/v1/batches' }));
  const agent = await admin('/api/agents', { name: '完整世界恢复验收', grants: [{ serverId, scopes: ['STATS_READ', 'CHAT_READ'] }] }); agentId = agent.account.id;
  mcp = new Client({ name: 'full-world-restore-verifier', version: '0.1.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(project, 'mcp/src/server.mjs')], env: { MCM_MCP_API_URL: base, MCM_AGENT_TOKEN: agent.token }, stderr: 'inherit' }));
  const chatStart = (await tool('get_chat_messages', { serverId })).nextCursor;
  await launch(source);
  await assert.rejects(createStoppedBackup({ root: source, output: path.join(directory, 'must-not-back-up-live.tar.gz'), serverId }), /Server is running/);
  const original = await connect(), playerKey = 'uuid:' + original.bot.profile.uuid.toLowerCase();
  await command('gamemode creative ArchiveQA'); await command('tp ArchiveQA 0.5 100 0.5'); await command('setblock 2 105 2 emerald_block'); await proveBlock(original, 'emerald_block');
  await command('replaceitem entity ArchiveQA slot.hotbar 0 emerald 7'); await until(() => original.held?.count === 7);
  const inventoryItem = { networkId: original.held.network_id, count: original.held.count };
  console.log(JSON.stringify({ stage: 'original-inventory-seeded', item: inventoryItem, offlineIdentity }));
  const originalMessage = '完整备份之前 ' + run; await sendChat(original, originalMessage);
  const message = await until(async () => (await tool('get_chat_messages', { serverId, after: chatStart })).items.find(item => item.text === originalMessage));
  await disconnect(playerKey); await stop();
  // Prove the client identity can recover player data on the source itself,
  // before testing any archive/restore behavior.
  await launch(source); const rejoined = await connect();
  console.log(JSON.stringify({ stage: 'source-identity-reconnected', held: rejoined.held }));
  await until(() => rejoined.held?.count === inventoryItem.count && rejoined.held.network_id === inventoryItem.networkId);
  await disconnect(playerKey); await stop();
  console.log(JSON.stringify({ stage: 'real-source-stopped-and-snapshot-started' }));
  const backup = await createStoppedBackup({ root: source, output: archive, serverId, note: '真实 BDS 世界、插件和玩家数据恢复验收' });
  const proof = await inspectBackup(archive); assert.equal(proof.manifest.statistics.archiveBinding, 'VERIFIED'); assert.equal(proof.manifest.statistics.pendingEvents, '0');
  assert.ok(proof.manifest.files.length > 1000); assert.ok(proof.manifest.runtime.plugins.some(plugin => plugin.name === 'LeviLamina' && plugin.version === '26.51.8'));
  console.log(JSON.stringify({ stage: 'full-archive-created-and-verified', archiveBytes: backup.archiveBytes, files: backup.fileCount }));
  await launch(source); const newer = await connect(); await command('tp ArchiveQA 0.5 100 0.5'); await command('setblock 2 105 2 air'); await proveBlock(newer, 'air');
  await until(() => newer.held?.count === inventoryItem.count && newer.held.network_id === inventoryItem.networkId);
  await command('replaceitem entity ArchiveQA slot.hotbar 0 emerald 11'); await until(() => newer.held?.count === 11);
  const newerMessage = '备份之后的中央历史应保留 ' + run; await sendChat(newer, newerMessage);
  await until(async () => (await tool('get_chat_messages', { serverId, after: chatStart })).items.some(item => item.text === newerMessage));
  await disconnect(playerKey); const beforeRestore = await tool('get_player_context', { serverId, playerKey }); await stop();
  token = (await admin(`/api/servers/${serverId}/collector-credential`)).token;
  const destination = path.join(directory, 'restored-server');
  const restoration = await restoreBackup({ file: archive, destination, mode: 'CONTINUE', targetServerId: serverId, collectorToken: token, endpoint: base + '/api/ingest/v1/batches' });
  assert.equal(restoration.worldRuntimeVerified, false);
  const outbox = path.join(destination, 'plugins/archive-collector/data/outbox'), acknowledged = path.join(outbox, 'acknowledged'); let replayFile;
  for (const name of await readdir(acknowledged)) {
    if (!name.endsWith('.pending')) continue;
    const body = JSON.parse(JSON.parse(await readFile(path.join(acknowledged, name), 'utf8')).body);
    if (body.events.some(event => event.eventId === message.eventId)) { replayFile = name; break; }
  }
  assert.ok(replayFile, 'Original actual-player chat must exist in the restored native cache'); await rename(path.join(acknowledged, replayFile), path.join(outbox, replayFile));
  const restoreLaunched = Date.now(); await launch(destination); const restored = await connect();
  console.log(JSON.stringify({ stage: 'restored-identity-reconnected', held: restored.held }));
  assert.equal(restored.bot.profile.uuid.toLowerCase(), original.bot.profile.uuid.toLowerCase());
  await until(() => restored.held?.count === inventoryItem.count && restored.held.network_id === inventoryItem.networkId);
  await command('tp ArchiveQA 0.5 100 0.5'); await proveBlock(restored, 'emerald_block');
  await until(async () => (await readdir(acknowledged)).includes(replayFile));
  const afterRestore = await tool('get_player_context', { serverId, playerKey });
  assert.ok(Date.parse(afterRestore.sessions[0].startedAt) >= restoreLaunched);
  const oldSession = afterRestore.sessions.find(session => session.sessionId === beforeRestore.sessions[0].sessionId); assert.ok(oldSession?.ended);
  assert.equal(oldSession.checkpointAt, beforeRestore.sessions[0].checkpointAt);
  const chatCount = context => context.statistics.metrics.find(metric => metric.key === 'chat.messages').value;
  assert.equal(chatCount(afterRestore), chatCount(beforeRestore));
  const chats = await tool('get_chat_messages', { serverId, after: chatStart, limit: 200 });
  assert.equal(chats.items.filter(item => item.eventId === message.eventId).length, 1); assert.equal(chats.items.filter(item => item.text === newerMessage).length, 1);
  await disconnect(playerKey); await stop();
  const evidence = { verifiedAt: new Date().toISOString(), backupId: backup.backupId, restorationId: restoration.restorationId,
    archiveSha256: backup.sha256, archiveBytes: backup.archiveBytes, sourceBytes: backup.sourceBytes, fileCount: backup.fileCount,
    actualGameVersion: '1.26.51.1', leviLaminaVersion: '26.51.8', realGameplay: true, runningServerBackupRefused: true,
    allArchiveFileChecksumsVerified: true, sourceWorldChangedAfterSnapshot: true, originalWorldMarkerRestored: true, playerInventoryRestored: true,
    originalPlayerIdentityPreserved: true, stableOfflineSelfSignedIdentity: true, xboxAuthenticationTested: false,
    sourcePlayerDataPersistenceVerified: true, newerInventoryChangeRolledBack: true,
    newerCentralHistoryPreserved: true, originalNativeBatchReplayDeduplicated: true,
    oldSessionNotReopened: true, restoredCollectorStartedFreshSession: true, cleanSourceAndRestoredStops: true,
    worldRuntimeVerified: true, onlineBackupTested: false, platformDatabaseBackupTested: false, externalDatabaseBackupTested: false };
  await writeFile(path.join(destination, '.mcmanager-restore/runtime-verification.json'), canonicalJson(evidence));
  await writeFile(path.join(project, '.tools/backup-restoration-evidence.json'), canonicalJson(evidence)); console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (client) { client.expectedClose = true; client.bot.close(); }
  if (game && !game.exited) { try { game.child.stdin.write('stop\n'); } catch {} await Promise.race([game.exit, delay(5000, undefined, { ref: false })]); if (!game.exited) game.child.kill(); }
  await mcp?.close();
  if (agentId) await admin(`/api/agents/${agentId}`, undefined, 'DELETE').catch(() => {});
  if (csrf) await admin(`/api/servers/${serverId}/collector-credential`, undefined, 'DELETE').catch(() => {});
}
