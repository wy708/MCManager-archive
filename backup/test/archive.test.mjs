import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Header } from 'tar';
import { createStoppedBackup, inspectBackup, restoreBackup } from '../src/archive.mjs';
import { canonicalJson, missing } from '../src/paths.mjs';

const serverId = '11111111-1111-4111-8111-111111111111';
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function sandbox(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcmanager-backup-test-')), owner = randomUUID(); await writeFile(path.join(root, '.test-owner'), owner);
  try { await action(root); }
  finally {
    const real = await realpath(root), parent = await realpath(os.tmpdir());
    assert.equal(path.dirname(real), parent); assert.ok(path.basename(real).startsWith('mcmanager-backup-test-')); assert.equal(await readFile(path.join(real, '.test-owner'), 'utf8'), owner);
    await rm(real, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
async function fixture(parent) {
  const root = path.join(parent, 'server'); await mkdir(root);
  const files = {
    'bedrock_server_mod.exe': 'contract fixture, not a game executable', 'server.properties': 'level-name=中文世界\n',
    'worlds/中文世界/level.dat': 'world-fixture', 'worlds/中文世界/db/CURRENT': 'MANIFEST-000001\n', 'worlds/中文世界/db/000003.log': 'essential WAL', 'worlds/中文世界/db/LOCK': '',
    'plugins/LeviLamina/manifest.json': canonicalJson({ name: 'LeviLamina', version: '26.51.8' }),
    'plugins/archive-collector/manifest.json': canonicalJson({ name: 'archive-collector', version: '0.6.0' }),
    'plugins/archive-collector/config/config.json': canonicalJson({ enabled: true, serverId, token: serverId + '.' + 'A'.repeat(43), endpoint: 'http://127.0.0.1:8080/api/ingest/v1/batches' }),
    'plugins/archive-collector/data/outbox/server-id': serverId,
    'plugins/archive-collector/data/outbox/collector.lock': '', 'logs/crash.dmp': 'not required to play the world',
    'behavior_packs/本服/manifest.json': canonicalJson({ header: { version: [1, 2, 3] } }),
    'permissions.json': '[]', 'allowlist.json': '[]', 'resource_packs/sample/data.bin': Buffer.from([0, 255, 17, 0, 19]),
  };
  for (const folder of ['acknowledged', '']) {
    const body = canonicalJson({ batchId: randomUUID(), events: [{ eventId: randomUUID(), at: '2026-10-26T12:00:00.000Z' }] });
    files['plugins/archive-collector/data/outbox/' + (folder ? folder + '/' : '') + randomUUID() + '.pending'] = canonicalJson({ schema: 1, sha256: sha256(body), body });
  }
  for (const [name, contents] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), contents); }
  await mkdir(path.join(root, 'plugins/empty/data'), { recursive: true });
  return root;
}
async function rawTar(file, entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? ''), header = new Header({ path: entry.path, type: entry.type ?? 'File', size: body.length, mode: 0o600, linkpath: entry.linkpath ?? '' });
    header.encode(); blocks.push(header.block, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024)); await writeFile(file, Buffer.concat(blocks));
}

