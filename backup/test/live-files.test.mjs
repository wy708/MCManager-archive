import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, utimes } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { createOnlineBackup, createStoppedBackup, inspectBackup, restoreBackup } from '../src/archive.mjs';
import { parseNativeFileList } from '../src/live-files.mjs';
import { captureCollectorCheckpoint, verifyCollectorCheckpoint } from '../src/collector-checkpoint.mjs';
import { canonicalJson, inventory, missing } from '../src/paths.mjs';

const serverId = '11111111-1111-4111-8111-111111111111', world = '纪念, 一期';
function messages(rows, name = world) { return [{ id: 'commands.save-all.success', params: [] }, { id: '%%s', params: [rows.map(row => `${name}/${row.path}:${row.size}`).join(', ')] }]; }
const rows = [{ path: 'level.dat', size: '12' }, { path: 'db/CURRENT', size: '16' }, { path: 'db/MANIFEST-000001', size: '16' }, { path: 'db/000003.ldb', size: '8' }];
async function sandbox(action) {
  // Match production entry points: low-level backup helpers receive canonical paths.
  // Windows runners may expose TEMP through a short name or an ancestor junction.
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mcmanager-live-test-'))), owner = randomUUID(); await writeFile(path.join(parent, '.owner'), owner);
  try { await action(parent); }
  finally {
    const actual = await realpath(parent); assert.equal(path.dirname(actual), await realpath(os.tmpdir())); assert.equal(await readFile(path.join(actual, '.owner'), 'utf8'), owner);
    await rm(actual, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  }
}
async function fixture(parent) {
  const root = path.join(parent, 'server'); await mkdir(root);
  const data = {
    'bedrock_server_mod.exe': 'synthetic fixture; not a game executable', 'server.properties': `level-name=${world}\n`,
    [`worlds/${world}/level.dat`]: 'world-header-and-newer-bytes', [`worlds/${world}/db/CURRENT`]: 'MANIFEST-000001\n',
    [`worlds/${world}/db/MANIFEST-000001`]: 'manifest fixture-newer-bytes', [`worlds/${world}/db/000003.ldb`]: 'original-newer-append',
    [`worlds/${world}/db/000009.log`]: 'not part of the pinned native snapshot', [`worlds/${world}/db/LOCK`]: '',
    [`worlds/${world}/world_resource_packs.json`]: '[]',
    'plugins/archive-collector/config/config.json': canonicalJson({ enabled: false, serverId }),
    'plugins/archive-collector/data/outbox/server-id': serverId,
    'plugins/sample/data/state.json': '{"persistent":true}',
  };
  for (const [name, value] of Object.entries(data)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), value); }
  const game = { root: await realpath(root), held: false, releases: 0, async withSnapshot(action) {
    this.held = true;
    try { return await action({ operationId: randomUUID(), bootId: randomUUID(), snapshotStartedAt: new Date().toISOString(), preparedAt: new Date().toISOString(),
      nativeWriteCacheFlushed: true, messages: messages(rows), signal: new AbortController().signal, assertActive: () => assert.equal(this.held, true) }); }
    finally { this.held = false; this.releases++; }
  } };
  return { root, game };
}
test('native list handles Chinese and comma-space world names and rejects ambiguous or unsafe lists', () => {
  const plan = parseNativeFileList(messages(rows), world); assert.equal(plan.files.length, 4); assert.equal(plan.world, 'worlds/' + world);
  for (const broken of [messages([...rows, rows[0]]), messages([{ path: '../escape', size: '10' }, ...rows]), messages(rows, 'another-world'),
    messages([{ path: 'db/absolute:stream', size: '10' }, ...rows]), messages(rows.map(row => ({ ...row, size: '01' }))), [{ id: 'commands.save-on.notDone', params: [] }]]) {
    assert.throws(() => parseNativeFileList(broken, world));
  }
  assert.throws(() => parseNativeFileList(messages(rows), world, { maxBytes: 1n }));
});

