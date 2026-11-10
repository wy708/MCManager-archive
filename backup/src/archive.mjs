import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, link, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import * as tar from 'tar';
import { assertServerStopped, executableVersion } from './processes.mjs';
import { captureLiveFiles, configuredWorld } from './live-files.mjs';
import { verifyCollectorCheckpoint } from './collector-checkpoint.mjs';
import { canonicalDirectory, canonicalJson, check, contains, digest, inventory, isUuid, missing, ownedDirectory, removeOwned, safeRelative, writeNew } from './paths.mjs';

const FORMAT = 'mcmanager-full-server-backup', MAX_MANIFEST = 64 * 1024 * 1024;
const WORLD_FORMAT = 'mcmanager-world-backup';
const checkScope = scope => check(['FULL', 'WORLD'].includes(scope), 'Unknown backup scope');
const worldSkip = world => name => name !== 'worlds' && name !== world && !name.startsWith(world + '/');
const DEFAULT_BYTES = 137438953472n, DEFAULT_FILES = 100000;
const hash = data => createHash('sha256').update(data).digest('hex');
const integer = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fileRecord = row => ({ path: row.path, size: row.size, sha256: row.sha256 });

async function optionalJson(file, limit = 1048576) {
  if (await missing(file)) return null;
  check((await lstat(file)).size <= limit, 'Metadata file is too large');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error('Metadata file contains invalid JSON'); }
}
async function runtimeMetadata(root, files) {
  const binary = files.find(file => file.path === 'bedrock_server_mod.exe') ?? files.find(file => ['bedrock_server.exe', 'bedrock_server'].includes(file.path));
  check(binary && files.some(file => file.path === 'server.properties') && files.some(file => /^worlds\/[^/]+\/level\.dat$/.test(file.path)), 'Server binary, properties and a world are required');
  const plugins = [];
  for (const file of files.filter(row => /^plugins\/[^/]+\/manifest\.json$/.test(row.path))) {
    try {
      const manifest = await optionalJson(path.join(root, file.path));
      plugins.push({ path: file.path, name: typeof manifest?.name === 'string' ? manifest.name.slice(0, 80) : null,
        version: typeof manifest?.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(manifest.version) ? manifest.version : null });
    } catch { plugins.push({ path: file.path, name: null, version: null }); }
  }
  return { platform: process.platform, bds: { path: binary.path, version: await executableVersion(path.join(root, binary.path)), sha256: binary.sha256 }, plugins };
}
async function statisticsMetadata(root, serverId) {
  const outbox = path.join(root, 'plugins/archive-collector/data/outbox');
  const config = await optionalJson(path.join(root, 'plugins/archive-collector/config/config.json'), 16384);
  if (config?.serverId) check(config.serverId === serverId, 'Collector configuration belongs to another archive');
  if (await missing(path.join(outbox, 'server-id'))) return { archiveBinding: 'UNVERIFIED', centralDatabaseIncluded: false, pendingEvents: null, latestAcknowledgedEventAt: null, cacheIntegrity: 'NOT_CONFIGURED' };
  check(await readFile(path.join(outbox, 'server-id'), 'utf8') === serverId, 'Collector cache belongs to another archive');
  let pending = 0n, acknowledgedAt = null, valid = true;
  for (const directory of ['pending', 'acknowledged']) {
    const folder = directory === 'pending' ? outbox : path.join(outbox, directory);
    if (await missing(folder)) continue;
    for (const name of await readdir(folder)) {
      if (name.endsWith('.writing')) { valid = false; continue; }
      if (!name.endsWith('.pending')) continue;
      try {
        const wrapper = await optionalJson(path.join(folder, name), 4 * 1048576);
        check(wrapper.schema === 1 && typeof wrapper.body === 'string' && hash(wrapper.body) === wrapper.sha256, 'Invalid cache checksum');
        const batch = JSON.parse(wrapper.body); check(Array.isArray(batch.events), 'Invalid cache event list');
        if (directory === 'pending') pending += BigInt(batch.events.length);
        else for (const event of batch.events) if (iso(event.at) && (!acknowledgedAt || event.at > acknowledgedAt)) acknowledgedAt = event.at;
      } catch { valid = false; }
    }
  }
  return { archiveBinding: 'VERIFIED', centralDatabaseIncluded: false, pendingEvents: valid ? pending.toString() : null,
    latestAcknowledgedEventAt: acknowledgedAt, cacheIntegrity: valid ? 'VERIFIED' : 'UNVERIFIED' };
}
async function copyVerified(root, staged, file, { signal } = {}) {
  const source = path.join(root, file.path), target = path.join(staged, file.path);
  check(contains(root, await canonicalDirectory(path.dirname(source))), 'Source parent escaped the selected server root');
  const hasher = createHash('sha256'); let bytes = 0n;
  await pipeline(createReadStream(source, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) }),
    new Transform({ transform(chunk, _, callback) { hasher.update(chunk); bytes += BigInt(chunk.length); callback(null, chunk); } }),
    createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
  const handle = await open(target, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  if (bytes.toString() !== file.size || hasher.digest('hex') !== file.sha256) {
    const error = new Error('A source file changed while the snapshot was copied'); error.code = 'SOURCE_FILE_CHANGED'; throw error;
  }
}

