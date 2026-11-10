// Extract this updater beside the original 03-start.cmd. No game files are replaced.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const base = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let lock;
try {
  await readFile(path.join(base, '03-start.cmd'));
  const configPath = path.join(base, 'config/host.json');
  const configBytes = await readFile(configPath), config = JSON.parse(configBytes);
  assert.equal(typeof config.root, 'string', '接入配置缺少游戏目录');
  const { acquireHostLock } = await import(pathToFileURL(path.join(base, 'host/src/host-config.mjs')));
  const { assertServerStopped } = await import(pathToFileURL(path.join(base, 'host/src/processes.mjs')));
  lock = await acquireHostLock(config.root);
  await assertServerStopped(config.root);
  const payload = path.join(base, 'world-backup-update');
  const patch = JSON.parse(await readFile(path.join(payload, 'patch.json'), 'utf8'));
  assert.equal(patch.version, '0.7.0');
  const manifestPath = path.join(base, 'SHA256.json');
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes);
  assert.ok(manifest && !Array.isArray(manifest) && Object.values(manifest).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)), '原安装清单无法识别');
  const files = [];
  for (const [relative, hashes] of Object.entries(patch.files)) {
    assert.match(relative, /^host\/(?:src\/[a-z-]+\.mjs|package(?:-lock)?\.json)$/);
    const before = await readFile(path.join(base, relative));
    const after = await readFile(path.join(payload, relative));
    assert.equal(sha(after), hashes.after, `更新文件损坏：${relative}`);
    assert.ok(Array.isArray(hashes.before) && [...hashes.before, hashes.after].includes(sha(before)), `现有程序版本无法匹配：${relative}。未修改任何文件，请将此提示发给维护人员。`);
    files.push({ relative, before, after, hash: hashes.after });
  }
  assert.ok(files.length >= 6, '更新文件不完整');
  const backup = await mkdtemp(path.join(base, 'world-backup-before-'));
  for (const file of files) {
    const destination = path.join(backup, file.relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.before, { flag: 'wx' });
  }
  await writeFile(path.join(backup, 'SHA256.json'), manifestBytes, { flag: 'wx' });
  await writeFile(path.join(backup, 'host-config.private.json'), configBytes, { flag: 'wx' });
  try {
    for (const file of files) {
      await writeFile(path.join(base, file.relative), file.after);
      const keys = Object.keys(manifest).filter(key => key.replaceAll('\\', '/').replace(/^\.\//, '') === file.relative);
      for (const key of keys.length ? keys : [file.relative]) manifest[key] = file.hash;
    }
    await writeFile(configPath, JSON.stringify({ ...config, backupScope: 'WORLD' }, null, 2) + '\n');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    for (const file of files) assert.equal(sha(await readFile(path.join(base, file.relative))), file.hash);
  } catch (error) {
    for (const file of files) await writeFile(path.join(base, file.relative), file.before);
    await writeFile(configPath, configBytes); await writeFile(manifestPath, manifestBytes);
    throw error;
  }
  console.log('世界存档备份 0.7.0 已安装。只备份当前世界，不再复制插件和采集记录。');
  console.log('运行原来的 03-start.cmd，网页主机版本应显示 0.7.0。然后重新开启每天一次的自动备份。');
  console.log('旧程序和配置已保存在本机 ' + path.basename(backup) + '，其中有凭据，请勿公开分享。');
} catch (error) {
  console.error('更新未完成。请解压到原接入包目录（与 03-start.cmd 同级），正常停服并关闭执行端后再运行。');
  console.error(error.code === 'EADDRINUSE' ? '执行端仍占用控制通道。' : error.code === 'ENOENT' ? '找不到原接入包、配置或更新文件。' : error.message);
  process.exitCode = 1;
} finally { await lock?.close(); }