test('complete file inventory survives restore; collector starts disabled with original cache preserved', () => sandbox(async parent => {
  const root = await fixture(parent), output = path.join(parent, 'full.tar.gz');
  const backup = await createStoppedBackup({ root, output, serverId, note: '完整备份验收' });
  const proof = await inspectBackup(output); assert.equal(backup.sha256, proof.sha256);
  assert.equal(proof.manifest.statistics.pendingEvents, '1'); assert.equal(proof.manifest.statistics.cacheIntegrity, 'VERIFIED');
  assert.equal(proof.manifest.statistics.latestAcknowledgedEventAt, '2026-10-26T12:00:00.000Z');
  assert.ok(proof.manifest.files.some(row => row.path.endsWith('000003.log'))); assert.ok(!proof.manifest.files.some(row => row.path.endsWith('/LOCK') || row.path.startsWith('logs/')));
  assert.ok(proof.manifest.directories.includes('plugins/empty/data')); assert.ok(!JSON.stringify(proof.manifest).includes('A'.repeat(43)));
  const destination = path.join(parent, 'restored'); const restored = await restoreBackup({ file: output, destination });
  assert.equal(restored.collectorEnabled, false); assert.equal(restored.worldRuntimeVerified, false); assert.equal(await missing(path.join(destination, '.restore-in-progress')), true);
  const config = JSON.parse(await readFile(path.join(destination, 'plugins/archive-collector/config/config.json'), 'utf8')); assert.equal(config.enabled, false);
  assert.equal(await readFile(path.join(destination, '.mcmanager-restore/original-collector-data/outbox/server-id'), 'utf8'), serverId);
  assert.equal(await readFile(path.join(destination, 'worlds/中文世界/db/000003.log'), 'utf8'), 'essential WAL');
  assert.equal(JSON.parse(await readFile(path.join(root, 'plugins/archive-collector/config/config.json'), 'utf8')).enabled, true);
  await assert.rejects(restoreBackup({ file: output, destination }), /already exists/);
  assert.equal(await readFile(path.join(destination, 'worlds/中文世界/level.dat'), 'utf8'), 'world-fixture');
}));

test('continue keeps original event IDs; fork quarantines the old archive cache', () => sandbox(async parent => {
  const root = await fixture(parent), output = path.join(parent, 'full.tar.gz'); await createStoppedBackup({ root, output, serverId });
  const continued = path.join(parent, 'continue');
  await restoreBackup({ file: output, destination: continued, mode: 'CONTINUE', targetServerId: serverId, collectorToken: serverId + '.' + 'B'.repeat(43), endpoint: 'http://127.0.0.1:8080/api/ingest/v1/batches' });
  const relative = 'plugins/archive-collector/data/outbox';
  const pending = (await readdir(path.join(root, relative))).find(name => name.endsWith('.pending'));
  assert.deepEqual(await readFile(path.join(root, relative, pending)), await readFile(path.join(continued, relative, pending)));
  const forkId = randomUUID(), forked = path.join(parent, 'fork');
  await restoreBackup({ file: output, destination: forked, mode: 'FORK', targetServerId: forkId, collectorToken: forkId + '.' + 'C'.repeat(43), endpoint: 'http://127.0.0.1:8080/api/ingest/v1/batches' });
  assert.equal(await missing(path.join(forked, relative)), true);
  assert.equal(JSON.parse(await readFile(path.join(forked, 'plugins/archive-collector/config/config.json'), 'utf8')).serverId, forkId);
  assert.equal(await readFile(path.join(forked, '.mcmanager-restore/original-collector-data/outbox/server-id'), 'utf8'), serverId);
  await assert.rejects(restoreBackup({ file: output, destination: path.join(parent, 'bad'), mode: 'CONTINUE', targetServerId: forkId }), /original archive/);
  await assert.rejects(restoreBackup({ file: output, destination: path.join(parent, 'bad'), mode: 'FORK', targetServerId: serverId }), /new archive/);
}));

test('a restored server can be backed up again; interrupted cache writes remain visibly unverified', () => sandbox(async parent => {
  const root = await fixture(parent), first = path.join(parent, 'first.tar.gz');
  await writeFile(path.join(root, 'plugins/archive-collector/data/outbox/interrupted.pending.writing'), '{partial');
  const initial = await createStoppedBackup({ root, output: first, serverId }); assert.equal(initial.statistics.cacheIntegrity, 'UNVERIFIED'); assert.equal(initial.statistics.pendingEvents, null);
  const restored = path.join(parent, 'restored-once'); await restoreBackup({ file: first, destination: restored });
  const second = path.join(parent, 'second.tar.gz'); await createStoppedBackup({ root: restored, output: second, serverId });
  const twice = path.join(parent, 'restored-twice'); const result = await restoreBackup({ file: second, destination: twice });
  assert.ok(result.previousMetadataDirectory);
  assert.equal(await readFile(path.join(twice, result.previousMetadataDirectory, 'original-collector-data/outbox/interrupted.pending.writing'), 'utf8'), '{partial');
}));

