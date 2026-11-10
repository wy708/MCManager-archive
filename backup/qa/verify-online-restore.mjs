import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { readFileSync, appendFileSync, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, rename, symlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { localGameClient } from '../../collector/qa/http-client.mjs';
import { inputDriver } from '../../collector/qa/input-driver.mjs';
import { ManagedGame } from '../src/managed-game.mjs';
import { createOnlineBackup, inspectBackup, restoreBackup } from '../src/archive.mjs';
import { canonicalJson, contains, missing, digest } from '../src/paths.mjs';
import { assertServerStopped } from '../src/processes.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url)), source = path.join(project, '.tools/game-qa-26.51.8');
assert.equal(JSON.parse(readFileSync(path.join(source, 'qa-provenance.json'))).owner, 'MCManager-archive-isolated-qa');
await assertServerStopped(source);
assert.equal(await missing(path.join(source, '.mcmanager-backup.lock')), true);
const serverId = JSON.parse(readFileSync(path.join(source, 'live-chat-fixture.json'))).serverId;
const collectorVersion = JSON.parse(readFileSync(path.join(source, 'plugins/archive-collector/manifest.json'))).version;
const environment = Object.fromEntries(readFileSync(path.join(project, '.env'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('MCM_') && line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'; assert.equal(new URL(base).hostname, '127.0.0.1');
const run = randomUUID(), directory = path.join(project, '.tools', 'online-backup-qa-' + run), offlineIdentity = randomUUID();
await mkdir(directory); await writeFile(path.join(directory, '.qa-owner'), run);
const configPath = path.join(source, 'plugins/archive-collector/config/config.json'), originalConfig = await readFile(configPath);
const sourceAcknowledged = path.join(source, 'plugins/archive-collector/data/outbox/acknowledged');
const cookies = new Map(); let csrf, agentId, mcp, game, bot, expectedClose = false, failure, worker;
async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, { ...options, redirect: 'error', headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers }, signal: AbortSignal.timeout(options.duplex ? 900000 : 30000) });
  for (const cookie of response.headers.getSetCookie()) { const at = cookie.indexOf('='); cookies.set(cookie.slice(0, at), cookie.slice(at + 1).split(';')[0]); } return response;
}
async function admin(endpoint, body, method = 'POST') {
  const response = await request(endpoint, { method, headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `Online QA admin: HTTP ${response.status}`); return response.status === 204 ? null : response.json();
}
async function tool(name, args = {}) { const result = await mcp.callTool({ name, arguments: args }); assert.notEqual(result.isError, true); return result.structuredContent.data; }
async function until(action, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (failure) throw failure; const result = await action(); if (result) return result; await delay(100); }
  throw new Error('Online backup QA timed out; inspect the owned game.log');
}
async function start(root) {
  assert.ok(root === source || contains(directory, root));
  game = await ManagedGame.start(root, { output: chunk => appendFileSync(path.join(directory, 'game.log'), chunk) }); return game;
}
async function connect() {
  expectedClose = false; const state = { texts: [], held: null, spawned: false };
  bot = await localGameClient('http://127.0.0.1:19152', 'ArchiveQA', error => { if (!expectedClose) failure = error; }, offlineIdentity);
  bot.on('text', packet => state.texts.push(packet)); bot.on('spawn', () => { state.spawned = true; });
  bot.on('inventory_content', packet => { if (['inventory', 0].includes(packet.window_id)) state.held = packet.input[0]; });
  bot.on('inventory_slot', packet => { if (['inventory', 0].includes(packet.window_id) && packet.slot === 0) state.held = packet.item; });
  bot.on('disconnect', () => { if (!expectedClose) failure = new Error('Actual player disconnected during a live backup'); });
  await until(() => state.spawned, 45000); inputDriver(bot); state.playerKey = 'uuid:' + bot.profile.uuid.toLowerCase(); return state;
}
async function command(text) { game.child.stdin.write(text + '\n'); await delay(200); }
async function block(state, type) { const marker = randomUUID(); await command(`execute if block 2 105 2 ${type} run say ${marker}`); await until(() => state.texts.some(item => item.message.includes(marker))); }
async function chat(state, message) {
  bot.queue('text', { category: 'authored', type: 'chat', needs_translation: false, source_name: bot.profile.name, xuid: '', platform_chat_id: '', has_filtered_message: false, message });
  await until(() => state.texts.some(item => item.message === message));
}
async function recentBatch(folder, eventId) {
  const candidates = (await readdir(folder)).filter(name => name.endsWith('.pending')).sort().reverse().slice(0, 100);
  for (const name of candidates) {
    const body = JSON.parse(JSON.parse(await readFile(path.join(folder, name), 'utf8')).body);
    if (body.events.some(event => event.eventId === eventId)) return name;
  }
}
async function stop(state) {
  if (bot) { expectedClose = true; bot.close(); bot = null; await until(async () => (await tool('get_player_context', { serverId, playerKey: state.playerKey })).sessions[0].ended); }
  assert.equal(await game.stop(), 0); game = null;
}
async function centralRoundtrip(archive, backup, checkpoint) {
  const reservation = await admin(`/api/servers/${serverId}/backups`, { requestId: randomUUID(), kind: 'MANUAL',
    note: '在线完整归档、浏览器下载与实服恢复验收', permanent: true, expectedBytes: backup.archiveBytes });
  const response = await request(`/api/backups/${reservation.id}/content`, { method: 'PUT', duplex: 'half',
    headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/octet-stream', 'Content-Length': backup.archiveBytes }, body: createReadStream(archive) });
  assert.equal(response.status, 200); const record = await response.json();
  assert.equal(record.status, 'READY'); assert.equal(record.sha256, backup.sha256);
  assert.equal(record.summary.snapshotMode, 'BDS_SAVE_QUERY'); assert.equal(record.summary.coordination.nativeWriteCacheFlushed, true);
  assert.deepEqual(record.summary.coordination.collectorCheckpoint, checkpoint);
  assert.equal(record.worldRuntimeVerified, false);
  const { chromium } = await import('../../frontend/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true }), downloaded = path.join(directory, 'online-downloaded-through-browser.tar.gz');
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    await page.goto(base); await page.getByLabel('密码', { exact: true }).fill(environment.MCM_ADMIN_PASSWORD);
    await page.getByRole('button', { name: '进入工作台' }).click(); await page.getByRole('heading', { name: '数据总览', exact: true }).waitFor();
    await page.getByLabel('统计范围').selectOption(serverId);
    await page.locator('.sidebar').getByRole('button', { name: '备份中心', exact: true }).click();
    const card = page.locator(`[data-backup="${record.id}"]`); await card.waitFor();
    await card.getByText('查看完整性与统计衔接说明').click();
    assert.ok((await card.innerText()).includes('运行中世界快照')); assert.ok((await card.innerText()).includes('稳定副本'));
    const pending = page.waitForEvent('download'); await card.getByRole('link', { name: '下载完整备份' }).click();
    await (await pending).saveAs(downloaded); assert.equal(await digest(downloaded), backup.sha256);
    await page.locator(':focus').evaluateAll(elements => elements.forEach(element => element.blur()));
    await page.screenshot({ path: path.join(directory, 'production-online-backup.png'), fullPage: true });
  } finally { await browser.close(); }
  console.log(JSON.stringify({ stage: 'central-online-roundtrip', catalogId: record.id, sha256: record.sha256 }));
  return { archive: downloaded, catalogId: record.id };
}
try {
  csrf = await (await request('/api/auth/csrf')).json();
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { [csrf.headerName]: csrf.token }, body: new URLSearchParams({ username: environment.MCM_ADMIN_USERNAME ?? 'admin', password: environment.MCM_ADMIN_PASSWORD }) })).status, 204);
  csrf = await (await request('/api/auth/csrf')).json();
  let token = (await admin(`/api/servers/${serverId}/collector-credential`)).token;
  await writeFile(configPath, canonicalJson({ enabled: true, serverId, token, endpoint: base + '/api/ingest/v1/batches' }));
  const agent = await admin('/api/agents', { name: '在线备份实服验收', grants: [{ serverId, scopes: ['STATS_READ', 'CHAT_READ'] }] }); agentId = agent.account.id;
  mcp = new Client({ name: 'online-world-restore-verifier', version: '0.2.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(project, 'mcp/src/server.mjs')], env: { MCM_MCP_API_URL: base, MCM_AGENT_TOKEN: agent.token }, stderr: 'inherit' }));
  const after = (await tool('get_chat_messages', { serverId })).highWatermark;
  await start(source); const player = await connect();
  await command('gamemode creative ArchiveQA'); await command('tp ArchiveQA 0.5 100 0.5'); await command('setblock 2 105 2 gold_block'); await block(player, 'gold_block');
  await command('replaceitem entity ArchiveQA slot.hotbar 0 diamond 7'); await until(() => player.held?.count === 7);
  // A manual operator's hold is not this host's lease and must remain held.
  await command('save hold'); await until(async () => (await game.status()).nativeQuerySuccess > 0);
  await assert.rejects(createOnlineBackup({ root: source, output: path.join(directory, 'must-not-adopt.tar.gz'), serverId, game }), /UNOWNED_NATIVE_SNAPSHOT/);
  assert.ok((await game.status()).nativeQuerySuccess > 0); assert.equal(await missing(path.join(directory, 'must-not-adopt.tar.gz')), true);
  await command('save resume'); assert.equal((await game.status()).nativeQuerySuccess, 0);
  const item = { networkId: player.held.network_id, count: 7 }, originalMessage = '在线快照之前 ' + run;
  await writeFile(path.join(directory, 'restore-fixture.json'), canonicalJson({ offlineIdentity, item, worldMarker: 'gold_block', serverId }));
  await chat(player, originalMessage);
  const originalEvent = await until(async () => (await tool('get_chat_messages', { serverId, after })).items.find(row => row.text === originalMessage));
  const originalBatch = await until(() => recentBatch(sourceAcknowledged, originalEvent.eventId));
  const historicalFiles = (await readdir(sourceAcknowledged)).length;
  const originalPid = game.child.pid, liveMessages = Array.from({ length: 3 }, (_, i) => `备份期间仍可游戏和聊天 ${i + 1} ${run}`);
  const duringBatches = new Set();
  let readySeen = false, released = false, traffic;
  game.on('line', line => {
    const at = line.indexOf('MCM_ARCHIVE_BACKUP '); if (at < 0) return; let value; try { value = JSON.parse(line.slice(at + 19)); } catch { return; }
    if (value.phase === 'RELEASED') released = true;
    if (value.phase === 'READY' && !readySeen) {
      readySeen = true; game.child.stdin.write('setblock 2 105 2 air\nreplaceitem entity ArchiveQA slot.hotbar 0 diamond 11\n');
      traffic = (async () => {
        for (const text of liveMessages) {
          await chat(player, text);
          const event = await until(async () => (await tool('get_chat_messages', { serverId, after })).items.find(row => row.text === text));
          const name = await until(() => recentBatch(sourceAcknowledged, event.eventId));
          if (!released) duringBatches.add(name);
        }
      })().catch(error => { failure = error; });
    }
  });
  const archive = path.join(directory, 'online-full-server.tar.gz');
  const backup = await createOnlineBackup({ root: source, output: archive, serverId, game, note: '真实玩家在线期间的完整文件归档' });
  await traffic;
  if (failure) throw failure;
  assert.equal(game.child.pid, originalPid); assert.ok(readySeen && released);
  assert.ok(duringBatches.size >= 2, 'At least two real collector batches must be acknowledged before the snapshot is released');
  await block(player, 'air'); await until(() => player.held?.count === 11);
  const proof = await inspectBackup(archive); assert.equal(proof.manifest.snapshotMode, 'BDS_SAVE_QUERY'); assert.equal(proof.manifest.statistics.archiveBinding, 'VERIFIED');
  assert.equal(proof.manifest.statistics.cacheIntegrity, 'VERIFIED');
  const checkpoint = proof.manifest.coordination.collectorCheckpoint;
  assert.ok(checkpoint.records >= historicalFiles);
  const archivedNames = new Set(proof.manifest.files.map(row => path.posix.basename(row.path)));
  assert.ok(archivedNames.has(originalBatch));
  for (const name of duringBatches) {
    assert.ok(BigInt(name.slice(0, 20)) >= BigInt(checkpoint.nextSequence));
    assert.ok(!archivedNames.has(name));
  }
  assert.equal((await game.status()).nativeQuerySuccess, 0);
  console.log(JSON.stringify({ stage: 'actual-online-archive-created', backupId: backup.backupId, files: backup.fileCount, archiveBytes: backup.archiveBytes }));
  const outside = path.join(directory, 'junction-target'); await mkdir(outside); await writeFile(path.join(outside, 'sentinel'), 'preserve');
  const unsafe = path.join(source, 'plugins/online-backup-qa-link'); await symlink(outside, unsafe, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(createOnlineBackup({ root: source, output: path.join(directory, 'must-not-publish.tar.gz'), serverId, game }), /link|junction/); }
  finally { assert.equal(await realpath(unsafe), await realpath(outside)); await rm(unsafe); }
  assert.equal(await missing(path.join(directory, 'must-not-publish.tar.gz')), true); assert.equal((await game.status()).nativeQuerySuccess, 0);
  // Kill a real lease-owning process while the independent supervisor/game remain alive.
  worker = fork(fileURLToPath(new URL('./lease-owner.mjs', import.meta.url)), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let held; const leaseWorker = worker; worker.on('message', async message => {
    if (message.held) { held = message; return; }
    if (!['begin', 'query', 'release'].includes(message.action)) return;
    try { const result = await game.request(message.action, message.operationId);
      if (leaseWorker.connected) leaseWorker.send({ id: message.id, result }, error => { if (error && !leaseWorker.killed) failure = error; });
    } catch (error) { if (!leaseWorker.killed) failure = error; }
  });
  await until(() => held); const killedAt = Date.now(); worker.kill(); await until(async () => (await game.status()).phase === 'IDLE', 20000); worker = null;
  const leaseRecoveryMillis = Date.now() - killedAt; assert.ok(leaseRecoveryMillis < 15000); assert.equal((await game.status()).nativeQuerySuccess, 0);
  assert.equal(game.child.pid, originalPid); await block(player, 'air');
  await stop(player); const beforeRestore = await tool('get_player_context', { serverId, playerKey: player.playerKey });
  const central = process.argv.includes('--central-roundtrip') ? await centralRoundtrip(archive, backup, checkpoint) : null;
  token = (await admin(`/api/servers/${serverId}/collector-credential`)).token;
  const destination = path.join(directory, 'restored-server'); await restoreBackup({ file: central?.archive ?? archive, destination, mode: 'CONTINUE', targetServerId: serverId, collectorToken: token, endpoint: base + '/api/ingest/v1/batches' });
  const outbox = path.join(destination, 'plugins/archive-collector/data/outbox'), acknowledged = path.join(outbox, 'acknowledged');
  await rename(path.join(acknowledged, originalBatch), path.join(outbox, originalBatch));
  await start(destination); const restored = await connect(); console.log(JSON.stringify({ stage: 'restored-online-player', held: restored.held }));
  await until(() => restored.held?.count === item.count && restored.held.network_id === item.networkId); await block(restored, 'gold_block');
  await until(async () => (await readdir(acknowledged)).includes(originalBatch));
  const context = await tool('get_player_context', { serverId, playerKey: restored.playerKey });
  const chatCount = value => value.statistics.metrics.find(metric => metric.key === 'chat.messages').value;
  assert.equal(chatCount(context), chatCount(beforeRestore));
  const chats = await tool('get_chat_messages', { serverId, after, limit: 200 });
  assert.equal(chats.items.filter(row => row.eventId === originalEvent.eventId).length, 1);
  for (const text of liveMessages) assert.equal(chats.items.filter(row => row.text === text).length, 1);
  await stop(restored);
  const evidence = { verifiedAt: new Date().toISOString(), backupId: backup.backupId, archiveSha256: backup.sha256, archiveBytes: backup.archiveBytes, fileCount: backup.fileCount,
    bdsVersion: '1.26.51.1', leviLaminaVersion: '26.51.8', collectorVersion, realGameplay: true, snapshotMode: 'BDS_SAVE_QUERY',
    catalogId: central?.catalogId ?? null, uploadedThroughNginxAndContainerVerifier: !!central,
    actualBrowserDownloadRestoredAndBooted: !!central,
    actualPlayerChatReceivedWhileSnapshotHeld: duringBatches.size >= 2, sameGameProcessThroughoutCaptureAndFaults: true,
    collectorCheckpoint: checkpoint, historicalFiles, newBatchesAcknowledgedWhileHeld: duringBatches.size,
    nativeLengthsAndArchiveChecksumsVerified: true, nativeWriteCacheBarrierConfirmed: proof.manifest.coordination.nativeWriteCacheFlushed,
    unownedManualSnapshotNotAdoptedOrReleased: true, failedCopyNotPublishedAndNativeSaveResumed: true,
    actualLeaseOwnerProcessKilled: true, independentSupervisorKeptRunning: true, leaseRecoveryMillis,
    snapshotWorldAndInventoryRestored: true, originalNativeBatchReplayDeduplicated: true, newerCentralHistoryPreserved: true,
    cleanSourceAndRestoredStops: true, worldRuntimeVerified: true, automaticSchedulingTested: false, thirdPartyTransactionalPluginsTested: false };
  await writeFile(path.join(project, '.tools/online-backup-evidence.json'), canonicalJson(evidence));
  await writeFile(path.join(directory, 'evidence.json'), canonicalJson(evidence)); console.log(JSON.stringify(evidence, null, 2));
} finally {
  worker?.kill(); expectedClose = true; bot?.close(); if (game) await game.stop().catch(() => {});
  await mcp?.close(); if (agentId) await admin(`/api/agents/${agentId}`, undefined, 'DELETE').catch(() => {});
  if (csrf) await admin(`/api/servers/${serverId}/collector-credential`, undefined, 'DELETE').catch(() => {});
  await writeFile(configPath, originalConfig);
}
