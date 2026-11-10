import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { localGameClient } from './http-client.mjs';
import { verifyBasicBehavior } from './basic-behavior.mjs';
import { dimensionNames, verifyDimensions } from './dimensions.mjs';
import { verifyLevels } from './levels.mjs';
import { verifyActions } from './actions.mjs';
import { verifyItems } from './items.mjs';
import { verifyCompletedUses } from './completed-use.mjs';
import { verifyPlacement } from './placement.mjs';
import { verifyCrops } from './crops.mjs';
import { verifyKills } from './kills.mjs';
import { verifySpecialKills } from './special-kills.mjs';
import { verifyBreeding } from './breeding.mjs';
import { verifyCrafting } from './crafting.mjs';
import { verifyTrades } from './trades.mjs';
import { verifyFishing } from './fishing.mjs';
import { verifyMovement } from './movement.mjs';
import { verifySessionLifecycle } from './session-lifecycle.mjs';
import { verifyCollectorDiagnostics } from './collector-diagnostics.mjs';
import { verifyQqBinding } from './qq-binding.mjs';
import { verifyWorldState } from './world-state.mjs';
import { assertServerStopped } from '../../backup/src/processes.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)), qa = path.join(root, '.tools/game-qa-26.51.8');
const owner = JSON.parse(readFileSync(path.join(qa, 'qa-provenance.json'))); assert.equal(owner.owner, 'MCManager-archive-isolated-qa');
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'; assert.equal(new URL(base).hostname, '127.0.0.1');
const env = Object.fromEntries(readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('MCM_') && line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const fixturePath = path.join(qa, 'live-chat-fixture.json');
const crashRecovery = process.argv.includes('--crash-after-delivery');
const replyRetries = process.argv.includes('--with-reply-retries');
const telemetryOutage = process.argv.includes('--with-telemetry-outage');
const sessionLifecycle = process.argv.includes('--with-session-lifecycle');
const collectorDiagnostics = process.argv.includes('--with-collector-diagnostics');
const legacySessionReplay = process.argv.includes('--verify-legacy-session-replay');
assert.ok(!legacySessionReplay || sessionLifecycle, 'Legacy session replay is part of session lifecycle acceptance');
assert.ok(!(replyRetries && crashRecovery), 'Run reply retry and crash fixtures separately');
const withReplies = process.argv.includes('--with-replies') || crashRecovery || replyRetries;
const withQqBinding = process.argv.includes('--with-qq-binding');
const withWorldState = process.argv.includes('--with-world-state');
const withBehaviors = process.argv.includes('--with-behaviors');
const withDimensions = process.argv.includes('--with-dimensions');
const withLevels = process.argv.includes('--with-levels');
const withActions = process.argv.includes('--with-actions');
const withItems = process.argv.includes('--with-items');
const withCompletedUses = process.argv.includes('--with-completed-uses');
const withPlacement = process.argv.includes('--with-placement');
const withCrops = process.argv.includes('--with-crops');
const withPetRestart=process.argv.includes('--with-pet-restart');
const hardPetRestart=process.argv.includes('--hard-pet-restart');
assert.ok(!hardPetRestart || withPetRestart, 'Hard pet restart requires the pet restart fixture');
const withSpecialKills=process.argv.includes('--with-special-kills') || withPetRestart;
const withBreeding=process.argv.includes('--with-breeding');
const withCrafting=process.argv.includes('--with-crafting');
const withTrades=process.argv.includes('--with-trades');
const withFishing=process.argv.includes('--with-fishing');
const probeMovement=process.argv.includes('--probe-movement');
const thresholdOnly=process.argv.includes('--with-activity-threshold');
const withMovement=probeMovement||thresholdOnly||process.argv.includes('--with-movement');
assert.ok(!withMovement||(!withFishing&&!withTrades&&!withCrafting&&!withBreeding&&!process.argv.includes('--with-kills')&&!withSpecialKills&&!withBehaviors&&!withReplies&&!withDimensions&&!withLevels&&!withActions&&!withItems&&!withCompletedUses&&!withPlacement&&!withCrops),'Run movement acceptance separately');
const withKills = process.argv.includes('--with-kills') || withSpecialKills;
assert.ok(!withFishing||(!withTrades&&!withCrafting&&!withBreeding&&!withKills&&!withItems&&!withBehaviors&&!withDimensions&&!withReplies&&!withLevels&&!withActions&&!withCompletedUses&&!withPlacement&&!withCrops),'Run fishing acceptance separately');
assert.ok(!withTrades||(!withCrafting&&!withBreeding&&!withKills&&!withItems&&!withBehaviors&&!withDimensions&&!withReplies&&!withLevels&&!withActions&&!withCompletedUses&&!withPlacement&&!withCrops),'Run trading acceptance separately');
assert.ok(!withCrafting||(!withBreeding&&!withKills&&!withItems&&!withBehaviors&&!withDimensions&&!withReplies&&!withLevels&&!withActions&&!withCompletedUses&&!withPlacement&&!withCrops),'Run crafting acceptance separately');
assert.ok(!withBreeding||(!withKills&&!withItems&&!withBehaviors&&!withDimensions&&!withReplies&&!withLevels&&!withActions&&!withCompletedUses&&!withPlacement&&!withCrops),'Run breeding acceptance separately');
assert.ok(!withKills || (!withItems && !withBehaviors && !withDimensions && !withReplies && !withLevels && !withActions && !withCompletedUses && !withPlacement && !withCrops), 'Run kill acceptance separately');
assert.ok(!withCrops || (!withItems && !withBehaviors && !withDimensions && !withReplies && !withLevels && !withActions && !withCompletedUses && !withPlacement), 'Run crop acceptance separately');
assert.ok(!withPlacement || (!withItems && !withBehaviors && !withDimensions && !withReplies && !withLevels && !withActions && !withCompletedUses), 'Run placement acceptance separately');
assert.ok(!withCompletedUses || (!withItems && !withBehaviors && !withDimensions && !withReplies && !withLevels && !withActions), 'Run completed-use acceptance separately');
assert.ok(!withItems || (!withBehaviors && !withDimensions && !withReplies && !withLevels && !withActions), 'Run item acceptance separately');
assert.ok(!withActions || (!withBehaviors && !withDimensions && !withReplies && !withLevels), 'Run action acceptance separately from the other game fixtures');
assert.ok(!withLevels || (!withBehaviors && !withDimensions && !withReplies), 'Run level acceptance separately from death, dimension and reply fixtures');
const configFile = path.join(qa, 'plugins/archive-collector/config/config.json');
const originalConfig = existsSync(configFile) ? readFileSync(configFile) : undefined;
const cookies = new Map(); let csrf, serverId, agentId, child, exited, code, bot, mcp; let output = '', clientFailure;
const log = path.join(qa, 'live-chat-verification.log');
let proxy, releaseAcks = false, heldAckCount = 0, closingBot = { expected: false }, configChanged = false;
const heldAcks = [];
let rejectedClaims = 0, lostAckResponses = 0, retryAckRoute;
const retriedAckBodies = [];
let telemetryPhase = 'offline', failedHeartbeats = 0, failedEventRequests = 0, outageMessage;
const outageReceipts = [];
async function faultProxy() {
  proxy = createServer(async (incoming, outgoing) => {
    try {
      const chunks = []; let length = 0;
      for await (const chunk of incoming) { length += chunk.length; assert.ok(length <= 1_048_576); chunks.push(chunk); }
      const requestBody = Buffer.concat(chunks);
      const batch = telemetryOutage && incoming.url === '/api/ingest/v1/batches' ? JSON.parse(requestBody) : null;
      if (batch && (telemetryPhase === 'offline' || (telemetryPhase === 'heartbeat-only' && batch.events.length))) {
        if (batch.events.length) failedEventRequests++; else failedHeartbeats++;
        outgoing.writeHead(503); outgoing.end(); return;
      }
      if (replyRetries && incoming.url.endsWith('/commands/claim') && rejectedClaims < 2) {
        rejectedClaims++; outgoing.writeHead(503); outgoing.end(); return;
      }
      const isAck = /\/commands\/[0-9a-f-]+\/ack$/.test(incoming.url);
      if (replyRetries && isAck && !retryAckRoute) retryAckRoute = incoming.url;
      if (replyRetries && incoming.url === retryAckRoute) retriedAckBodies.push(Buffer.concat(chunks).toString('utf8'));
      const forward = async () => {
        if (outgoing.destroyed) return;
        const response = await fetch(base + incoming.url, { method: incoming.method, headers: { Authorization: incoming.headers.authorization, 'Content-Type': 'application/json' },
          body: requestBody, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        const body = Buffer.from(await response.arrayBuffer());
        if (batch && response.ok && batch.events.some(event => event.kind === 'CHAT' && event.text === outageMessage)) {
          outageReceipts.push({ request: requestBody.toString('utf8'), receipt: JSON.parse(body) });
          if (outageReceipts.length === 1) { outgoing.writeHead(503); outgoing.end(); return; }
        }
        // The backend has committed the real receipt, but the collector cannot
        // know it. Retry must preserve that receipt and must not resend text.
        if (replyRetries && incoming.url === retryAckRoute && response.status === 200 && lostAckResponses < 2) {
          lostAckResponses++; outgoing.writeHead(503); outgoing.end(); return;
        }
        outgoing.writeHead(response.status, { 'Content-Type': 'application/json' }); outgoing.end(body);
      };
      if (crashRecovery && isAck && !releaseAcks) { heldAckCount++; heldAcks.push(forward); }
      else await forward();
    } catch { if (!outgoing.destroyed) { outgoing.writeHead(502); outgoing.end(); } }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + proxy.address().port;
}
async function launchGame() {
  output = ''; code = undefined;
  const process = spawn(path.join(qa, 'bedrock_server_mod.exe'), [], { cwd: qa, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); child = process;
  exited = new Promise((resolve, reject) => { process.once('exit', value => { if (child === process) code = value; resolve(value); }); process.once('error', reject); });
  for (const stream of [process.stdout, process.stderr]) stream.on('data', chunk => { if (child === process) output += chunk; appendFileSync(log, chunk); });
  await until(() => /Player session checkpoints and confirmed public chat capture enabled/.test(output), 60_000);
  await until(() => /Server started/.test(output), 60_000);
}
async function connectBot(name = 'ArchiveQA', beforeSpawn) {
  const state = { expected: false }; closingBot = state;
  bot = await localGameClient('http://127.0.0.1:19152', name, error => { if (!state.expected) clientFailure = error; });
  beforeSpawn?.(bot);
  bot.archiveQaCraftingPackets=[];bot.on('crafting_data',packet=>bot.archiveQaCraftingPackets.push(packet));bot.on('item_registry',packet=>{bot.archiveQaItemRegistry=packet.itemstates;});bot.on('creative_content',packet=>{bot.archiveQaCreativeContent=packet.items;});
  const received = []; bot.on('text', packet => received.push(packet));
  bot.on('disconnect', packet => { if (!state.expected) clientFailure = new Error('Game disconnected the test player: ' + JSON.stringify(packet)); });
  let spawned = false; bot.on('spawn', () => { spawned = true; }); await until(() => spawned, 45_000);
  bot.queue('serverbound_loading_screen', {type:2});
  return received;
}
async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, { ...options, redirect: 'error', headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers }, signal: AbortSignal.timeout(30_000) });
  for (const cookie of response.headers.getSetCookie()) { const at = cookie.indexOf('='); cookies.set(cookie.slice(0, at), cookie.slice(at + 1).split(';')[0]); }
  return response;
}
async function admin(endpoint, body, method = 'POST') {
  const response = await request(endpoint, { method, headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `Admin ${endpoint}: HTTP ${response.status}`); return response.status === 204 ? null : response.json();
}
async function until(action, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (clientFailure) throw clientFailure; const result = await action(); if (result) return result; if (code !== undefined) throw new Error(`Isolated game exited: ${code}`); await delay(100); }
  throw new Error('Live game verification deadline exceeded; inspect live-chat-verification.log');
}
async function tool(name, args = {}) {
  const result = await mcp.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, `${name} returned an MCP error`); return result.structuredContent.data;
}
try {
  await assertServerStopped(qa);
  writeFileSync(log, '');
  if (withBehaviors || withLevels || withActions || withItems || withCompletedUses || withPlacement || withCrops || withKills || withBreeding || withCrafting || withTrades || withFishing || withMovement || collectorDiagnostics) cpSync(path.join(root, 'collector/bin/archive-qa-guards'), path.join(qa, 'plugins/archive-qa-guards'), { recursive: true });
  csrf = await (await request('/api/auth/csrf')).json();
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { [csrf.headerName]: csrf.token }, body: new URLSearchParams({ username: env.MCM_ADMIN_USERNAME ?? 'admin', password: env.MCM_ADMIN_PASSWORD }) })).status, 204);
  csrf = await (await request('/api/auth/csrf')).json();
  if (existsSync(fixturePath)) serverId = JSON.parse(readFileSync(fixturePath)).serverId;
  else {
    serverId = (await admin('/api/servers', { name: '原生实服验收 · LL 26.51.8', description: 'Actual isolated BDS player protocol tests; no production world', startDate: '2020-01-01' })).id;
    writeFileSync(fixturePath, JSON.stringify({ serverId, owner: owner.owner }, null, 2));
  }
  const token = (await admin(`/api/servers/${serverId}/collector-credential`)).token;
  const collectorBase = crashRecovery || replyRetries || telemetryOutage ? await faultProxy() : base;
  const configDir = path.join(qa, 'plugins/archive-collector/config'); mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ enabled: true, serverId, token, endpoint: collectorBase + '/api/ingest/v1/batches', ...(thresholdOnly ? {activityIdleSeconds:30} : {}) }, null, 2));
  configChanged = true;
  const agent = await admin('/api/agents', { name: withReplies ? '实服 MCP 回复验收' : '实服 MCP 只读验收', grants: [{ serverId, scopes: ['STATS_READ', 'CHAT_READ', ...(withReplies ? ['CHAT_SEND'] : []), ...(withQqBinding ? ['QQ_BIND'] : []), ...(withWorldState ? ['WORLD_READ'] : [])] }] }); agentId = agent.account.id;
  mcp = new Client({ name: 'native-player-chat-verifier', version: '0.1.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/src/server.mjs')], env: { MCM_MCP_API_URL: base, MCM_AGENT_TOKEN: agent.token }, stderr: 'inherit' }));
  const before = await tool('get_chat_messages', { serverId });
  const dimensionBaselines = {};
  if (withDimensions) {
    const players = await tool('list_players', { serverId, pageSize: 100 }); assert.ok(players.total <= 100);
    for (const player of players.items) dimensionBaselines[player.key] = await Promise.all(dimensionNames.map(dimension => tool('get_player_statistics', { serverId, playerKey: player.key, dimension })));
  }
  const movementBaselines = {};
  const movementStart = withMovement ? (await tool('get_recent_activity', {serverId})).highWatermark : undefined;
  if (withMovement) {
    const players = await tool('list_players', {serverId, pageSize:100});
    assert.ok(players.total <= 100);
    for (const player of players.items) movementBaselines[player.key] = await tool('get_player_statistics', {serverId, playerKey:player.key});
  }
  const launchedAt = Date.now();
  await launchGame(); const received = await connectBot();
  console.log(JSON.stringify({ stage: 'actual-player-spawned', name: bot.profile.name, uuid: bot.profile.uuid }));
  const message = '原生玩家聊天验收 ' + randomUUID();
  if (telemetryOutage) outageMessage = message;
  bot.queue('text', { category: 'authored', type: 'chat', needs_translation: false, source_name: bot.profile.name, xuid: '', platform_chat_id: '', has_filtered_message: false, message });
  await until(() => received.some(packet => packet.message === message));
  console.log(JSON.stringify({ stage: 'actual-client-chat-received', sourceName: received.find(packet => packet.message === message).source_name }));
  const spool = path.join(qa, 'plugins/archive-collector/data/outbox');
  const acknowledged = path.join(spool, 'acknowledged');
  const collectorStatus = async () => {
    const response = await request(`/api/collectors?serverId=${serverId}`);
    assert.equal(response.status, 200);
    return (await response.json())[0];
  };
  let outageEvidence;
  if (telemetryOutage) {
    const cached = await until(() => {
      for (const name of readdirSync(spool)) {
        if (!name.endsWith('.pending')) continue;
        const record = JSON.parse(readFileSync(path.join(spool, name), 'utf8'));
        const batch = JSON.parse(record.body);
        if (batch.events.some(event => event.kind === 'CHAT' && event.text === message)) return { record, batch };
      }
      return null;
    });
    await until(() => failedHeartbeats > 0 && failedEventRequests > 0);
    const invisible = async () => assert.ok(!(await tool('get_chat_messages', { serverId, after: before.highWatermark })).items.some(item => item.text === message));
    await invisible();
    telemetryPhase = 'heartbeat-only';
    const replaying = await until(async () => {
      const status = await collectorStatus();
      return status.collector?.bootId === cached.batch.collector.bootId && status.connectionState === 'REPLAYING' ? status : null;
    });
    assert.ok(replaying.collector.pendingEvents >= cached.batch.events.length);
    await invisible();
    console.log(JSON.stringify({ stage: 'heartbeat-recovered-while-event-upload-blocked', pendingEvents: replaying.collector.pendingEvents }));
    telemetryPhase = 'online';
    await until(() => outageReceipts.length >= 2);
    assert.equal(outageReceipts.length, 2);
    assert.ok(outageReceipts.every(attempt => attempt.request === cached.record.body));
    assert.equal(outageReceipts[0].receipt.duplicateBatch, false);
    assert.equal(outageReceipts[0].receipt.acceptedEvents, cached.batch.events.length);
    assert.equal(outageReceipts[1].receipt.duplicateBatch, true);
    assert.equal(outageReceipts[1].receipt.acceptedEvents, 0);
    assert.equal(outageReceipts[1].receipt.duplicateEvents, cached.batch.events.length);
    outageEvidence = { bootId: cached.batch.collector.bootId, failedHeartbeats, failedEventRequests,
      reportedPendingEvents: replaying.collector.pendingEvents, originalBytesRetried: true, committedResponseLost: true };
  }
  const messages = await until(async () => {
    const page = await tool('get_chat_messages', { serverId, after: before.highWatermark }); return page.items.some(item => item.text === message) ? page : null;
  });
  const actual = messages.items.filter(item => item.text === message); assert.equal(actual.length, 1); assert.equal(actual[0].source, 'PLAYER');
  const playerKey = actual[0].playerKey;
  const qqBindingEvidence = withQqBinding ? await verifyQqBinding({ bot, received, until, tool, serverId, playerKey }) : undefined;
  const worldStateEvidence = withWorldState ? await verifyWorldState({ bot, tool, serverId, playerKey, until,
    command:text=>child.stdin.write(text+'\n'), reconnect:async whileOffline=>{
      closingBot.expected=true;bot.close();bot=null;
      await until(async()=>(await tool('get_player_context',{serverId,playerKey})).sessions[0]?.ended);
      await whileOffline();await connectBot();return bot;
    } }) : undefined;
  assert.equal(playerKey, 'uuid:' + bot.profile.uuid.toLowerCase());
  // Chat may commit before the next game-thread session checkpoint. Wait for
  // this boot's session rather than mistaking a previous ended session for it.
  const context = await until(async()=>{const value=await tool('get_player_context',{serverId,playerKey});return Date.parse(value.sessions[0]?.startedAt)>=launchedAt&&!value.sessions[0]?.ended?value:null;});
  assert.equal(context.player.name, bot.profile.name); assert.ok(context.sessions.length > 0);
  assert.ok(Date.parse(context.sessions[0].startedAt) >= launchedAt, 'Context must contain the current game session');
  const initialOnline = BigInt(context.statistics.metrics.find(item => item.key === 'online.millis').value ?? '0');
  const initialChatCount = context.statistics.metrics.find(item => item.key === 'chat.messages').value;
  let original;
  await until(() => {
    for (const name of readdirSync(acknowledged)) {
      if (!name.endsWith('.pending')) continue;
      const record = JSON.parse(readFileSync(path.join(acknowledged, name), 'utf8'));
      if (JSON.parse(record.body).events.some(event => event.eventId === actual[0].eventId)) { original = record.body; return true; }
    }
    return false;
  });
  const replayResponse = await request('/api/ingest/v1/batches', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: original });
  assert.equal(replayResponse.status, 200); const replay = await replayResponse.json(); assert.equal(replay.duplicateBatch, true); assert.equal(replay.acceptedEvents, 0);
  if (legacySessionReplay) {
    let legacy;
    for (const name of readdirSync(acknowledged)) {
      if (!name.endsWith('.pending')) continue;
      const batch = JSON.parse(JSON.parse(readFileSync(path.join(acknowledged, name), 'utf8')).body);
      if (batch.collector.version === '0.20.1' && batch.events.some(event => event.kind === 'SESSION' && event.sequence === 0)) {
        legacy = batch;
        break;
      }
    }
    assert.ok(legacy, 'This check requires a previously acknowledged 0.20.1 session start in the QA archive');
    const response = await request('/api/ingest/v1/batches', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...legacy, batchId: randomUUID() }) });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.duplicateBatch, false);
    assert.equal(receipt.duplicateEvents, legacy.events.length);
    assert.equal(receipt.acceptedEvents, 0);
  }
  assert.equal((await tool('get_player_statistics', { serverId, playerKey })).metrics.find(item => item.key === 'chat.messages').value, initialChatCount);
  assert.equal((await tool('get_chat_messages', { serverId, after: before.highWatermark })).items.filter(item => item.text === message).length, 1);
  await delay(5500);
  const statistics = await until(async () => {
    const result = await tool('get_player_statistics', { serverId, playerKey }); return BigInt(result.metrics.find(item => item.key === 'online.millis').value ?? '0') >= initialOnline + 5000n ? result : null;
  });
  const diagnosticsEvidence = collectorDiagnostics ? await verifyCollectorDiagnostics({
    bot, received, status: collectorStatus, spool, until, command: text => child.stdin.write(text + '\n'), diagnostics: () => output,
    readChat: () => tool('get_chat_messages', { serverId, after: before.highWatermark }),
    replay: async body => {
      const response = await request('/api/ingest/v1/batches', { method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 200); return response.json();
    },
  }) : undefined;
  const checkLifecycle = sessionLifecycle ? await verifySessionLifecycle({
    context, bot, received, until, command: text => child.stdin.write(text + '\n'), diagnostics: () => output,
    readContext: () => tool('get_player_context', { serverId, playerKey }),
    readChat: () => tool('get_chat_messages', { serverId, after: before.highWatermark }),
    reconnect: async () => {
      closingBot.expected = true; bot.close(); bot = null;
      await until(async () => (await tool('get_player_context', { serverId, playerKey })).sessions[0]?.ended);
      await connectBot();
    },
  }) : undefined;
  let deliveredReply;
  if (withReplies) {
    const observedOnline = statistics.metrics.find(item => item.key === 'online.millis').value;
    const replyText = `本服确认在线时间为 ${observedOnline} 毫秒。`;
    const send = { serverId, requestId: randomUUID(), replyTo: actual[0].eventId, targetPlayerKey: playerKey, text: replyText, ttlSeconds: 60 };
    deliveredReply = await tool('send_chat_reply', send);
    assert.equal((await tool('send_chat_reply', send)).id, deliveredReply.id);
    const expected = '[' + deliveredReply.agentName + '] ' + replyText;
    await until(() => received.some(packet => packet.message === expected));
    if (crashRecovery) {
      await until(() => heldAckCount > 0);
      const records = path.join(qa, 'plugins/archive-collector/data/replies/records');
      const finishedFile = readdirSync(records).find(name => name.startsWith(deliveredReply.id + '_') && name.endsWith('_2.json'));
      assert.ok(finishedFile, 'Execution result must be durable before the held acknowledgement');
      const finished = JSON.parse(JSON.parse(readFileSync(path.join(records, finishedFile), 'utf8')).body);
      assert.equal(finished.result.outcome, 'DELIVERED');
      const beforeCrash = await tool('get_reply_status', { replyId: deliveredReply.id }); assert.notEqual(beforeCrash.status, 'DELIVERED');
      const oldSessionId = (await tool('get_player_context', { serverId, playerKey })).sessions[0].sessionId;
      const killedAt = Date.now(); closingBot.expected = true; child.kill(); await exited; bot.close(); bot = null; clientFailure = undefined;
      console.log(JSON.stringify({ stage: 'game-killed-with-durable-unconfirmed-reply', replyId: deliveredReply.id }));
      await launchGame(); const afterRestart = await connectBot();
      await until(() => heldAckCount >= 2);
      releaseAcks = true; await Promise.all(heldAcks.splice(0).map(forward => forward()));
      await until(async () => (await tool('get_reply_status', { replyId: deliveredReply.id })).status === 'DELIVERED');
      assert.equal((await tool('get_reply_status', { replyId: deliveredReply.id })).completedAt, finished.result.sentAt);
      await delay(1500); assert.equal(afterRestart.filter(packet => packet.message === expected).length, 0);
      const recoveredContext = await tool('get_player_context', { serverId, playerKey });
      const interrupted = recoveredContext.sessions.find(session => session.sessionId === oldSessionId);
      assert.ok(interrupted?.ended); assert.equal(interrupted.endReason, 'REPLACED');
      assert.ok(Date.parse(interrupted.checkpointAt) <= killedAt, 'Crash gap must not extend the old session');
      assert.equal(BigInt(interrupted.onlineMillis), BigInt(Date.parse(interrupted.checkpointAt) - Date.parse(interrupted.startedAt)));
      assert.ok(Date.parse(recoveredContext.sessions[0].startedAt) > killedAt);
    }
    await until(async () => (await tool('get_reply_status', { replyId: deliveredReply.id })).status === 'DELIVERED');
    if (replyRetries) {
      const records = path.join(qa, 'plugins/archive-collector/data/replies/records');
      await until(() => readdirSync(records).some(name => name.startsWith(deliveredReply.id + '_') && name.endsWith('_3.json')));
      assert.equal(rejectedClaims, 2); assert.equal(lostAckResponses, 2); assert.equal(retriedAckBodies.length, 3);
      assert.ok(retriedAckBodies.every(body => body === retriedAckBodies[0]), 'Retry must use identical native receipt bytes');
      assert.match(output, /Game reply worker retrying claim \(HTTP 503\)/);
      assert.match(output, /Game reply worker recovered after claim \(HTTP 503\)/);
      assert.match(output, /Game reply worker retrying ack \(HTTP 503\)/);
      assert.match(output, /Game reply worker recovered after ack \(HTTP 503\)/);
    }
    await delay(1000); assert.equal(received.filter(packet => packet.message === expected).length, 1);
    const defaultInput = await tool('get_chat_messages', { serverId, after: before.highWatermark });
    assert.equal(defaultInput.items.filter(item => item.source === 'AGENT').length, 0);
    const allSources = await tool('get_chat_messages', { serverId, after: before.highWatermark, includeAgents: true });
    assert.equal(allSources.items.filter(item => item.eventId === deliveredReply.id && item.source === 'AGENT').length, 1);
    assert.equal((await tool('get_player_statistics', { serverId, playerKey })).metrics.find(item => item.key === 'chat.messages').value, initialChatCount);
    console.log(JSON.stringify({ stage: 'native-reply-received-and-confirmed', replyId: deliveredReply.id }));
  }
  const dimensionEvidence = withDimensions ? await verifyDimensions({ bot, command: text => child.stdin.write(text + '\n'), until, tool, serverId, playerKey, baselines: dimensionBaselines, cache: acknowledged }) : undefined;
  const behaviorEvidence = withBehaviors ? await verifyBasicBehavior({ bot, command: text => child.stdin.write(text + '\n'), until, tool, serverId, playerKey, deathByZombie: process.argv.includes('--death-by-zombie') }) : undefined;
  const movementEvidence = withMovement ? await verifyMovement({
    bot, command: text => child.stdin.write(text + '\n'), until, diagnostics: () => output, tool, serverId, playerKey,
    cache: acknowledged, bootId: JSON.parse(original).collector.bootId, beforeBoot: movementBaselines[playerKey],
    activityStart: movementStart, probeOnly: probeMovement, idleSeconds: thresholdOnly ? 30 : 300, thresholdOnly,
    replayBatch: async body => {
      const response = await request('/api/ingest/v1/batches', {method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});
      assert.equal(response.status,200); return response.json();
    },
  }) : undefined;
  const fishingEvidence=withFishing?await verifyFishing({bot,command:text=>child.stdin.write(text+'\n'),until,diagnostics:()=>output,tool,serverId,playerKey,cache:acknowledged,replayBatch:async body=>{const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});assert.equal(response.status,200);return response.json();}}):undefined;
  const tradeEvidence=withTrades?await verifyTrades({bot,command:text=>child.stdin.write(text+'\n'),until,diagnostics:()=>output,tool,serverId,playerKey,cache:acknowledged,
    replayBatch:async body=>{const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});assert.equal(response.status,200);return response.json();},
  }):undefined;
  const craftingEvidence=withCrafting?await verifyCrafting({bot,command:text=>child.stdin.write(text+'\n'),until,diagnostics:()=>output,tool,serverId,playerKey,cache:acknowledged,
    replayBatch:async body=>{const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});assert.equal(response.status,200);return response.json();},
  }):undefined;
  const breedingEvidence=withBreeding?await verifyBreeding({bot,command:text=>child.stdin.write(text+'\n'),until,diagnostics:()=>output,tool,serverId,playerKey,cache:acknowledged,
    reconnect:async whileOffline=>{closingBot.expected=true;bot.close();bot=null;await until(async()=>(await tool('get_player_context',{serverId,playerKey})).sessions[0]?.ended);await whileOffline();await connectBot();return bot;},
    replayBatch:async body=>{const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});assert.equal(response.status,200);return response.json();},
  }):undefined;
  const killEvidence = withKills ? await (withSpecialKills?verifySpecialKills:verifyKills)({bot,command:text=>child.stdin.write(text+'\n'),until,diagnostics:()=>output,tool,serverId,playerKey,cache:acknowledged,
    reconnect:async whileOffline=>{closingBot.expected=true;bot.close();bot=null;await until(async()=>(await tool('get_player_context',{serverId,playerKey})).sessions[0]?.ended);await whileOffline();await connectBot();return bot;},
    restartForPet: withPetRestart ? async watch => {
      let snapshot;
      if (hardPetRestart) {
        const operationId = randomUUID();
        async function control(action, bootId) {
          const requestId = randomUUID(), offset = output.length;
          child.stdin.write(`archivebackup ${action} ${operationId} ${requestId} ${bootId} 0\n`);
          return until(() => {
            const line = output.slice(offset).split(/\r?\n/).slice(0,-1)
              .find(line=>line.includes('MCM_ARCHIVE_BACKUP ') && line.includes(requestId));
            if (!line) return;
            const value = JSON.parse(line.split('MCM_ARCHIVE_BACKUP ')[1]);
            assert.equal(value.requestId,requestId);
            assert.equal(value.operationId,operationId);
            if (bootId !== 'bootstrap') assert.equal(value.bootId,bootId);
            return value;
          });
        }
        const {bootId} = await control('status','bootstrap');
        let ready = await control('begin',bootId);
        await until(async()=>{
          if (ready.phase === 'READY') return true;
          assert.equal(ready.phase,'PREPARING');
          ready = await control('query',bootId);
        });
        assert.equal(ready.nativeWriteCacheFlushed,true);
        let released;
        await until(async()=>{
          released = await control('release',bootId);
          if (released.phase === 'RELEASED') return true;
          assert.equal(released.phase,'RELEASING');
        });
        snapshot = {nativeWriteCacheFlushed:true, snapshotReleased:true};
      }
      closingBot.expected = true;
      bot.close(); bot = null;
      const pid = child.pid;
      if (hardPetRestart) assert.equal(child.kill('SIGKILL'), true);
      else child.stdin.write('stop\n');
      const exitCode = await Promise.race([exited, delay(45_000, undefined, {ref:false}).then(() => {throw new Error('Pet fixture game stop timed out');})]);
      if (hardPetRestart) {assert.notEqual(exitCode,0); assert.doesNotMatch(output, /Quit correctly/);}
      else {assert.equal(exitCode, 0); assert.match(output, /Quit correctly/);}
      await launchGame();
      assert.notEqual(child.pid, pid);
      await connectBot('ArchivePetQA', watch);
      return {observer:bot, restartMode:hardPetRestart?'HARD':'GRACEFUL', ...(snapshot?{snapshot}:{})};
    } : undefined,
    replayBatch:async body=>{const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});assert.equal(response.status,200);return response.json();},
  }) : undefined;
  const cropEvidence = withCrops ? await verifyCrops({bot,command:text=>child.stdin.write(text+'\n'),until,diagnostics:()=>output,tool,serverId,playerKey,cache:acknowledged,
    replayBatch:async body=>{const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});assert.equal(response.status,200);return response.json();},
  }) : undefined;
  const placementEvidence = withPlacement ? await verifyPlacement({bot,command:text=>child.stdin.write(text+'\n'),until,diagnostics:()=>output,tool,serverId,playerKey,cache:acknowledged,
    replayBatch:async body=>{const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});assert.equal(response.status,200);return response.json();},
  }) : undefined;
  const levelEvidence = withLevels ? await verifyLevels({ bot, command: text => child.stdin.write(text + '\n'), until, tool, serverId, playerKey, cache: acknowledged,
    reconnect: async () => {
      closingBot.expected = true; bot.close(); bot = null;
      await until(async () => (await tool('get_player_context', { serverId, playerKey })).sessions[0]?.ended);
      await delay(1200); await connectBot(); return bot;
    },
    replayBatch: async body => {
      const response = await request('/api/ingest/v1/batches', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 200); return response.json();
    },
  }) : undefined;
  const completedUseEvidence = withCompletedUses ? await verifyCompletedUses({bot,command:text=>child.stdin.write(text+'\n'),until,diagnostics:()=>output,tool,serverId,playerKey,cache:acknowledged,
    replayBatch:async body=>{const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});assert.equal(response.status,200);return response.json();},
  }) : undefined;
  const itemEvidence = withItems ? await verifyItems({bot,command:text=>child.stdin.write(text+'\n'),until,tool,serverId,playerKey,cache:acknowledged,diagnostics:()=>output,
    replayBatch:async body=>{const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});assert.equal(response.status,200);return response.json();},
  }) : undefined;
  const actionEvidence = withActions ? await verifyActions({bot,command:text=>child.stdin.write(text+'\n'),until,tool,serverId,playerKey,cache:acknowledged,diagnostics:()=>output,
    reconnect:async whileOffline=>{
      closingBot.expected=true;bot.close();bot=null;
      await until(async()=>(await tool('get_player_context',{serverId,playerKey})).sessions[0]?.ended);
      await whileOffline();await connectBot();return bot;
    },
    replayBatch:async body=>{
      const response=await request('/api/ingest/v1/batches',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body});
      assert.equal(response.status,200);return response.json();
    },
  }):undefined;
  const disconnectKey = withPetRestart ? 'uuid:' + bot.profile.uuid.toLowerCase() : playerKey;
  closingBot.expected = true; bot.close(); bot = null;
  await until(async () => (await tool('get_player_context', { serverId, playerKey:disconnectKey })).sessions[0]?.ended);
  const lifecycleEvidence = await checkLifecycle?.();
  if (withReplies) {
    const offline = await tool('send_chat_reply', { serverId, requestId: randomUUID(), targetPlayerKey: playerKey, text: '离线目标不应伪造送达', ttlSeconds: 60 });
    const failure = await until(async () => { const value = await tool('get_reply_status', { replyId: offline.id }); return value.status === 'FAILED' ? value : null; });
    assert.equal(failure.errorCode, 'PLAYER_OFFLINE');
  }
  if (outageEvidence) {
    await until(async () => {
      const status = await collectorStatus();
      return status.collector?.bootId === outageEvidence.bootId && status.connectionState === 'CONNECTED' && status.collector.pendingEvents === 0;
    });
    outageEvidence.reportedQueueDrained = true;
  }
  child.stdin.write('stop\n'); assert.equal(await Promise.race([exited, delay(45_000, undefined, { ref: false }).then(() => { throw new Error('Game stop timed out'); })]), 0);
  if (withWorldState) {
    const saved = await tool('get_last_player_snapshot', { serverId, playerKey });
    assert.equal(saved.status, 'HISTORY');
    const [offlinePlayer, offlineFurnace] = await Promise.all([
      tool('get_player_state', { serverId, playerKey }),
      tool('inspect_container', { serverId, dimension:'minecraft:overworld', x:2, y:100, z:2 }),
    ]);
    for (const result of [offlinePlayer, offlineFurnace]) {
      assert.equal(result.status, 'EXPIRED');
      assert.equal(result.data, null);
      assert.ok(result.lastKnown && Date.parse(result.lastKnown.observedAt) < Date.parse(result.createdAt));
    }
    worldStateEvidence.serverStoppedQueriesExpireWithHistoricalData = true;
    worldStateEvidence.lastPlayerSnapshotReadableAfterGameStopped = true;
  }
  if (outageEvidence) {
    let batches = 0;
    for (const dir of [spool, acknowledged]) for (const name of readdirSync(dir)) {
      if (!name.endsWith('.pending')) continue;
      const batch = JSON.parse(JSON.parse(readFileSync(path.join(dir, name), 'utf8')).body);
      if (batch.collector.bootId !== outageEvidence.bootId) continue;
      assert.ok(batch.events.length > 0, 'Heartbeat was written to the durable spool');
      batches++;
    }
    assert.ok(batches > 0);
    assert.match(output, /Collector stopped: 0 durable pending events, 0 unpersisted events, 0 rejected submissions/);
    outageEvidence.eventBatchesWithoutHeartbeatFiles = batches;
  }
  if (withBehaviors) assert.match(output, /QA cancellations: mining=[1-9]\d* placement=[1-9]\d* experience=[1-9]\d*/);
  if (withLevels) assert.match(output, /QA cancelled level requests: [1-9]\d*/);
  if (withActions) assert.match(output,/QA actions: jumps=[1-9]\d* cancelledJumps=1 cancelledSneakStarts=1 cancelledSneakStops=1 forcedStops=2/);
  if (withItems) { assert.match(output,/QA items: cancelledPickup=[1-9]\d* cancelledUse=1/); assert.match(output,/QA cancellations: mining=0 placement=[1-9]\d* experience=0/); }
  if (withCompletedUses && !completedUseEvidence?.probeOnly) assert.match(output,/QA items: cancelledPickup=0 cancelledUse=1 cancelledCompletion=1/);
  if (withPlacement && !placementEvidence?.probeOnly) { assert.match(output,/QA cancellations: mining=0 placement=[1-9]\d* experience=0/); assert.match(output,/Placement diagnostics: 0 operations exceeded observation capacity/); assert.match(output,/QA door writes cancelled=1/); }
  if (withCrops && !cropEvidence?.probeOnly) { assert.match(output,/QA cancellations: mining=[1-9]\d* placement=[1-9]\d* experience=0/);assert.match(output,/QA berry interactions cancelled=2/);assert.match(output,/Placement diagnostics: 0 operations exceeded observation capacity/);assert.match(output,/Deferred crop diagnostics: [1-9]\d* confirmed, 1 invalidated, 0 expired, 0 overflow, 0 unresolved/);assert.match(output,/QA pitcher residual replacements=1/); }
  if (withPetRestart) {
    assert.match(output, /Saved pet owner credits: 1/);
    assert.match(output, /Kill diagnostics: 1 admitted, 0 pending, 0 lost, 0 capacity gaps; direct=0 pet=1 burn=0/);
  } else if (withKills && !killEvidence?.probeOnly) {
    const match=output.match(/Kill diagnostics: (\d+) admitted, (\d+) pending, (\d+) lost, (\d+) capacity gaps; direct=(\d+) pet=(\d+) burn=(\d+) duplicates=(\d+) unassigned=(\d+)/);assert.ok(match);
    const [admitted,pending,lost,capacityGaps,direct,pet,burn,duplicates,unassigned]=match.slice(1).map(Number);assert.equal(admitted,withSpecialKills?8:10);assert.equal(pending+lost+capacityGaps,0);assert.equal(direct,7);assert.equal(pet,1);assert.equal(burn,withSpecialKills?0:2);assert.ok(unassigned>=(withSpecialKills?1:6));killEvidence.captureDiagnostics={admitted,pending,lost,capacityGaps,direct,pet,burn,duplicates,unassigned};
    if(withSpecialKills){assert.match(output,/Delayed kill diagnostics: 1 final credits from source snapshots, \d+ invalidated, 1 source mismatches, 0 unresolved; cached pet credits=1/);killEvidence.delayedSourceDiagnosticsVerified=true;}
  }
  if(withBreeding&&!breedingEvidence?.probeOnly){assert.match(output,/Breeding diagnostics: 7 admitted, 0 pending, 0 lost; births=8 duplicates=2 unassigned=1 ambiguous=1 invalidResults=0 capacityGaps=0 cachedFeedCredits=1/);assert.match(output,/QA breeding guards: matingCancelled=[1-9]\d* feedingCancelled=2 duplicatedRefs=2/);}
  if(withCrafting&&!craftingEvidence?.probeOnly){assert.match(output,/Inventory result diagnostics: 17 admitted events, 0 pending events, 0 lost requests; craftingCommitted=8 craftingRolledBack=7 craftingInvalid=0 capacityGaps=0/);assert.match(output,/QA crafting guards: failedCommits=1/);}
  if(withTrades&&!tradeEvidence?.probeOnly){const result=output.match(/Inventory result diagnostics: (\d+) admitted events, 0 pending events, 0 lost requests; craftingCommitted=0 craftingRolledBack=0 craftingInvalid=0 capacityGaps=0/);assert.ok(result);assert.equal(Number(result[1]),tradeEvidence.nativeEventCount);const match=output.match(/Trade diagnostics: committed=(\d+) rolledBack=(\d+) invalid=(\d+) modernPosts=(\d+) legacyPosts=(\d+)/);assert.ok(match);const [committed,rolledBack,invalid,modernPosts,legacyPosts]=match.slice(1).map(Number);assert.equal(committed,tradeEvidence.committedRequests);assert.equal(invalid,0);assert.ok(rolledBack>=9);assert.equal(legacyPosts,tradeEvidence.successes.filter(s=>s.oldScreen).length);assert.equal(modernPosts,tradeEvidence.successes.filter(s=>!s.oldScreen).length+1);tradeEvidence.captureDiagnostics={committed,rolledBack,invalid,modernPosts,legacyPosts};assert.match(output,/QA crafting guards: failedCommits=1/);}
  const nativeCollectorVersion=JSON.parse(original).collector.version;assert.equal(nativeCollectorVersion,JSON.parse(readFileSync(path.join(qa,'plugins/archive-collector/manifest.json'),'utf8')).version);
  const evidence = { verifiedAt: new Date().toISOString(), nativeCollectorVersion, actualGameVersion: '1.26.51.1', leviLaminaVersion: '26.51.8', actualPlayerSpawn: true,
    realGameplay: true, serverId, playerKey, messageId: actual[0].eventId, chatSeenByActualClient: true, mcpReadActualChat: true,
    exactlyOneChatEvent: true, originalNativeBatchReplayDeduplicated: true, mcpReadPlayerContext: true, onlineMillis: statistics.metrics.find(item => item.key === 'online.millis').value,
    disconnectCheckpointReceived: true, cleanGameStop: true, repliesTested: withReplies,
    ...(qqBindingEvidence ? { qqBinding: qqBindingEvidence } : {}),
    ...(worldStateEvidence ? { worldState: worldStateEvidence } : {}),
    ...(outageEvidence ? { telemetryOutage: outageEvidence } : {}),
    ...(lifecycleEvidence ? { sessionLifecycle: lifecycleEvidence } : {}),
    ...(diagnosticsEvidence ? { collectorDiagnostics: diagnosticsEvidence } : {}),
    ...(legacySessionReplay ? { legacySessionEventReplayDeduplicated: true } : {}),
    ...(behaviorEvidence ? { behaviors: behaviorEvidence } : {}),
    ...(dimensionEvidence ? { dimensions: dimensionEvidence } : {}),
    ...(levelEvidence ? { levels: levelEvidence } : {}),
    ...(actionEvidence ? {actions:actionEvidence} : {}),
    ...(itemEvidence ? {items:itemEvidence} : {}),
    ...(completedUseEvidence ? {completedUses:completedUseEvidence} : {}),
    ...(placementEvidence ? {placement:placementEvidence} : {}),
    ...(cropEvidence ? {crops:cropEvidence} : {}),
    ...(killEvidence ? {kills:killEvidence} : {}),
    ...(breedingEvidence ? {breeding:breedingEvidence} : {}),
    ...(craftingEvidence ? {crafting:craftingEvidence} : {}),
    ...(tradeEvidence ? {trades:tradeEvidence} : {}),
    ...(fishingEvidence ? {fishing:fishingEvidence} : {}),
    ...(movementEvidence ? {movement:movementEvidence} : {}),
    ...(withReplies ? { replyId: deliveredReply.id, actualClientReceivedReply: true, nativeDeliveryReceipt: true, stableRequestDeduplicated: true, agentRepliesExcludedFromDefaultInput: true, offlineTargetFailedHonestly: true } : {}),
    ...(replyRetries ? { rejectedClaims, lostCommittedAckResponses: lostAckResponses, receiptAttempts: retriedAckBodies.length, identicalReceiptBytes: true, durableAckStageRecovered: true, retryAndRecoveryDiagnostics: true } : {}),
    ...(crashRecovery ? { hardGameProcessKill: true, durableUnconfirmedReplyRecovered: true, noReplyResendAfterRestart: true, originalSendTimePreserved: true, interruptedSessionClosedAtLastCheckpoint: true } : {}) };
  writeFileSync(path.join(root, withWorldState ? '.tools/native-world-state-evidence.json' : withQqBinding ? '.tools/native-qq-binding-evidence.json' : withPetRestart ? '.tools/native-pet-restart-evidence.json' : collectorDiagnostics ? '.tools/native-collector-diagnostics-evidence.json' : sessionLifecycle ? '.tools/native-session-lifecycle-evidence.json' : telemetryOutage ? '.tools/native-telemetry-outage-evidence.json' : withMovement ? probeMovement ? '.tools/native-movement-probe.json' : thresholdOnly ? '.tools/native-movement-threshold-evidence.json' : '.tools/native-movement-evidence.json' : withFishing ? '.tools/native-fishing-evidence.json' : withTrades ? '.tools/native-trading-evidence.json' : withCrafting ? '.tools/native-crafting-evidence.json' : withBreeding ? '.tools/native-breeding-evidence.json' : withSpecialKills ? '.tools/native-special-kill-evidence.json' : withKills ? '.tools/native-kill-evidence.json' : withCrops ? '.tools/native-crop-evidence.json' : withPlacement ? '.tools/native-placement-evidence.json' : withCompletedUses ? '.tools/native-completed-use-evidence.json' : withItems ? '.tools/native-item-evidence.json' : withActions ? '.tools/native-action-evidence.json' : withLevels ? '.tools/native-level-evidence.json' : withDimensions ? '.tools/native-dimension-evidence.json' : withBehaviors ? process.argv.includes('--death-by-zombie') ? '.tools/native-basic-behavior-entity-evidence.json' : '.tools/native-basic-behavior-evidence.json' : crashRecovery ? '.tools/native-reply-recovery-evidence.json' : replyRetries ? '.tools/native-reply-retry-evidence.json' : withReplies ? '.tools/native-live-reply-evidence.json' : '.tools/native-live-chat-evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} finally {
  bot?.close();
  if (withMovement && child && code === undefined) {try{child.stdin.write('execute in nether run tickingarea remove ArchiveMotionNether\n');}catch{}}
  if(withBreeding&&child&&code===undefined){try{child.stdin.write('tickingarea remove ArchiveBreedingQA\n');}catch{}}
  if (withSpecialKills && child && code === undefined) {try{child.stdin.write('tickingarea remove ArchiveSpecialQA\ngamerule mobgriefing true\n');}catch{}}
  if (withKills && child && code === undefined) {try{child.stdin.write('tickingarea remove ArchiveKillQA\n');}catch{}}
  if (withCrops && child && code === undefined) { try { child.stdin.write('gamerule randomtickspeed 3\n'); } catch {} }
  if (withActions && child && code === undefined) { try {child.stdin.write('tickingarea remove ArchiveActionQA\nexecute in nether run tickingarea remove ArchiveActionNetherQA\n');}catch{} }
  if (child && code === undefined) { try { child.stdin.write('stop\n'); } catch {} await Promise.race([exited, delay(5000, undefined, { ref: false })]); if (code === undefined) child.kill(); }
  if (child && code === undefined) await exited;
  if (configChanged && originalConfig) writeFileSync(configFile, originalConfig);
  await mcp?.close();
  if (agentId) await admin(`/api/agents/${agentId}`, undefined, 'DELETE').catch(() => {});
  if (serverId) await admin(`/api/servers/${serverId}/collector-credential`, undefined, 'DELETE').catch(() => {});
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
}