test('source identity, output boundaries, links, limits and incomplete restore markers fail closed', () => sandbox(async parent => {
  const root = await fixture(parent);
  await assert.rejects(createStoppedBackup({ root, output: path.join(root, 'nested.tar.gz'), serverId }), /outside/);
  await assert.rejects(createStoppedBackup({ root, output: path.join(parent, 'wrong.tar.gz'), serverId: randomUUID() }), /another archive/);
  await assert.rejects(createStoppedBackup({ root, output: path.join(parent, 'limit.tar.gz'), serverId, maxBytes: 1n }), /limits/);
  const outside = path.join(parent, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'secret'), 'must not be followed');
  const junction = path.join(root, 'linked'); await symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createStoppedBackup({ root, output: path.join(parent, 'link.tar.gz'), serverId }), /link|junction/);
  await rm(junction); await link(path.join(outside, 'secret'), path.join(root, 'hardlinked'));
  await assert.rejects(createStoppedBackup({ root, output: path.join(parent, 'hardlink.tar.gz'), serverId }), /hard link/);
  await rm(path.join(root, 'hardlinked')); await writeFile(path.join(root, '.restore-in-progress'), 'partial');
  await assert.rejects(createStoppedBackup({ root, output: path.join(parent, 'partial.tar.gz'), serverId }), /partial restoration/);
}));

test('malicious archive paths, links, duplicate names and changed contents are rejected before publication', () => sandbox(async parent => {
  const attempts = [
    [{ path: '../escape.txt', body: 'bad' }], [{ path: 'server/data:secret', body: 'bad' }],
    [{ path: 'server/link', type: 'SymbolicLink', linkpath: '../../outside', body: '' }],
    [{ path: 'server/link', type: 'Link', linkpath: '../../outside', body: '' }],
    [{ path: 'server/A.txt', body: 'one' }, { path: 'server/a.txt', body: 'two' }],
  ];
  for (const [index, entries] of attempts.entries()) {
    const file = path.join(parent, `malicious-${index}.tar`), destination = path.join(parent, `malicious-${index}`); await rawTar(file, entries);
    await assert.rejects(restoreBackup({ file, destination })); assert.equal(await missing(destination), true);
  }
  const root = await fixture(parent), output = path.join(parent, 'valid.tar.gz'); await createStoppedBackup({ root, output, serverId });
  const proof = await inspectBackup(output);
  const entries = [{ path: 'manifest.json', body: canonicalJson(proof.manifest) }, { path: 'server', type: 'Directory' }, ...proof.manifest.directories.map(name => ({ path: 'server/' + name, type: 'Directory' }))];
  for (const [index, row] of proof.manifest.files.entries()) { const body = await readFile(path.join(root, row.path)); if (index === 0 && body.length) body[0] ^= 1; entries.push({ path: 'server/' + row.path, body }); }
  const forged = path.join(parent, 'changed.tar'); await rawTar(forged, entries); await assert.rejects(inspectBackup(forged), /checksum/);
}));

test('invalid credential metadata fails without including credential contents in diagnostics', () => sandbox(async parent => {
  const root = await fixture(parent), secret = 'PRIVATE_COLLECTOR_CREDENTIAL_MUST_NOT_BE_PRINTED';
  await writeFile(path.join(root, 'plugins/archive-collector/config/config.json'), secret + '{broken');
  await assert.rejects(createStoppedBackup({ root, output: path.join(parent, 'invalid-metadata.tar.gz'), serverId }), error => {
    assert.equal(error.message, 'Metadata file contains invalid JSON'); assert.ok(!error.message.includes(secret)); return true;
  });
  const stage = (await readdir(parent)).find(name => name.startsWith('.mcmanager-pack-'));
  assert.ok(stage); assert.ok(!(await readFile(path.join(parent, stage, 'failure.json'), 'utf8')).includes(secret));
  assert.equal(await missing(path.join(parent, 'invalid-metadata.tar.gz')), true);
}));