test('world-only hot backup excludes collector history, logs, binaries and other worlds and restores all selected world data', () => sandbox(async parent => {
  const { root, game } = await fixture(parent), output = path.join(parent, 'world.tar.gz');
  await mkdir(path.join(root, 'worlds/other/db'), { recursive: true });
  await writeFile(path.join(root, 'worlds/other/level.dat'), 'not-selected');
  await writeFile(path.join(root, 'logs.txt'), 'actively changing log');
  await mkdir(path.join(root, 'plugins/archive-collector/data/outbox/acknowledged'));
  await writeFile(path.join(root, 'plugins/archive-collector/data/outbox/acknowledged/bad.pending'), 'must not inspect');
  const original = game.withSnapshot;
  game.withSnapshot = function(action) { return original.call(this, snapshot => action({ ...snapshot, collectorCheckpoint: { invalid: true } })); };
  await createOnlineBackup({ root, game, output, serverId, scope: 'WORLD' });
  const proof = await inspectBackup(output);
  assert.equal(proof.manifest.format, 'mcmanager-world-backup');
  assert.equal(proof.manifest.archiveScope, 'WORLD');
  assert.equal(proof.manifest.statistics.cacheIntegrity, 'NOT_INCLUDED');
  assert.equal(proof.manifest.runtime, null);
  assert.equal(proof.manifest.coordination.collectorCheckpoint, undefined);
  assert.ok(proof.manifest.files.every(row => row.path.startsWith(`worlds/${world}/`)));
  assert.equal(proof.manifest.files.find(row => row.path.endsWith('000003.ldb')).size, '8');
  assert.ok(proof.manifest.files.some(row => row.path.endsWith('world_resource_packs.json')));
  assert.equal(game.held, false);
  const destination = path.join(parent, 'world-restored');
  await restoreBackup({ file: output, destination });
  assert.equal(await readFile(path.join(destination, `worlds/${world}/db/000003.ldb`), 'utf8'), 'original');
  assert.equal(await missing(path.join(destination, 'plugins')), true);
  await assert.rejects(restoreBackup({ file: output, destination: path.join(parent, 'bad-continue'), mode: 'CONTINUE' }), /World-only/);
  const stage = path.join(parent, 'scope-forgery'); await mkdir(stage); await tar.extract({ file: output, cwd: stage });
  const bad = structuredClone(proof.manifest); bad.archiveScope = 'FULL';
  await writeFile(path.join(stage, 'manifest.json'), canonicalJson(bad));
  const forged = path.join(parent, 'wrong-scope.tar.gz'); await tar.create({ file: forged, cwd: stage, gzip: true }, ['manifest.json', 'server']);
  await assert.rejects(inspectBackup(forged), /scope/);
  bad.archiveScope = 'WORLD'; bad.worldDirectory = 'worlds/other';
  await writeFile(path.join(stage, 'manifest.json'), canonicalJson(bad));
  const wrongWorld = path.join(parent, 'wrong-world.tar.gz'); await tar.create({ file: wrongWorld, cwd: stage, gzip: true }, ['manifest.json', 'server']);
  await assert.rejects(inspectBackup(wrongWorld), /outside/);
}));

