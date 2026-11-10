import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, open, readdir, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

export function check(value, message) { if (!value) throw new Error(message); }
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function safeRelative(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 2048 && value === value.normalize('NFC') && !/[\\:<>"|?*\x00-\x1f\x7f]/u.test(value), 'Archive contains an invalid portable path');
  const parts = value.split('/');
  check(parts.every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'Archive path is absolute, reserved or traverses directories');
  return value;
}
export function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function canonicalDirectory(value) {
  const input = path.resolve(value), entry = await lstat(input);
  check(entry.isDirectory() && !entry.isSymbolicLink(), 'Expected a real directory, not a link');
  return realpath(input);
}
export async function missing(value) { try { await lstat(value); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }
export async function digest(file, signal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}
export async function writeNew(file, data) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
export const canonicalJson = value => JSON.stringify(value, null, 2) + '\n';
export async function ownedDirectory(parent, prefix, owner) {
  const directory = path.join(parent, prefix + owner);
  await mkdir(directory, { mode: 0o700 }); await writeNew(path.join(directory, '.mcmanager-owner'), owner);
  return directory;
}
export async function removeOwned(directory, parent, owner) {
  const actualParent = await canonicalDirectory(parent), actual = await canonicalDirectory(directory);
  check(path.dirname(actual) === actualParent && await readFile(path.join(actual, '.mcmanager-owner'), 'utf8') === owner, 'Refusing cleanup outside the owned staging directory');
  await rm(actual, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
}
export function ephemeral(relative) {
  return relative === 'logs' || relative.startsWith('logs/') || relative === '.mcmanager-backup.lock'
    || /^worlds\/[^/]+\/db\/LOCK$/.test(relative)
    || /^plugins\/archive-collector\/data\/(outbox|replies)\/collector\.lock$/.test(relative);
}
export async function inventory(root, { hashes = true, maxBytes = 137438953472n, maxFiles = 1_000_000, skip = () => false, handled, cache, signal } = {}) {
  const files = [], directories = [], excluded = [], names = new Set(); let total = 0n;
  async function walk(relative) {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      signal?.throwIfAborted();
      const name = safeRelative(relative ? `${relative}/${entry.name}` : entry.name);
      const normalized = name.toLowerCase(); check(!names.has(normalized), 'Source contains colliding file names'); names.add(normalized);
      if (handled?.(name)) continue;
      if (ephemeral(name) || skip(name)) { excluded.push(name); continue; }
      const absolute = path.join(root, name), stat = await lstat(absolute, { bigint: true });
      check(!stat.isSymbolicLink(), 'Source contains a symbolic link or junction');
      check(contains(root, await realpath(absolute)), 'Source entry resolves outside the server root');
      if (stat.isDirectory()) { directories.push(name); await walk(name); }
      else {
        check(stat.isFile() && stat.nlink === 1n, 'Source contains a special file or hard link');
        total += stat.size; check(total <= maxBytes && files.length < maxFiles, 'Backup exceeds configured source limits');
        const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        const previous = cache?.get(name);
        const sha256 = hashes ? previous?.identity === identity && previous.sha256 ? previous.sha256 : await digest(absolute, signal) : null;
        cache?.set(name, { identity, sha256 });
        files.push({ path: name, size: stat.size.toString(), sha256, identity });
      }
    }
  }
  await walk(''); return { files, directories, excluded, bytes: total.toString() };
}
