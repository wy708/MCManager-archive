import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, realpath, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { acquireHostLock } from '../backup/src/host-config.mjs';

const update = path.resolve(process.argv[2]);
const hash = data => createHash('sha256').update(data).digest('hex');
const patch = JSON.parse(await readFile(path.join(update, 'world-backup-update/patch.json'), 'utf8'));
for (const scenario of ['install-and-repeat', 'unknown-original', 'damaged-payload', 'running-host']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcm-world-update-'));
  let lock;
  try {
    await cp(update, root, { recursive: true });
    await cp('backup/src', path.join(root, 'host/src'), { recursive: true });
    await mkdir(path.join(root, 'game')); await mkdir(path.join(root, 'config'));
    await writeFile(path.join(root, '03-start.cmd'), '');
    for (const relative of Object.keys(patch.files)) {
      const old = execFileSync('git', ['show', '3ac08be:backup/' + relative.slice(5)]);
      await writeFile(path.join(root, relative), old);
    }
    const originalConfig = { root: path.join(root, 'game'), token: 'synthetic-secret-do-not-change', apiUrl: 'https://example.invalid', outputDirectory: path.join(root, 'storage') };
    const manifest = { 'unrelated-file': 'a'.repeat(64) };
    for (const name of Object.keys(patch.files)) manifest[name.replaceAll('/', '\\')] = 'b'.repeat(64);
    const configText = JSON.stringify(originalConfig), manifestText = JSON.stringify(manifest);
    await writeFile(path.join(root, 'config/host.json'), configText);
    await writeFile(path.join(root, 'SHA256.json'), manifestText);
    if (scenario === 'unknown-original') await writeFile(path.join(root, 'host/src/archive.mjs'), 'unrecognized local change');
    if (scenario === 'damaged-payload') await writeFile(path.join(root, 'world-backup-update/host/src/archive.mjs'), 'corrupt');
    if (scenario === 'running-host') lock = await acquireHostLock(originalConfig.root);
    const run = () => execFileSync(process.execPath, [path.join(root, 'update-world-backup.mjs')], { stdio: 'pipe', timeout: 30000 });
    if (scenario !== 'install-and-repeat') {
      assert.throws(run);
      assert.equal(await readFile(path.join(root, 'config/host.json'), 'utf8'), configText);
      assert.equal(await readFile(path.join(root, 'SHA256.json'), 'utf8'), manifestText);
      assert.equal((await readdir(root)).some(name => name.startsWith('world-backup-before-')), false);
    } else {
      run(); run();
      assert.deepEqual(JSON.parse(await readFile(path.join(root, 'config/host.json'))), { ...originalConfig, backupScope: 'WORLD' });
      const after = JSON.parse(await readFile(path.join(root, 'SHA256.json')));
      assert.equal(after['unrelated-file'], manifest['unrelated-file']);
      for (const [name, expected] of Object.entries(patch.files)) {
        assert.equal(hash(await readFile(path.join(root, name))), expected.after);
        assert.equal(after[name.replaceAll('/', '\\')], expected.after);
      }
      const backups = (await readdir(root)).filter(name => name.startsWith('world-backup-before-'));
      assert.equal(backups.length, 2);
    }
    console.log('PASS', scenario);
  } finally {
    await lock?.close();
    const actual = await realpath(root);
    assert.equal(path.dirname(actual).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase());
    assert.ok(path.basename(actual).startsWith('mcm-world-update-'));
    await rm(actual, { recursive: true, force: false });
  }
}