test('stopped world backup includes only selected world and keeps database WAL', () => sandbox(async parent => {
  const { root } = await fixture(parent), output = path.join(parent, 'stopped-world.tar.gz');
  await createStoppedBackup({ root, output, serverId, scope: 'WORLD' });
  const proof = await inspectBackup(output);
  assert.equal(proof.manifest.archiveScope, 'WORLD');
  assert.ok(proof.manifest.files.every(row => row.path.startsWith(`worlds/${world}/`)));
  assert.ok(proof.manifest.files.some(row => row.path.endsWith('000009.log')));
  await assert.rejects(createOnlineBackup({ root, output: path.join(parent, 'invalid.tar.gz'), serverId, scope: 'TYPO' }), /scope/);
}));
test('online capture copies only native prefixes, preserves ancillary files and publishes after release', () => sandbox(async parent => {
  const { root, game } = await fixture(parent), output = path.join(parent, 'online.tar.gz');
  const result = await createOnlineBackup({ root, game, output, serverId, note: 'Synthetic online protocol fixture, not real gameplay' });
  assert.equal(game.held, false); assert.equal(game.releases, 1); assert.equal(result.snapshotMode, 'BDS_SAVE_QUERY');
  const proof = await inspectBackup(output); assert.equal(proof.manifest.coordination.worldFiles.length, rows.length);
  assert.equal(proof.manifest.files.find(row => row.path.endsWith('000003.ldb')).size, '8');
  assert.ok(!proof.manifest.files.some(row => row.path.endsWith('000009.log')));
  assert.ok(proof.manifest.files.some(row => row.path.endsWith('world_resource_packs.json')));
  const destination = path.join(parent, 'restored'); await restoreBackup({ file: output, destination });
  assert.equal(await readFile(path.join(destination, `worlds/${world}/db/000003.ldb`), 'utf8'), 'original');
  assert.equal(await readFile(path.join(root, `worlds/${world}/db/000003.ldb`), 'utf8'), 'original-newer-append');
  assert.ok(proof.manifest.coordination.releaseConfirmedAt <= proof.manifest.createdAt);
  const altered = structuredClone(proof.manifest); altered.coordination.worldFiles[0].size = '1';
  const stage = path.join(parent, 'forged'); await mkdir(stage); await tar.extract({ file: output, cwd: stage, strict: true });
  await writeFile(path.join(stage, 'manifest.json'), canonicalJson(altered));
  const forged = path.join(parent, 'forged.tar.gz'); await tar.create({ file: forged, cwd: stage, gzip: true }, ['manifest.json', 'server']);
  await assert.rejects(inspectBackup(forged), /Coordinated/);
  for (const flag of [false, undefined]) {
    const unflushed = structuredClone(proof.manifest); unflushed.coordination.nativeWriteCacheFlushed = flag;
    await writeFile(path.join(stage, 'manifest.json'), canonicalJson(unflushed));
    const unsafe = path.join(parent, `unflushed-${flag}.tar.gz`); await tar.create({ file: unsafe, cwd: stage, gzip: true }, ['manifest.json', 'server']);
    await assert.rejects(inspectBackup(unsafe), /coordination/);
  }
}));
test('a failed coordinated copy releases its lease and never publishes a completed archive', () => sandbox(async parent => {
  const { root, game } = await fixture(parent), output = path.join(parent, 'failed.tar.gz');
  await writeFile(path.join(root, `worlds/${world}/db/CURRENT`), 'short');
  await assert.rejects(createOnlineBackup({ root, game, output, serverId }), /shorter/);
  assert.equal(game.held, false); assert.equal(game.releases, 1); assert.equal(await missing(output), true);
  assert.equal(await missing(path.join(root, '.mcmanager-backup.lock')), true);
}));
test('cached inventories invalidate a same-length file after a real filesystem change', () => sandbox(async parent => {
  const file = path.join(parent, 'state'); await writeFile(file, 'before'); const cache = new Map();
  const first = await inventory(parent, { cache }); await writeFile(file, 'after!'); await utimes(file, new Date(), new Date(Date.now() + 1000));
  const second = await inventory(parent, { cache }); assert.notEqual(first.files.find(row => row.path === 'state').sha256, second.files.find(row => row.path === 'state').sha256);
}));
test('collector checkpoint preserves a pending batch that moves while copying and excludes later writes', () => sandbox(async parent => {
  const { root } = await fixture(parent), relative = 'plugins/archive-collector/data/outbox';
  const outbox = path.join(root, relative), acknowledged = path.join(outbox, 'acknowledged');
  await mkdir(acknowledged);
  const first = '00000000000000000001_' + randomUUID() + '.pending';
  const second = '00000000000000000002_' + randomUUID() + '.pending';
  const later = '00000000000000000003_' + randomUUID() + '.pending';
  await writeFile(path.join(acknowledged, first), 'original confirmed');
  await writeFile(path.join(outbox, second), 'pending then confirmed');
  const checkpoint = { nextSequence: '3', records: 2, capturedAt: new Date().toISOString(),
    namesSha256: createHash('sha256').update(first + '\n' + second + '\n').digest('hex') };
  let checks = 0;
  const snapshot = { collectorCheckpoint: checkpoint, assertActive() {
    if (++checks === 2) {
      renameSync(path.join(outbox, second), path.join(acknowledged, second));
      writeFileSync(path.join(outbox, later), 'later');
      writeFileSync(path.join(outbox, later + '.writing'), 'unfinished');
    }
  } };
  const destination = path.join(parent, 'staging');
  const captured = await captureCollectorCheckpoint({ root, destination, snapshot, maxBytes: 1000n, maxFiles: 10 });
  assert.equal(captured.files, 2);
  assert.equal(await readFile(path.join(destination, relative, second), 'utf8'), 'pending then confirmed');
  const { files } = await inventory(destination);
  verifyCollectorCheckpoint(checkpoint, files);
  assert.throws(() => verifyCollectorCheckpoint(checkpoint, files.slice(1)), /differ from the native checkpoint/);
  assert.throws(() => verifyCollectorCheckpoint(checkpoint, [...files, { path: relative + '/' + later }]), /differ from the native checkpoint/);
}));
