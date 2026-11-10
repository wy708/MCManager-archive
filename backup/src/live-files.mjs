import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalDirectory, canonicalJson, check, contains, inventory, safeRelative } from './paths.mjs';
import { captureCollectorCheckpoint, handledCollectorFile } from './collector-checkpoint.mjs';

export function parseNativeFileList(messages, levelName, { maxFiles = 100000, maxBytes = 137438953472n } = {}) {
  safeRelative(levelName);
  check(Array.isArray(messages) && messages.length === 2 && messages[0]?.id === 'commands.save-all.success'
    && Array.isArray(messages[0].params) && messages[0].params.length === 0
    && ['%s', '%%s'].includes(messages[1]?.id) && Array.isArray(messages[1].params) && messages[1].params.length === 1
    && typeof messages[1].params[0] === 'string', 'Unrecognized BDS save-query file list');
  const text = messages[1].params[0], prefix = levelName + '/', delimiter = ', ' + prefix, files = [], seen = new Set();
  let offset = 0, total = 0n;
  while (offset < text.length) {
    check(text.startsWith(prefix, offset), 'Native snapshot belongs to a different world');
    const next = text.indexOf(delimiter, offset + prefix.length), entry = text.slice(offset, next === -1 ? undefined : next), end = entry.lastIndexOf(':');
    check(end > 0 && /^(0|[1-9][0-9]*)$/.test(entry.slice(end + 1)), 'Native snapshot path/length list is ambiguous or invalid');
    const relative = entry.slice(0, end); safeRelative(relative);
    check(relative.startsWith(prefix) && !seen.has(relative.toLowerCase()), 'Native snapshot file is outside its world or duplicated');
    const length = entry.slice(end + 1); total += BigInt(length); check(total <= BigInt(maxBytes) && files.length < maxFiles, 'Native world snapshot exceeds configured limits');
    seen.add(relative.toLowerCase()); files.push({ path: 'worlds/' + relative, size: length });
    if (next === -1) break;
    offset = next + 2;
  }
  const world = 'worlds/' + levelName;
  check(files.some(row => row.path === world + '/level.dat' && BigInt(row.size) >= 8n)
    && files.some(row => row.path === world + '/db/CURRENT' && BigInt(row.size) > 0n)
    && files.some(row => row.path.startsWith(world + '/db/MANIFEST-') && BigInt(row.size) > 0n), 'Native snapshot lacks world or database metadata');
  return { world, files, totalBytes: total.toString() };
}
export async function configuredWorld(root) {
  const properties = await readFile(path.join(root, 'server.properties'), 'utf8');
  const values = properties.split(/\r?\n/).filter(line => /^\s*level-name\s*=/.test(line));
  check(values.length === 1, 'Online backups require an explicit, unambiguous level-name');
  const name = values[0].slice(values[0].indexOf('=') + 1).trim(); safeRelative(name); return name;
}
async function hashPrefix(file, length, signal) {
  const hasher = createHash('sha256'); if (!length) return hasher.digest('hex');
  for await (const chunk of createReadStream(file, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0), start: 0, end: Number(length - 1n), signal })) hasher.update(chunk);
  return hasher.digest('hex');
}
async function copyPrefix(root, destination, row, signal) {
  const source = path.join(root, row.path), target = path.join(destination, row.path), length = BigInt(row.size);
  check(contains(root, await canonicalDirectory(path.dirname(source))) && length <= BigInt(Number.MAX_SAFE_INTEGER), 'Invalid native snapshot source');
  const before = await lstat(source, { bigint: true });
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size >= length, 'Native snapshot source is missing, linked or shorter than declared');
  await mkdir(path.dirname(target), { recursive: true }); let received = 0n; const hasher = createHash('sha256');
  if (length) {
    await pipeline(createReadStream(source, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0), start: 0, end: Number(length - 1n) }),
      new Transform({ transform(chunk, _, done) { received += BigInt(chunk.length); hasher.update(chunk); done(null, chunk); } }),
      createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
  } else { const empty = await open(target, 'wx', 0o600); await empty.close(); }
  const digest = hasher.digest('hex'); check(received === length, 'Native snapshot copy was truncated');
  const after = await lstat(source, { bigint: true });
  check(before.ino === after.ino && before.dev === after.dev && after.size >= length && await hashPrefix(source, length, signal) === digest, 'Native snapshot prefix changed while it was being copied');
  const handle = await open(target, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  return { ...row, sha256: digest };
}
export async function captureLiveFiles({ root, destination, snapshot, levelName, copyStable, maxBytes, maxFiles, scope = 'FULL' }) {
  check(snapshot.nativeWriteCacheFlushed === true, 'Native snapshot storage barrier was not confirmed');
  const plan = parseNativeFileList(snapshot.messages, levelName, { maxBytes, maxFiles });
  const captured = [];
  for (const row of plan.files) { snapshot.assertActive(); captured.push(await copyPrefix(root, destination, row, snapshot.signal)); }
  const current = await readFile(path.join(destination, plan.world, 'db/CURRENT'), 'utf8');
  check(/^MANIFEST-[0-9]+\n?$/.test(current) && plan.files.some(row => row.path === plan.world + '/db/' + current.trim()), 'Native database manifest reference is missing');
  const native = new Set(plan.files.map(row => row.path)), capturedAncillary = new Map(), cache = new Map();
  const skip = name => name === plan.world + '/db' || native.has(name)
    || scope === 'WORLD' && name !== 'worlds' && name !== plan.world && !name.startsWith(plan.world + '/');
  const limits = { maxBytes: BigInt(maxBytes) - BigInt(plan.totalBytes), maxFiles: maxFiles - plan.files.length };
  const collectorCheckpoint = scope === 'WORLD' ? undefined : snapshot.collectorCheckpoint;
  const options = { ...limits, skip, cache, signal: snapshot.signal };
  if (collectorCheckpoint !== undefined) {
    const collector = await captureCollectorCheckpoint({ root, destination, snapshot, ...limits });
    options.maxBytes -= collector.bytes;
    options.maxFiles -= collector.files;
    options.handled = handledCollectorFile;
  }
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    snapshot.assertActive();
    try {
      const initial = await inventory(root, options);
      const startedAt = new Date().toISOString(), wanted = new Set(initial.files.map(row => row.path));
      for (const [name] of capturedAncillary) if (!wanted.has(name)) { await unlink(path.join(destination, name)); capturedAncillary.delete(name); }
      for (const folder of initial.directories) await mkdir(path.join(destination, folder), { recursive: true });
      for (const row of initial.files) {
        snapshot.assertActive(); const previous = capturedAncillary.get(row.path);
        if (previous?.identity === row.identity) continue;
        if (previous) { await unlink(path.join(destination, row.path)); capturedAncillary.delete(row.path); }
        try { await copyStable(root, destination, row, { signal: snapshot.signal }); capturedAncillary.set(row.path, row); }
        catch (error) { await unlink(path.join(destination, row.path)).catch(() => {}); throw error; }
      }
      const completedAt = new Date().toISOString();
      const final = await inventory(root, options);
      if (canonicalJson(initial) !== canonicalJson(final)) { last = new Error('Ancillary files changed during online capture'); await delay(100); continue; }
      // Remove only empty, obsolete directories inside this private staging tree.
      const required = new Set(initial.directories);
      for (const row of captured) { let parent = path.posix.dirname(row.path); while (parent !== '.') { required.add(parent); parent = path.posix.dirname(parent); } }
      async function trim(relative) {
        for (const item of await readdir(path.join(destination, relative), { withFileTypes: true })) {
          if (!item.isDirectory()) continue;
          const name = relative ? relative + '/' + item.name : item.name; await trim(name);
          if (!required.has(name)) { check(contains(destination, path.resolve(destination, name)), 'Staging cleanup boundary changed'); await rmdir(path.join(destination, name)); }
        }
      }
      await trim(''); snapshot.assertActive();
      return { controlProtocol: 'native-console-lease-v1', nativeWriteCacheFlushed: true, operationId: snapshot.operationId, bootId: snapshot.bootId,
        snapshotStartedAt: snapshot.snapshotStartedAt, preparedAt: snapshot.preparedAt, worldDirectory: plan.world,
        worldFiles: captured, ancillaryStableInterval: { startedAt, completedAt }, captureAttempts: attempt + 1,
        ...(collectorCheckpoint === undefined ? {} : { collectorCheckpoint }) };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'SOURCE_FILE_CHANGED') throw error;
      last = error; await delay(100);
    }
  }
  throw last ?? new Error('Could not obtain a stable ancillary file snapshot');
}