async function packStaged({ stagedServer, initial, stage, parent, output, id, serverId, note, startedAt, maxBytes, maxFiles, coordination, scope = 'FULL', worldDirectory }) {
  const manifest = { format: scope === 'WORLD' ? WORLD_FORMAT : FORMAT, schema: 1, backupId: id, serverId,
    archiveScope: scope, ...(scope === 'WORLD' ? { worldDirectory } : {}),
    producer: { name: 'mcmanager-archive-backup-host', version: '0.7.0', node: process.version, archiveLibrary: 'tar 7.5.22' },
    snapshotMode: coordination ? 'BDS_SAVE_QUERY' : 'STOPPED', snapshotStartedAt: startedAt,
    createdAt: new Date().toISOString(), note, runtime: scope === 'WORLD' ? null : await runtimeMetadata(stagedServer, initial.files),
    statistics: scope === 'WORLD' ? { centralDatabaseIncluded: false, cacheIntegrity: 'NOT_INCLUDED', pendingEvents: null, latestAcknowledgedEventAt: null } : await statisticsMetadata(stagedServer, serverId), externalDatabases: 'NOT_INCLUDED',
    directories: initial.directories, excludedEphemeral: initial.excluded, totalBytes: initial.bytes, files: initial.files.map(fileRecord),
    ...(coordination ? { coordination } : {}) };
  const encoded = canonicalJson(manifest); check(Buffer.byteLength(encoded) <= MAX_MANIFEST, 'Backup manifest exceeds the format limit');
  await writeNew(path.join(stage, 'manifest.json'), encoded);
  const temporary = path.join(parent, `.mcmanager-archive-${id}.partial`);
  await tar.create({ file: temporary, cwd: stage, gzip: { level: 1 }, portable: true, strict: true, follow: false, noDirRecurse: true },
    ['manifest.json', 'server', ...initial.directories.map(name => 'server/' + name), ...initial.files.map(file => 'server/' + file.path)]);
  const archiveHandle = await open(temporary, 'r+'); try { await archiveHandle.sync(); } finally { await archiveHandle.close(); }
  const proof = await inspectBackup(temporary, { maxBytes, maxFiles }); check(proof.manifest.backupId === id, 'Created archive identity changed');
  await link(temporary, output); await unlink(temporary);
  return { path: output, backupId: id, serverId, sha256: proof.sha256, archiveBytes: proof.archiveBytes, sourceBytes: manifest.totalBytes,
    fileCount: manifest.files.length, archiveScope: scope, createdAt: manifest.createdAt, snapshotMode: manifest.snapshotMode, statistics: manifest.statistics, restoreVerified: false };
}

