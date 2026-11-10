import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { canonicalDirectory, check } from './paths.mjs';

const pending = 'plugins/archive-collector/data/outbox';
const acknowledged = pending + '/acknowledged';
const record = /^[0-9]{20}_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.pending$/;
const sequence = name => BigInt(name.slice(0, 20));

export function handledCollectorFile(relative) {
  const folder = path.posix.dirname(relative), name = path.posix.basename(relative);
  return (folder === pending || folder === acknowledged) && record.test(name)
    || folder === pending && name.endsWith('.writing') && record.test(name.slice(0, -8));
}

function validCheckpoint(value) {
  return value && typeof value.nextSequence === 'string' && /^[1-9][0-9]{0,19}$/.test(value.nextSequence)
    && BigInt(value.nextSequence) <= 18446744073709551615n
    && Number.isInteger(value.records) && value.records >= 0 && value.records <= 100000
    && typeof value.namesSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.namesSha256)
    && typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt))
    && new Date(value.capturedAt).toISOString() === value.capturedAt;
}

function matches(checkpoint, names) {
  if (names.length !== checkpoint.records || new Set(names).size !== names.length
      || names.some(name => sequence(name) >= BigInt(checkpoint.nextSequence))) return false;
  const hash = createHash('sha256');
  for (const name of names.sort()) hash.update(name + '\n');
  return hash.digest('hex') === checkpoint.namesSha256;
}

export function verifyCollectorCheckpoint(checkpoint, files) {
  check(validCheckpoint(checkpoint), 'Invalid collector outbox checkpoint');
  const names = [];
  for (const file of files) {
    if (!handledCollectorFile(file.path)) continue;
    const name = path.posix.basename(file.path);
    check(record.test(name), 'Collector checkpoint contains an unfinished write');
    names.push(name);
  }
  check(matches(checkpoint, names), 'Archived collector records differ from the native checkpoint');
}

async function realFolder(root, folder) {
  const location = path.join(root, folder);
  check(path.relative(location, await canonicalDirectory(location)) === '', 'Collector outbox resolves through a link or junction');
  return location;
}

async function openRecord(folder, name) {
  const location = path.join(folder, name);
  const before = await lstat(location, { bigint: true });
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n, 'Collector record is a link or special file');
  const file = await open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await file.stat({ bigint: true });
    check(current.dev === before.dev && current.ino === before.ino && current.nlink === 1n, 'Collector record identity changed');
    return { file, current };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function captureCollectorCheckpoint({ root, destination, snapshot, maxBytes, maxFiles }) {
  const checkpoint = snapshot.collectorCheckpoint;
  check(validCheckpoint(checkpoint) && checkpoint.records <= maxFiles, 'Invalid or oversized collector outbox checkpoint');
  const limit = BigInt(checkpoint.nextSequence), locations = new Map();
  const pendingFolder = await realFolder(root, pending), acknowledgedFolder = await realFolder(root, acknowledged);
  // Acknowledgement only moves an immutable record from pending to acknowledged.
  // Discover pending first, preserving its replayable placement if the record moves.
  for (let attempt = 0; attempt < 8; attempt++) {
    snapshot.assertActive();
    locations.clear();
    for (const [relative, folder] of [[pending, pendingFolder], [acknowledged, acknowledgedFolder]]) {
      for (const name of await readdir(folder)) {
        if (record.test(name) && sequence(name) < limit && !locations.has(name)) locations.set(name, relative);
      }
    }
    if (matches(checkpoint, [...locations.keys()])) break;
  }
  check(matches(checkpoint, [...locations.keys()]), 'Could not locate every record in the native collector checkpoint');
  for (const folder of [pending, acknowledged]) await mkdir(path.join(destination, folder), { recursive: true });
  let bytes = 0n;
  for (const [name, relative] of locations) {
    snapshot.assertActive();
    const opened = relative === pending
      ? await openRecord(pendingFolder, name).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return openRecord(acknowledgedFolder, name);
        })
      : await openRecord(acknowledgedFolder, name);
    const { file, current } = opened;
    try {
      bytes += current.size;
      check(bytes <= maxBytes && current.size <= 3n * 1048576n, 'Collector outbox exceeds configured source limits');
      const target = path.join(destination, relative, name);
      await pipeline(file.createReadStream({ autoClose: false }), createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: snapshot.signal });
      const after = await file.stat({ bigint: true });
      const output = await open(target, 'r+');
      try {
        check(after.mtimeNs === current.mtimeNs && after.size === current.size && after.nlink === 1n
          && (await output.stat({ bigint: true })).size === current.size, 'Collector record changed while it was copied');
        await output.sync();
      } finally { await output.close(); }
    } finally { await file.close(); }
  }
  return { bytes, files: locations.size };
}
