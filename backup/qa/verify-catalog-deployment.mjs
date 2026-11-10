import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, readFileSync, appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectBackup, restoreBackup } from '../src/archive.mjs';
import { canonicalJson, contains, digest } from '../src/paths.mjs';
import { assertServerStopped } from '../src/processes.mjs';
import { localGameClient } from '../../collector/qa/http-client.mjs';
import { inputDriver } from '../../collector/qa/input-driver.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url)), stateFile = path.join(project, '.tools/backup-catalog-deployment-state.json');
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'; assert.equal(new URL(base).hostname, '127.0.0.1');
const environment = Object.fromEntries(readFileSync(path.join(project, '.env'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('MCM_') && line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
let csrf, game, client, expectedClose = false, failure;
const cookies = new Map();
async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, { ...options, redirect: 'error', headers: { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...options.headers }, signal: AbortSignal.timeout(900000) });
  for (const cookie of response.headers.getSetCookie()) { const at = cookie.indexOf('='); cookies.set(cookie.slice(0, at), cookie.slice(at + 1).split(';')[0]); }
  return response;
}
async function admin(endpoint, body, method = 'POST') {
  const response = await request(endpoint, { method, headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `Catalog request failed: HTTP ${response.status}`); return response.status === 204 ? null : response.json();
}
async function until(action, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (failure) throw failure; if (game?.exited) throw new Error('Owned restored game exited'); const result = await action(); if (result) return result; await delay(100); }
  throw new Error('Central archive restoration timed out; inspect owned game.log');
}
async function download(id, destination, expectedSha) {
  const response = await request(`/api/backups/${id}/content`); assert.equal(response.status, 200); assert.equal(response.headers.get('x-archive-sha256'), expectedSha);
  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, done) { hash.update(chunk); done(null, chunk); } }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  assert.equal(hash.digest('hex'), expectedSha);
}
async function browserDownload(id, serverId, destination, expectedSha, screenshot) {
  const { chromium } = await import('../../frontend/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    await page.goto(base); await page.getByLabel('密码', { exact: true }).fill(environment.MCM_ADMIN_PASSWORD);
    await page.getByRole('button', { name: '进入工作台' }).click();
    await page.getByRole('heading', { name: '数据总览', exact: true }).waitFor();
    await page.getByLabel('统计范围').selectOption(serverId);
    await page.locator('.sidebar').getByRole('button', { name: '备份中心', exact: true }).click();
    const card = page.locator(`[data-backup="${id}"]`); await card.waitFor();
    assert.ok((await card.innerText()).includes('文件已校验'));
    const pending = page.waitForEvent('download'); await card.getByRole('link', { name: '下载完整备份' }).click();
    await (await pending).saveAs(destination); assert.equal(await digest(destination), expectedSha);
    await card.getByText('查看完整性与统计衔接说明').click();
    await page.locator(':focus').evaluateAll(elements => elements.forEach(element => element.blur()));
    await page.screenshot({ path: screenshot, fullPage: true });
  } finally { await browser.close(); }
}
try {
  csrf = await (await request('/api/auth/csrf')).json();
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { [csrf.headerName]: csrf.token }, body: new URLSearchParams({ username: environment.MCM_ADMIN_USERNAME ?? 'admin', password: environment.MCM_ADMIN_PASSWORD }) })).status, 204);
  csrf = await (await request('/api/auth/csrf')).json();
  const evidence = JSON.parse(await readFile(path.join(project, '.tools/backup-restoration-evidence.json'), 'utf8'));
  if (process.argv.includes('--check-persistence')) {
    const saved = JSON.parse(await readFile(stateFile, 'utf8')), record = await (await request(`/api/backups/${saved.id}`)).json();
    assert.equal(record.status, 'READY'); assert.equal(record.sha256, saved.sha256); assert.equal(record.permanent, true);
    const file = path.join(saved.directory, 'downloaded-after-container-recreation-' + randomUUID() + '.tar.gz');
    assert.ok(contains(path.join(project, '.tools'), file)); await download(saved.id, file, saved.sha256);
    const proof = await inspectBackup(file); assert.equal(proof.manifest.backupId, evidence.backupId);
    const result = { ...saved.evidence, containerRecreationPreservedMetadataAndArchive: true, persistenceVerifiedAt: new Date().toISOString() };
    await writeFile(path.join(project, '.tools/backup-catalog-deployment-evidence.json'), canonicalJson(result)); console.log(JSON.stringify(result, null, 2));
  } else {
    let archive;
    for (const name of await readdir(path.join(project, '.tools'))) {
      if (!/^backup-qa-[0-9a-f-]{36}$/.test(name)) continue;
      const directory = path.join(project, '.tools', name);
      if ((await readFile(path.join(directory, '.qa-owner'), 'utf8')) !== name.slice('backup-qa-'.length)) continue;
      const file = path.join(directory, 'full-server.tar.gz'), proof = await inspectBackup(file);
      if (proof.manifest.backupId === evidence.backupId) { archive = file; break; }
    }
    assert.ok(archive, 'The actual game-verified archive must be present');
    const originalLog = await readFile(path.join(project, '.tools/backup-game-restore-verification.log'), 'utf8');
    assert.ok(originalLog.includes(`"backupId": "${evidence.backupId}"`));
    const identity = originalLog.split(/\r?\n/).filter(line => line.startsWith('{"stage":"original-inventory-seeded"')).map(line => JSON.parse(line))[0]; assert.ok(identity);
    const serverId = JSON.parse(await readFile(path.join(project, '.tools/game-qa-26.51.8/live-chat-fixture.json'))).serverId;
    const before = await (await request(`/api/statistics/summary?serverId=${serverId}`)).json();
    const directory = path.join(project, '.tools', 'backup-catalog-qa-' + randomUUID()); await mkdir(directory); await writeFile(path.join(directory, '.qa-owner'), 'MCManager-archive-backup-catalog-qa');
    const catalog = await (await request(`/api/backups?serverId=${serverId}&size=100`)).json();
    const reservation = catalog.items.find(item => item.sourceBackupId === evidence.backupId && item.status === 'READY')
      ?? await admin(`/api/servers/${serverId}/backups`, { requestId: randomUUID(), kind: 'MANUAL', note: '实服归档上传、下载和恢复验收', permanent: true, expectedBytes: evidence.archiveBytes });
    let record = reservation;
    if (record.status !== 'READY') {
      const response = await request(`/api/backups/${reservation.id}/content`, { method: 'PUT', duplex: 'half', headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/octet-stream', 'Content-Length': evidence.archiveBytes }, body: createReadStream(archive) });
      assert.equal(response.status, 200, 'Actual 230 MB archive upload must pass Nginx and the container verifier');
      record = await response.json();
    }
    assert.equal(record.status, 'READY'); assert.equal(record.sha256, evidence.archiveSha256); assert.equal(record.worldRuntimeVerified, false);
    let downloaded = path.join(directory, 'downloaded.tar.gz'); await download(record.id, downloaded, evidence.archiveSha256);
    if (process.argv.includes('--browser-download')) {
      downloaded = path.join(directory, 'downloaded-through-browser.tar.gz');
      await browserDownload(record.id, serverId, downloaded, evidence.archiveSha256, path.join(directory, 'production-backups.png'));
    }
    const proof = await inspectBackup(downloaded); assert.equal(proof.manifest.backupId, evidence.backupId);
    const destination = path.join(directory, 'restored-from-central'); await restoreBackup({ file: downloaded, destination });
    await assertServerStopped(path.join(project, '.tools/game-qa-26.51.8')); await assertServerStopped(destination);
    assert.equal(JSON.parse(await readFile(path.join(destination, 'plugins/archive-collector/config/config.json'))).enabled, false);
    const child = spawn(path.join(destination, 'bedrock_server_mod.exe'), [], { cwd: destination, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    game = { child, output: '', exited: false }; game.exit = new Promise((resolve, reject) => { child.once('exit', code => { game.exited = true; resolve(code); }); child.once('error', reject); });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { game.output += chunk; appendFileSync(path.join(directory, 'game.log'), chunk); });
    await until(() => /Server started/.test(game.output), 60000);
    await until(() => /2 mod\(s\) enabled/.test(game.output), 30000);
    client = await localGameClient('http://127.0.0.1:19152', 'ArchiveQA', error => { if (!expectedClose) failure = error; }, identity.offlineIdentity);
    let held, spawned = false; const texts = [];
    client.on('inventory_content', packet => { if (['inventory', 0].includes(packet.window_id)) held = packet.input[0]; });
    client.on('inventory_slot', packet => { if (['inventory', 0].includes(packet.window_id) && packet.slot === 0) held = packet.item; });
    client.on('spawn', () => { spawned = true; }); client.on('text', packet => texts.push(packet));
    await until(() => spawned); inputDriver(client);
    await until(() => held?.count === identity.item.count && held.network_id === identity.item.networkId);
    const marker = 'CENTRAL_RESTORE_PROOF_' + randomUUID(); child.stdin.write(`execute if block 2 105 2 emerald_block run say ${marker}\n`);
    await until(() => texts.some(packet => packet.message.includes(marker)));
    expectedClose = true; client.close(); client = null; child.stdin.write('stop\n');
    assert.equal(await Promise.race([game.exit, delay(45000, undefined, { ref: false }).then(() => { throw new Error('Owned game stop timed out'); })]), 0); game = null;
    const after = await (await request(`/api/statistics/summary?serverId=${serverId}`)).json(); assert.deepEqual(after.metrics, before.metrics);
    const result = { verifiedAt: new Date().toISOString(), id: record.id, backupId: evidence.backupId, sha256: record.sha256, archiveBytes: record.archiveBytes,
      fileCount: record.fileCount, actualGameVersion: '1.26.51.1', leviLaminaVersion: '26.51.8', actualArchiveUploadedThroughNginx: true,
      containerVerifierCheckedAllFiles: true, uploadReusedReadyRecord: reservation.status === 'READY', actualArchiveDownloadedThroughBrowser: process.argv.includes('--browser-download'),
      downloadedBytesMatchOriginal: true, downloadedArchiveBootedActualGame: true,
      originalWorldMarkerRestored: true, originalPlayerInventoryRestored: true, collectorDisabledByDefault: true,
      centralStatisticsUnchangedByDisabledRestore: true, cleanGameStop: true, containerRecreationPreservedMetadataAndArchive: false };
    await writeFile(stateFile, canonicalJson({ id: record.id, directory, sha256: record.sha256, evidence: result }));
    await writeFile(path.join(project, '.tools/backup-catalog-deployment-evidence.json'), canonicalJson(result)); console.log(JSON.stringify(result, null, 2));
  }
} finally {
  expectedClose = true; client?.close();
  if (game && !game.exited) { game.child.stdin.write('stop\n'); await Promise.race([game.exit, delay(5000, undefined, { ref: false })]); if (!game.exited) game.child.kill(); }
}
