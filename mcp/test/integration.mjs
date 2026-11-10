// Real stdio MCP client -> real Java HTTP backend -> actual file H2.
// Collector execution receipts below are protocol fixtures, not real game delivery.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const deployment = process.argv.includes('--deployment');
const deploymentEnv = deployment ? Object.fromEntries(readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('MCM_') && line.includes('=')).map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; })) : {};
const evidenceDir = path.join(root, '.tools', `mcp-integration-${randomUUID()}`); mkdirSync(evidenceDir, { recursive: true });
const jar = process.env.MCM_QA_BACKEND_JAR ?? path.join(root, 'backend/target/mcmanager-archive-0.1.0.jar');
assert.ok(deployment || existsSync(jar), 'Build the backend with mvnw verify first');
const fallbackJava = 'C:/Program Files/Java/jdk-21/bin/java.exe';
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : existsSync(fallbackJava) ? fallbackJava : 'java';
const password = deployment ? deploymentEnv.MCM_ADMIN_PASSWORD : randomBytes(24).toString('base64url');
let backend; let base; let log = ''; let client; let transport; let stderr = '';
let cookies = new Map(); let csrf;
let cleanupAgent, cleanupServer;
const evidence = { verifiedAt: new Date().toISOString(), realMcpStdio: true, realBackendHttp: true, database: deployment ? 'deployed backend' : 'file H2', backendRestartTested: !deployment, realGameplay: false, checks: [] };
async function startBackend() {
  log = ''; cookies = new Map();
  if (deployment) {
    base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088';
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Deployment verifier requires an explicitly local QA endpoint');
    assert.ok((await fetch(base + '/api/health')).ok); return;
  }
  backend = spawn(java, ['-jar', jar], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, MCM_PORT: '0', MCM_BIND_ADDRESS: '127.0.0.1', MCM_ADMIN_USERNAME: 'admin', MCM_ADMIN_PASSWORD: password,
    MCM_DB_URL: `jdbc:h2:file:${path.join(evidenceDir, 'state').replaceAll('\\', '/')};MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;WRITE_DELAY=0`,
    MCM_DB_USER: 'sa', MCM_DB_PASSWORD: '', MCM_COOKIE_SECURE: 'false', MCM_STATISTICS_ZONE: 'Asia/Hong_Kong',
    MCM_TERRAIN_ENGINE: path.join(root, 'terrain/bin', process.platform === 'win32' ? 'mcarchive-terrain.exe' : 'mcarchive-terrain'),
  } });
  backend.stdout.on('data', chunk => { log += chunk; }); backend.stderr.on('data', chunk => { log += chunk; });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (backend.exitCode !== null) throw new Error('QA backend exited before startup');
    const match = log.match(/Tomcat started on port (\d+)/);
    if (match) { base = `http://127.0.0.1:${match[1]}`; if ((await fetch(base + '/api/health')).ok) return; }
    await delay(100);
  }
  throw new Error('QA backend startup timeout');
}
async function stopBackend() {
  if (!backend || backend.exitCode !== null) return;
  const closed = once(backend, 'exit'); backend.kill(); await closed;
  writeFileSync(path.join(evidenceDir, 'backend.log'), log);
}
async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, { ...options, headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers }, signal: AbortSignal.timeout(35_000) });
  for (const cookie of response.headers.getSetCookie()) { const index = cookie.indexOf('='); cookies.set(cookie.slice(0, index), cookie.slice(index + 1).split(';')[0]); }
  return response;
}
async function login() {
  csrf = await (await request('/api/auth/csrf')).json();
  const response = await request('/api/auth/login', { method: 'POST', headers: { [csrf.headerName]: csrf.token }, body: new URLSearchParams({ username: deploymentEnv.MCM_ADMIN_USERNAME ?? 'admin', password }) });
  assert.equal(response.status, 204); csrf = await (await request('/api/auth/csrf')).json();
}
async function admin(endpoint, body, method = 'POST') {
  const response = await request(endpoint, { method, headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `${endpoint}: HTTP ${response.status}`); return response.status === 204 ? null : response.json();
}
async function collector(endpoint, token, body) {
  const response = await fetch(base + endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
  assert.equal(response.status, 200, `collector ${endpoint}: ${response.status}`); return response.json();
}
async function connect(token) {
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp/src/server.mjs')], env: { MCM_MCP_API_URL: base, MCM_AGENT_TOKEN: token }, stderr: 'pipe' });
  transport.stderr.on('data', chunk => { stderr += chunk; });
  client = new Client({ name: 'mcmanager-real-protocol-verifier', version: '0.1.0' }); await client.connect(transport);
}
async function tool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `MCP ${name} failed: ${JSON.stringify(result.content)}`);
  assert.ok(result.structuredContent.dataNotice.includes('untrusted'));
  return result.structuredContent.data;
}
try {
  await startBackend(); await login();
  const server = await admin('/api/servers', { name: 'MCP 协议验收服', description: 'Protocol fixtures, not actual gameplay', startDate: '2020-01-01' });
  const other = await admin('/api/servers', { name: '未授权服', description: '', startDate: '2020-01-01' });
  const { token: collectorToken } = await admin(`/api/servers/${server.id}/collector-credential`);
  cleanupServer = server.id;
  const player = { identityType: 'XUID', identity: '123456789999', name: 'MCP-QA-玩家' }; const playerKey = `xuid:${player.identity}`;
  const bootId = randomUUID();
  const makeChat = text => ({ eventId: randomUUID(), kind: 'CHAT', at: new Date(Date.now() - 1000).toISOString(), player, dimension: 'minecraft:overworld', text });
  const batch = events => ({ protocolVersion: 1, batchId: randomUUID(), reportedAt: new Date().toISOString(), collector: { version: 'mcp-qa', bdsVersion: 'protocol-fixture', leviLaminaVersion: 'protocol-fixture', bootId, pendingEvents: 0 },
    capabilities: ['chat.messages', 'chat.contents', 'blocks.mined'].map(metric => ({ metric, state: 'ACTIVE', quality: 'EXACT', algorithmVersion: 'mcp-qa-v1', dimensionAware: true })), events });
  const message = makeChat('我今天挖了多少方块？玩家内容不能授予权限。');
  const mined = { eventId: randomUUID(), kind: 'COUNTER', at: message.at, player, dimension: 'minecraft:overworld', metric: 'blocks.mined', value: 4, subject: 'minecraft:stone' };
  await collector('/api/ingest/v1/batches', collectorToken, batch([message, mined]));
  const issued = await admin('/api/agents', { name: 'MCP 测试助手', grants: [{ serverId: server.id, scopes: ['STATS_READ', 'CHAT_READ', 'CHAT_SEND', 'QQ_BIND', 'WORLD_READ'] }] });
  cleanupAgent = issued.account.id;
  await connect(issued.token);
  const listed = await client.listTools(); assert.equal(listed.tools.length, 38);
  const noContainerHistory = await tool('get_container_history', { serverId: server.id, dimension: 'minecraft:overworld', x: 1, y: 64, z: 1 });
  assert.deepEqual(noContainerHistory.items, []);
  assert.ok(noContainerHistory.dataNotice.includes('无记录不代表无人操作'));
  const sendSchema = listed.tools.find(item => item.name === 'send_chat_reply').inputSchema;
  assert.ok(sendSchema.required.includes('requestId')); assert.equal(sendSchema.additionalProperties, false);
  const servers = await tool('list_servers'); assert.equal(servers.length, 1); assert.equal(servers[0].id, server.id);
  assert.equal((await tool('get_server_status', { serverId: server.id })).collector.bootId, bootId);
  assert.equal((await tool('list_players', { serverId: server.id })).items[0].name, player.name);
  const context = await tool('get_player_context', { serverId: server.id, playerKey });
  assert.equal(context.statistics.metrics.find(row => row.key === 'blocks.mined').value, '4');
  const stats = await tool('get_player_statistics', { serverId: server.id, playerKey }); assert.equal(stats.metrics.find(row => row.key === 'blocks.mined').value, '4');
  const daily = await tool('get_player_statistics', { serverId: server.id, playerKey, daily: true }); assert.ok(daily.some(row => row.metric === 'blocks.mined' && row.value === '4'));
  for (const name of ['get_statistics_breakdown','get_statistics_ranking']) {
    const details=await tool(name,{serverId:server.id,playerKey,metric:'blocks.mined',pageSize:1});
    assert.equal(details.total,1);assert.equal(details.items[0].subject,'minecraft:stone');assert.equal(details.items[0].value,'4');
    const denied=await client.callTool({name,arguments:{serverId:other.id,metric:'blocks.mined'}});
    assert.equal(denied.structuredContent.error,'PERMISSION_DENIED');
  }
  const behavior = await tool('get_recent_activity', { serverId: server.id }); assert.equal(behavior.items.length, 1); assert.equal(behavior.items[0].text, null);
  const chats = await tool('get_chat_messages', { serverId: server.id }); assert.equal(chats.items[0].text, message.text);
  const forbidden = await client.callTool({ name: 'get_server_status', arguments: { serverId: other.id } }); assert.equal(forbidden.isError, true); assert.equal(forbidden.structuredContent.error, 'PERMISSION_DENIED');
  evidence.checks.push('38 standard MCP tools negotiated over stdio', 'real server/player/statistics/chat/detail/ranking reads', 'cross-server permission rejection');
  const qqId = '12345678';
  const codeRequest = { requestId: randomUUID(), playerKey, code: 'A1B2C3D4' };
  await collector('/api/ingest/v1/qq-binding-codes', collectorToken, codeRequest);
  assert.equal((await tool('get_qq_binding', { serverId: server.id, qqId })).bound, false);
  const qqBinding = await tool('bind_qq_account', { serverId: server.id, qqId, code: codeRequest.code.toLowerCase() });
  assert.equal(qqBinding.binding.playerKey, playerKey);
  assert.equal((await tool('bind_qq_account', { serverId: server.id, qqId, code: codeRequest.code })).binding.id, qqBinding.binding.id);
  const qqContext = await tool('get_qq_player_context', { serverId: server.id, qqId });
  assert.equal(qqContext.player.key, playerKey);
  assert.equal(qqContext.statistics.metrics.find(row => row.key === 'blocks.mined').value, '4');
  const usedCode = await client.callTool({ name: 'bind_qq_account', arguments: { serverId: server.id, qqId: '87654321', code: codeRequest.code } });
  assert.equal(usedCode.isError, true);
  evidence.checks.push('QQ code binding, original retry, bound context and consumed-code rejection');
  async function observe(name, args, data) {
    let failed;
    const requestId = args.requestId ?? randomUUID();
    const pending = tool(name, { serverId: server.id, ...args, requestId });
    pending.catch(error => { failed = error; });
    let lease;
    const deadline = Date.now() + 10000;
    while (!lease && Date.now() < deadline) {
      if (failed) throw failed;
      [lease] = await collector('/api/ingest/v1/world-queries/claim', collectorToken, { bootId });
      if (!lease) await delay(50);
    }
    assert.ok(lease, 'The standard MCP call must create a world query');
    await collector('/api/ingest/v1/world-queries/' + lease.id + '/complete', collectorToken, {
      leaseId: lease.leaseId, bootId, observedAt: new Date().toISOString(), status: 'READY', data,
    });
    const result = await pending;
    assert.equal(result.status, 'READY');
    assert.deepEqual(result.data, data);
    return result;
  }
  const worldRequestId = randomUUID();
  const world = await observe('get_world_state', { requestId: worldRequestId }, { gameTimeTicks: 1000, observedOnlineCount: 1 });
  const repeatedWorld = await tool('get_world_state', { serverId: server.id, requestId: worldRequestId });
  assert.equal(repeatedWorld.id, world.id);
  assert.deepEqual(repeatedWorld.data, world.data);
  assert.equal(repeatedWorld.observedAt, world.observedAt);
  const changedWorld = await client.callTool({ name: 'get_player_state', arguments: { serverId: server.id, playerKey, requestId: worldRequestId } });
  assert.equal(changedWorld.isError, true); assert.equal(changedWorld.structuredContent.error, 'CONFLICT');
  assert.deepEqual(await collector('/api/ingest/v1/world-queries/claim', collectorToken, { bootId }), []);
  evidence.checks.push('stable world-query requestId returns the original observation without a second collector task; changed target rejects reuse');
  assert.equal((await tool('get_world_query_result', { queryId: world.id })).status, 'READY');
  const playerData = { playerKey, health: 20, position: { x: 1, y: 64, z: 2 } };
  await observe('get_player_state', { playerKey }, playerData);
  await observe('get_qq_player_state', { qqId }, playerData);
  assert.deepEqual((await tool('get_last_player_snapshot', { serverId: server.id, playerKey })).snapshot.data, playerData);
  const coordinates = { dimension: 'minecraft:overworld', x: 1, y: 64, z: 2 };
  await observe('inspect_block', coordinates, { ...coordinates, block: 'minecraft:furnace' });
  await observe('inspect_container', coordinates, { ...coordinates, container: { slots: [] }, furnace: { burnTicksRemaining: 0 } });
  await observe('scan_nearby', { ...coordinates, radius: 1 }, { dimension: coordinates.dimension, center: { x: 1, y: 64, z: 2 }, blocks: [], entities: [] });
  const recorded = await tool('get_recorded_environment', { serverId: server.id, ...coordinates, radius: 4 });
  assert.equal(recorded.status, 'HISTORY'); assert.equal(recorded.records.length, 3); assert.equal(recorded.completeWorldCoverage, false);
  assert.equal((await tool('get_terrain_prediction', { serverId: server.id, dimension: coordinates.dimension, x: 0, z: 0, worldType: 'DEFAULT' })).status, 'NOT_CONFIGURED');
  const terrain = await tool('get_terrain_prediction', { serverId: server.id, dimension: coordinates.dimension, x: -1, z: -17, radius: 16, worldType: 'DEFAULT', seed: '-9007199254740993', generationVersion: '1.26.61.1' });
  assert.equal(terrain.status, 'PREDICTED'); assert.equal(terrain.source, 'SEED_PREDICTION'); assert.equal(terrain.samples.length, 9);
  assert.equal(terrain.chunk.x, -1); assert.equal(terrain.chunk.z, -2); assert.equal(terrain.seed, undefined);
  assert.equal(terrain.seedSource,'REQUEST');assert.equal(terrain.worldIdentityVerified,false);
  const location=await tool('get_location_context',{serverId:server.id,...coordinates,worldType:'DEFAULT',seed:'-9007199254740993',generationVersion:'1.26.61.1',radius:16,historyRadius:4});
  assert.equal(location.status,'COMBINED');assert.equal(location.prediction.status,'PREDICTED');assert.equal(location.prediction.samples.length,9);
  assert.deepEqual(location.history,recorded);assert.equal(location.completeWorldCoverage,false);assert.equal(location.prediction.seed,undefined);
  assert.equal(location.structures.status,'PREDICTED');assert.ok(location.structures.candidates.length>0);assert.equal(location.chunks.status,'CALCULATED');assert.equal(location.chunks.chunks.length,25);
  const structures=await tool('get_structure_predictions',{serverId:server.id,dimension:coordinates.dimension,x:0,z:0,worldType:'DEFAULT',seed:'1',generationVersion:'1.26.61.1',structure:'village',radius:2048,limit:1});
  assert.equal(structures.candidates[0].x,152);assert.equal(structures.candidates[0].z,808);assert.equal(structures.candidates[0].observed,false);
  const chunks=await tool('get_chunk_info',{serverId:server.id,dimension:coordinates.dimension,x:-1,z:-17,radius:0});
  assert.deepEqual(chunks.centerChunk,{x:-1,z:-2});assert.equal(chunks.chunks[0].minX,-16);assert.equal(chunks.chunks[0].minZ,-32);
  evidence.checks.push('real structure and slime-chunk algorithms through standalone MCP and combined four-source context; no game task');
  const flatLocation=await tool('get_location_context',{serverId:server.id,...coordinates,worldType:'FLAT',historyRadius:4});
  assert.equal(flatLocation.status,'PARTIAL');assert.equal(flatLocation.prediction.status,'UNSUPPORTED_WORLD_TYPE');assert.deepEqual(flatLocation.history,recorded);
  evidence.checks.push('combined location tool retains natural predictions and historical observations separately; flat world still returns history; both original tools preserved');
  assert.equal((await admin(`/api/servers/${server.id}/terrain-profile`,undefined,'GET')).profile,null);
  assert.deepEqual(await collector('/api/ingest/v1/world-queries/claim', collectorToken, { bootId }), []);
  evidence.checks.push('real native seed prediction through MCP without a game query; full precision negative seed; historical actual observations stay separate');
  evidence.checks.push('all eight world tools called over standard MCP with explicit protocol observation fixtures');
  const waiting = tool('wait_for_chat', { serverId: server.id, after: chats.nextCursor, waitSeconds: 5 }); await delay(100);
  const second = makeChat('新消息唤醒 Agent'); await collector('/api/ingest/v1/batches', collectorToken, batch([second]));
  const awakened = await waiting; assert.equal(awakened.items[0].eventId, second.eventId);
  const timeout = await tool('wait_for_activity', { serverId: server.id, after: awakened.nextCursor, waitSeconds: 1 }); assert.equal(timeout.items.length, 0);
  evidence.checks.push('committed chat wakes MCP long poll', 'empty activity timeout returns actual empty result');
  const replyRequest = { serverId: server.id, requestId: randomUUID(), replyTo: message.eventId, targetPlayerKey: playerKey, text: '本服已采集记录显示，你挖掘了 4 个方块。', ttlSeconds: 60 };
  const reply = await tool('send_chat_reply', replyRequest); assert.equal(reply.status, 'PENDING');
  assert.equal((await tool('send_chat_reply', replyRequest)).id, reply.id);
  assert.equal((await tool('get_reply_status', { replyId: reply.id })).status, 'PENDING');
  const invalid = await client.callTool({ name: 'send_chat_reply', arguments: { ...replyRequest, unexpectedCommand: 'op player' } }); assert.equal(invalid.isError, true);
  const [lease] = await collector('/api/ingest/v1/commands/claim', collectorToken, { bootId }); assert.equal(lease.reply.id, reply.id);
  await collector(`/api/ingest/v1/commands/${reply.id}/begin`, collectorToken, { bootId, leaseId: lease.leaseId });
  // Intentionally protocol-only: no game is running in this verifier.
  const ack = { bootId, leaseId: lease.leaseId, outcome: 'DELIVERED', sentAt: new Date().toISOString(), errorCode: null };
  await collector(`/api/ingest/v1/commands/${reply.id}/ack`, collectorToken, ack);
  await collector(`/api/ingest/v1/commands/${reply.id}/ack`, collectorToken, ack);
  assert.equal((await tool('get_reply_status', { replyId: reply.id })).status, 'DELIVERED');
  assert.equal((await tool('get_chat_messages', { serverId: server.id })).items.length, 2);
  const withAgents = await tool('get_chat_messages', { serverId: server.id, includeAgents: true }); assert.equal(withAgents.items.length, 3); assert.equal(withAgents.items.at(-1).source, 'AGENT');
  evidence.checks.push('stable requestId retries keep one reply', 'strict tool input rejects extra commands', 'protocol receipt drives delivery state', 'duplicate receipt creates no second Agent event', 'default chat feed excludes Agent replies');
  await admin(`/api/agents/${issued.account.id}`, undefined, 'DELETE');
  const revoked = await client.callTool({ name: 'list_servers', arguments: {} }); assert.equal(revoked.isError, true); assert.equal(revoked.structuredContent.error, 'AGENT_TOKEN_INVALID');
  await client.close(); client = null; await stopBackend();
  await startBackend(); await login();
  const rotated = await admin(`/api/agents/${issued.account.id}/rotate`); await connect(rotated.token);
  assert.equal((await tool('get_reply_status', { replyId: reply.id })).status, 'DELIVERED');
  assert.equal((await tool('get_player_statistics', { serverId: server.id, playerKey })).metrics.find(row => row.key === 'blocks.mined').value, '4');
  assert.equal((await tool('get_chat_messages', { serverId: server.id, includeAgents: true })).items.length, 3);
  assert.equal((await tool('get_qq_binding', { serverId: server.id, qqId })).binding.id, qqBinding.binding.id);
  assert.deepEqual((await tool('get_last_player_snapshot', { serverId: server.id, playerKey })).snapshot.data, playerData);
  assert.equal((await tool('unbind_qq_account', { serverId: server.id, qqId, bindingId: qqBinding.binding.id })).bound, false);
  const removedCode = await client.callTool({ name: 'bind_qq_account', arguments: { serverId: server.id, qqId, code: codeRequest.code } });
  assert.equal(removedCode.isError, true);
  evidence.checks.push(deployment ? 'binding persists across Agent token rotation; explicit unbind invalidates old code' : 'binding persists across backend restart and Agent token rotation; explicit unbind invalidates old code');
  assert.equal(stderr, '');
  evidence.checks.push('revoked token rejected by MCP tool', deployment ? 'deployed backend preserves reply/chat/statistics across credential rotation' : 'backend process restart preserves reply/chat/statistics', 'stdio contains only valid MCP and no startup diagnostics');
  await admin(`/api/agents/${issued.account.id}`, undefined, 'DELETE'); cleanupAgent = undefined;
  await admin(`/api/servers/${server.id}/collector-credential`, undefined, 'DELETE'); cleanupServer = undefined;
  evidence.checks.push('test Agent and collector credentials revoked after verification');
  evidence.serverId = server.id; evidence.replyId = reply.id; evidence.passed = true;
  writeFileSync(path.join(root, deployment ? '.tools/mcp-deployment-evidence.json' : '.tools/mcp-integration-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (deployment) {
    if (cleanupAgent) await admin(`/api/agents/${cleanupAgent}`, undefined, 'DELETE').catch(() => {});
    if (cleanupServer) await admin(`/api/servers/${cleanupServer}/collector-credential`, undefined, 'DELETE').catch(() => {});
  }
  await client?.close(); await transport?.close(); await stopBackend();
  writeFileSync(path.join(evidenceDir, 'backend.log'), log);
}