export async function createStoppedBackup({ root, output, serverId, note = '', maxBytes = DEFAULT_BYTES, maxFiles = DEFAULT_FILES, scope = 'FULL' }) {
  checkScope(scope);
  check(isUuid(serverId) && typeof note === 'string' && note.length <= 1000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(note), 'Invalid archive identity or backup note');
  root = await canonicalDirectory(root); const parent = await canonicalDirectory(path.dirname(path.resolve(output))); output = path.join(parent, path.basename(output));
  check(!contains(root, output) && await missing(output), 'Backup output must be new and outside the server root');
  check(await missing(path.join(root, '.restore-in-progress')), 'A partial restoration cannot be used as a completed server snapshot');
  const id = randomUUID(), lockFile = path.join(root, '.mcmanager-backup.lock');
  const lock = await open(lockFile, 'wx', 0o600), lockIdentity = await lock.stat({ bigint: true });
  let stage, complete = false;
  try {
    await lock.writeFile(canonicalJson({ operationId: id, pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync();
    await assertServerStopped(root); const startedAt = new Date().toISOString();
    const worldDirectory = scope === 'WORLD' ? 'worlds/' + await configuredWorld(root) : undefined;
    const options = { maxBytes: BigInt(maxBytes), maxFiles, ...(worldDirectory ? { skip: worldSkip(worldDirectory) } : {}) };
    const initial = await inventory(root, options);
    stage = await ownedDirectory(parent, '.mcmanager-pack-', id); const stagedServer = path.join(stage, 'server'); await mkdir(stagedServer);
    for (const name of initial.directories) await mkdir(path.join(stagedServer, name), { recursive: true });
    for (const file of initial.files) await copyVerified(root, stagedServer, file);
    const final = await inventory(root, options);
    check(canonicalJson(initial) === canonicalJson(final), 'Server files changed during the stopped snapshot');
    if (worldDirectory) check('worlds/' + await configuredWorld(root) === worldDirectory, 'World configuration changed during backup');
    await assertServerStopped(root);
    const result = await packStaged({ stagedServer, initial, stage, parent, output, id, serverId, note, startedAt, maxBytes, maxFiles, scope, worldDirectory }); complete = true;
    await removeOwned(stage, parent, id);
    return result;
  } catch (error) {
    if (stage) await writeNew(path.join(stage, 'failure.json'), canonicalJson({ operationId: id, stage: complete ? 'PUBLISHED' : 'INCOMPLETE', message: error.message })).catch(() => {});
    throw error;
  } finally {
    await lock.close();
    const current = await lstat(lockFile, { bigint: true }).catch(() => null);
    if (current && current.ino === lockIdentity.ino && current.dev === lockIdentity.dev) await unlink(lockFile);
  }
}

export async function createOnlineBackup({ root, output, serverId, game, note = '', maxBytes = DEFAULT_BYTES, maxFiles = DEFAULT_FILES, scope = 'FULL' }) {
  checkScope(scope);
  check(isUuid(serverId) && typeof note === 'string' && note.length <= 1000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(note), 'Invalid archive identity or backup note');
  root = await canonicalDirectory(root); check(game?.root === root && typeof game.withSnapshot === 'function', 'Online backup must use the supervisor of this exact server directory');
  const parent = await canonicalDirectory(path.dirname(path.resolve(output))); output = path.join(parent, path.basename(output));
  check(!contains(root, output) && await missing(output), 'Backup output must be new and outside the server root');
  check(await missing(path.join(root, '.restore-in-progress')), 'A partial restoration cannot be used as a backup source');
  const id = randomUUID(), lockFile = path.join(root, '.mcmanager-backup.lock'), lock = await open(lockFile, 'wx', 0o600), lockIdentity = await lock.stat({ bigint: true });
  let stage, complete = false;
  try {
    await lock.writeFile(canonicalJson({ operationId: id, pid: process.pid, mode: 'BDS_SAVE_QUERY', createdAt: new Date().toISOString() })); await lock.sync();
    const levelName = await configuredWorld(root);
    stage = await ownedDirectory(parent, '.mcmanager-live-', id); const stagedServer = path.join(stage, 'server'); await mkdir(stagedServer);
    const coordination = await game.withSnapshot(async snapshot => {
      const captured = await captureLiveFiles({ root, destination: stagedServer, snapshot, levelName, copyStable: copyVerified, maxBytes: BigInt(maxBytes), maxFiles, scope });
      check(await configuredWorld(scope === 'WORLD' ? root : stagedServer) === levelName, 'World configuration changed during online backup'); return captured;
    });
    coordination.releaseConfirmedAt = new Date().toISOString();
    const initial = await inventory(stagedServer, { maxBytes: BigInt(maxBytes), maxFiles });
    // All compression and whole-archive verification happen after native release.
    const result = await packStaged({ stagedServer, initial, stage, parent, output, id, serverId, note,
      startedAt: coordination.snapshotStartedAt, maxBytes, maxFiles, coordination, scope, worldDirectory: 'worlds/' + levelName }); complete = true;
    await removeOwned(stage, parent, id); return result;
  } catch (error) {
    if (stage) await writeNew(path.join(stage, 'failure.json'), canonicalJson({ operationId: id, stage: complete ? 'PUBLISHED' : 'INCOMPLETE', message: error.message })).catch(() => {});
    throw error;
  } finally {
    await lock.close(); const current = await lstat(lockFile, { bigint: true }).catch(() => null);
    if (current && current.ino === lockIdentity.ino && current.dev === lockIdentity.dev) await unlink(lockFile);
  }
}

function validateManifest(value, { maxBytes, maxFiles }) {
  check([FORMAT, WORLD_FORMAT].includes(value?.format) && value.schema === 1 && isUuid(value.backupId) && isUuid(value.serverId) && ['STOPPED', 'BDS_SAVE_QUERY'].includes(value.snapshotMode) && iso(value.createdAt) && iso(value.snapshotStartedAt), 'Unknown or invalid backup manifest');
  const worldOnly = value.format === WORLD_FORMAT;
  check(worldOnly ? value.archiveScope === 'WORLD' : value.archiveScope === undefined || value.archiveScope === 'FULL', 'Backup scope differs from its format');
  check(Array.isArray(value.files) && value.files.length <= maxFiles && Array.isArray(value.directories) && value.directories.length <= maxFiles && integer(value.totalBytes), 'Invalid manifest inventory');
  let total = 0n; const names = new Set();
  for (const directory of value.directories) { safeRelative(directory); check(!names.has(directory.toLowerCase()), 'Duplicate manifest directory'); names.add(directory.toLowerCase()); }
  for (const file of value.files) {
    safeRelative(file.path); check(integer(file.size) && /^[0-9a-f]{64}$/.test(file.sha256) && !names.has(file.path.toLowerCase()), 'Invalid or colliding manifest file');
    names.add(file.path.toLowerCase()); total += BigInt(file.size);
  }
  check(total.toString() === value.totalBytes && total <= BigInt(maxBytes), 'Manifest byte count exceeds its limit or does not match');
  if (worldOnly) {
    safeRelative(value.worldDirectory);
    check(/^worlds\/[^/]+$/.test(value.worldDirectory), 'Invalid world backup directory');
    check(value.files.every(row => row.path.startsWith(value.worldDirectory + '/'))
      && value.directories.every(name => !worldSkip(value.worldDirectory)(name)), 'World backup contains files outside the selected world');
    check(value.files.some(row => row.path === value.worldDirectory + '/level.dat')
      && value.files.some(row => row.path === value.worldDirectory + '/db/CURRENT')
      && value.files.some(row => row.path.startsWith(value.worldDirectory + '/db/MANIFEST-')), 'World backup lacks database metadata');
    check(value.runtime === null && value.statistics?.cacheIntegrity === 'NOT_INCLUDED', 'World backup incorrectly claims full server metadata');
    check(!value.coordination?.collectorCheckpoint, 'World backup cannot claim a collector checkpoint');
  }
  if (value.snapshotMode === 'BDS_SAVE_QUERY') {
    const control = value.coordination;
    check(control?.controlProtocol === 'native-console-lease-v1' && control.nativeWriteCacheFlushed === true && isUuid(control.operationId) && isUuid(control.bootId)
      && control.snapshotStartedAt === value.snapshotStartedAt && iso(control.preparedAt) && iso(control.releaseConfirmedAt)
      && iso(control.ancillaryStableInterval?.startedAt) && iso(control.ancillaryStableInterval?.completedAt), 'Missing online snapshot coordination evidence');
    safeRelative(control.worldDirectory); check(control.worldDirectory.startsWith('worlds/') && Array.isArray(control.worldFiles) && control.worldFiles.length > 0, 'Invalid coordinated world file list');
      if (worldOnly) check(control.worldDirectory === value.worldDirectory, 'Coordinated world differs from selected world');
    const actual = new Map(value.files.map(row => [row.path, row])), selected = new Set();
    for (const row of control.worldFiles) {
      safeRelative(row.path); const stored = actual.get(row.path);
      check(row.path.startsWith(control.worldDirectory + '/') && !selected.has(row.path) && stored && row.size === stored.size && row.sha256 === stored.sha256, 'Coordinated world file differs from archive inventory'); selected.add(row.path);
    }
    for (const row of value.files) if (row.path.startsWith(control.worldDirectory + '/db/')) check(selected.has(row.path), 'Online database includes files outside its native snapshot');
    if (control.collectorCheckpoint !== undefined) verifyCollectorCheckpoint(control.collectorCheckpoint, value.files);
  }
}
function entryName(entry) {
  const name = entry.type === 'Directory' && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
  safeRelative(name); check(['File', 'Directory'].includes(entry.type) && !entry.linkpath, 'Links and special archive entries are not permitted');
  check(name === 'manifest.json' || name === 'server' || name.startsWith('server/'), 'Entry is outside the backup layout');
  return name;
}
export async function inspectBackup(file, { maxBytes = DEFAULT_BYTES, maxFiles = DEFAULT_FILES,signal } = {}) {
  check((await lstat(file)).isFile() && !(await lstat(file)).isSymbolicLink(), 'Backup must be a regular file');
  const names = new Map(); let manifestBytes, total = 0n, parser;
  parser = tar.list({ strict: true, maxMetaEntrySize: 1048576, onReadEntry(entry) {
    try {
      const name = entryName(entry), key = name.toLowerCase(); check(!names.has(key) && names.size < maxFiles * 2 + 2, 'Duplicate archive entry or too many entries');
      check(Number.isSafeInteger(entry.size) && entry.size >= 0, 'Archive entry size is not supported');
      total += BigInt(entry.size); check(total <= BigInt(maxBytes) + BigInt(MAX_MANIFEST), 'Expanded archive exceeds its byte limit');
      const metadata = { path: name, size: String(entry.size), type: entry.type }; names.set(key, metadata);
      if (name === 'manifest.json') {
        check(entry.type === 'File' && entry.size <= MAX_MANIFEST, 'Manifest must be a bounded regular file'); const chunks = [];
        entry.on('data', chunk => chunks.push(chunk)); entry.on('end', () => { manifestBytes = Buffer.concat(chunks); });
      } else if (entry.type === 'File') {
        const hasher = createHash('sha256'); entry.on('data', chunk => hasher.update(chunk)); entry.on('end', () => { metadata.sha256 = hasher.digest('hex'); });
      } else entry.resume();
    } catch (error) { entry.resume(); parser.abort(error); }
  } });
  await pipeline(createReadStream(file), parser,{signal});
  check(manifestBytes, 'Backup manifest is missing'); const manifest = JSON.parse(manifestBytes.toString('utf8'));
  check(canonicalJson(manifest) === manifestBytes.toString('utf8'), 'Manifest is not canonical JSON');
  validateManifest(manifest, { maxBytes, maxFiles });
  const expected = new Map([['manifest.json', { type: 'File', size: String(manifestBytes.length) }], ['server', { type: 'Directory', size: '0' }],
    ...manifest.directories.map(name => ['server/' + name, { type: 'Directory', size: '0' }]), ...manifest.files.map(row => ['server/' + row.path, { type: 'File', size: row.size }])]);
  check(expected.size === names.size, 'Archive inventory differs from the manifest');
  for (const [name, metadata] of expected) { const actual = names.get(name.toLowerCase()); check(actual && actual.path === name && actual.type === metadata.type && actual.size === metadata.size, 'Archive entry differs from the manifest'); }
  for (const row of manifest.files) check(names.get(('server/' + row.path).toLowerCase()).sha256 === row.sha256, 'Archive file checksum differs from the manifest');
  return { manifest, sha256: await digest(file,signal), archiveBytes: String((await stat(file)).size) };
}

export async function restoreBackup({ file, destination, mode = 'DISABLED', targetServerId, collectorToken, endpoint, maxBytes = DEFAULT_BYTES, maxFiles = DEFAULT_FILES,restorationId=randomUUID(),signal,prepareCollector,onPrepared,beforePublish,onPhase }) {
  const proof = await inspectBackup(file, { maxBytes, maxFiles,signal });
  const manifest = proof.manifest, id = restorationId; check(isUuid(id),'Invalid restoration identity');
  check(['DISABLED', 'CONTINUE', 'FORK'].includes(mode), 'Restore mode must be DISABLED, CONTINUE or FORK');
  check(manifest.format !== WORLD_FORMAT || mode === 'DISABLED', 'World-only backups restore to a new directory without collector changes');
  targetServerId ??= manifest.serverId; check(isUuid(targetServerId), 'Invalid target archive identity');
  check(mode !== 'FORK' ? targetServerId === manifest.serverId : targetServerId !== manifest.serverId, 'Continue must keep the original archive; fork must use a new archive');
  if (mode !== 'DISABLED') {
    check(typeof prepareCollector==='function'||typeof collectorToken === 'string' && new RegExp(`^${targetServerId}\\.[A-Za-z0-9_-]{43}$`).test(collectorToken), 'Restore requires a fresh credential for the target archive');
    const url = new URL(endpoint); check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/api/ingest/v1/batches'), 'Invalid restore collector endpoint');
  }
  const parent = await canonicalDirectory(path.dirname(path.resolve(destination))); destination = path.join(parent, path.basename(destination)); safeRelative(path.basename(destination));
  check(await missing(destination), 'Restore destination already exists; existing worlds are never overwritten');
  const stage = await ownedDirectory(parent, '.mcmanager-restore-', id); let published = false;
  try {
    signal?.throwIfAborted();await onPhase?.('EXTRACTING');
    let unpack;
    unpack = tar.extract({ cwd: stage, strict: true, preservePaths: false, noChown: true, chmod: false,
      filter(_, entry) { try { entryName(entry); return true; } catch (error) { unpack.abort(error); return false; } } });
    await pipeline(createReadStream(file), unpack,{signal});
    check(await digest(file,signal) === proof.sha256, 'Backup file changed while it was being restored');
    const server = path.join(stage, 'server');
    const inventoryAfter = await inventory(server, { maxBytes: BigInt(maxBytes), maxFiles,signal });
    const expected = new Map(manifest.files.map(row => [row.path, row]));
    check(inventoryAfter.files.length === expected.size, 'Restored file count differs from the manifest');
    for (const row of inventoryAfter.files) { const original = expected.get(row.path); check(original && row.size === original.size && row.sha256 === original.sha256, 'Restored file checksum differs from the manifest'); }
    const restoreMeta = path.join(server, '.mcmanager-restore');
    let previousMetadataDirectory = null;
    if (!(await missing(restoreMeta))) { previousMetadataDirectory = '.mcmanager-restore-history-' + id; await rename(restoreMeta, path.join(server, previousMetadataDirectory)); }
    await mkdir(restoreMeta, { mode: 0o700 });
    await writeNew(path.join(restoreMeta, 'backup-manifest.json'), canonicalJson(manifest));
    const config = path.join(server, 'plugins/archive-collector/config/config.json');
    if (!(await missing(config))) {
      await copyFile(config, path.join(restoreMeta, 'original-collector-config.json'), constants.COPYFILE_EXCL);
      const original = await optionalJson(config, 16384);
      if(mode!=='DISABLED'&&prepareCollector)collectorToken=await prepareCollector(original);
      if(mode!=='DISABLED')check(typeof collectorToken==='string'&&new RegExp(`^${targetServerId}\\.[A-Za-z0-9_-]{43}$`).test(collectorToken),'Invalid prepared target credential');
      const configured = { ...original, enabled: mode !== 'DISABLED', serverId: targetServerId };
      if (mode !== 'DISABLED') { configured.token = collectorToken; configured.endpoint = endpoint; }
      const replacement = path.join(restoreMeta, 'collector-config.new'); await writeNew(replacement, canonicalJson(configured)); await rename(replacement, config);
    } else check(mode === 'DISABLED', 'This backup has no archive collector configuration');
    if (mode !== 'CONTINUE') {
      const data = path.join(server, 'plugins/archive-collector/data');
      if (!(await missing(data))) await rename(data, path.join(restoreMeta, 'original-collector-data'));
    }
    const restoration = { schema: 1, restorationId: id, backupId: manifest.backupId, backupSha256: proof.sha256, restoredAt: new Date().toISOString(),
      sourceServerId: manifest.serverId, targetServerId, mode, collectorEnabled: mode !== 'DISABLED',
      previousMetadataDirectory,
      statisticsPolicy: mode === 'CONTINUE' ? 'PRESERVE_CENTRAL_HISTORY_AND_IDEMPOTENT_CACHE_REPLAY' : 'ORIGINAL_CACHE_QUARANTINED_NO_AUTOMATIC_REPLAY',
      pendingEventsAtSnapshot: manifest.statistics?.pendingEvents ?? null, worldRuntimeVerified: false };
    await writeNew(path.join(restoreMeta, 'restoration.json'), canonicalJson(restoration));
    const finalInventory=await inventory(server,{maxBytes:BigInt(maxBytes)+BigInt(MAX_MANIFEST),maxFiles:maxFiles+16,signal});
    const inventoryText=canonicalJson({schema:1,files:finalInventory.files.map(({path,size,sha256})=>({path,size,sha256})),directories:finalInventory.directories});
    const inventorySha256=createHash('sha256').update(inventoryText).digest('hex');
    await writeNew(path.join(restoreMeta,'restored-inventory.json'),inventoryText);
    await onPrepared?.({inventorySha256});signal?.throwIfAborted();await beforePublish?.();await onPhase?.('PUBLISHING');signal?.throwIfAborted();
    await mkdir(destination, { mode: 0o700 }); published = true;
    await writeNew(path.join(destination, '.restore-in-progress'), id);
    const children = await readdir(server);
    children.sort((a, b) => Number(/\.exe$/i.test(a)) - Number(/\.exe$/i.test(b)) || a.localeCompare(b, 'en'));
    for (const child of children) {signal?.throwIfAborted();await rename(path.join(server, child), path.join(destination, child));}
    signal?.throwIfAborted();
    await unlink(path.join(destination, '.restore-in-progress')); await removeOwned(stage, parent, id);
    return { ...restoration, destination, fileCount: manifest.files.length,inventorySha256 };
  } catch (error) {
    await writeNew(path.join(stage, 'failure.json'), canonicalJson({ restorationId: id, destinationCreated: published, message: error.message })).catch(() => {});
    throw error;
  }
}

export async function verifyRestoredDirectory(destination,expected,{signal,maxBytes=DEFAULT_BYTES,maxFiles=DEFAULT_FILES}={}) {
  const root=await canonicalDirectory(destination);check(await missing(path.join(root,'.restore-in-progress')),'Restoration is incomplete');
  const meta=path.join(root,'.mcmanager-restore');await canonicalDirectory(meta);
  const receipt=await optionalJson(path.join(meta,'restoration.json'),65536);
  check(receipt?.restorationId===expected.restorationId&&receipt.backupId===expected.sourceBackupId&&receipt.backupSha256===expected.archiveSha256&&receipt.targetServerId===expected.targetServerId&&receipt.mode===expected.mode&&receipt.sourceServerId===expected.sourceServerId,'Restored receipt differs from original task');
  check(/^[a-f0-9]{64}$/.test(expected.inventorySha256),'No durable restored inventory confirmation');
  const inventoryFile=path.join(meta,'restored-inventory.json'),entry=await lstat(inventoryFile);
  check(entry.isFile()&&!entry.isSymbolicLink()&&entry.nlink===1&&entry.size<=MAX_MANIFEST,'Invalid restored inventory file');
  check(await digest(inventoryFile,signal)===expected.inventorySha256,'Restored inventory receipt changed');
  const saved=JSON.parse(await readFile(inventoryFile,'utf8'));
  const actual=await inventory(root,{maxBytes:BigInt(maxBytes)+BigInt(MAX_MANIFEST),maxFiles:maxFiles+16,skip:name=>name==='.mcmanager-restore/restored-inventory.json',signal});
  check(saved.schema===1&&canonicalJson(saved.directories)===canonicalJson(actual.directories)&&canonicalJson(saved.files)===canonicalJson(actual.files.map(({path,size,sha256})=>({path,size,sha256}))),'Restored files changed or are incomplete');
  return receipt;
}
