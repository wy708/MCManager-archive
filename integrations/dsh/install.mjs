import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { patchBridge, installBridge } from './patch-bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = async p => JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const configPath = path.join(here, 'install.private.json');
const configuration = await readJson(configPath);
const game = path.resolve(configuration.gameRoot);
const bridge = path.resolve(configuration.bridgeRoot);
if (!/^[0-9a-f-]{36}$/.test(configuration.serverId) || !/^[1-9]\d{4,15}$/.test(configuration.groupId)) throw Error('服务器或群号配置无效');
const files = await readJson(path.join(here, 'SHA256.json'));
for (const [relative, expected] of Object.entries(files)) {
  const target = path.resolve(here, relative);
  if (!target.startsWith(here + path.sep) || digest(await fs.readFile(target)) !== expected) throw Error('更新包校验失败：' + relative);
}
const collector = path.join(game, 'plugins', 'archive-collector');
const collectorConfigPath = path.join(collector, 'config', 'config.json');
const collectorConfig = await readJson(collectorConfigPath);
if (collectorConfig.serverId !== configuration.serverId) throw Error('游戏目录的服务器档案不匹配，未修改任何文件');
const bridgeConfig = await readJson(path.join(bridge, 'config.json'));
if (!bridgeConfig.allow?.groups?.map(String).includes(configuration.groupId)
  || bridgeConfig.deny?.groups?.map(String).includes(configuration.groupId)
  || bridgeConfig.socialV2?.tools?.sendMessage === false) throw Error('关联 QQ 群或发送工具未获现有桥接配置允许');
const source = await fs.readFile(path.join(bridge, 'src', 'bridge.js'), 'utf8');
patchBridge(source); // abort on source drift before changing any files
const checkScript = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^bedrock_server(_mod)?\\.exe$' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress";
const powershellCandidates = [
  path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  path.join(process.env.SystemRoot || 'C:/Windows', 'Sysnative/WindowsPowerShell/v1.0/powershell.exe')
];
let ps;
for (const candidate of powershellCandidates) if (await fs.stat(candidate).then(() => true, () => false)) { ps = candidate; break; }
if (!ps) throw Error('找不到 Windows PowerShell，无法确认游戏是否停止，未修改文件');
const processText = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', checkScript], { encoding: 'utf8', windowsHide: true }).trim();
if (processText && processText !== '[]' && processText !== 'null') throw Error('游戏仍在运行。请先正常停止游戏，再安装；不需要结束 DSH。');
if (process.argv.includes('--check')) { console.log('校验通过：包完整、档案和群号匹配、桥接版本可适配、游戏已停止。未修改文件。'); process.exit(0); }
if (!process.argv.includes('--install')) throw Error('请使用 --check 检查或 --install 安装');

const backup = path.join(here, 'installation-backups', new Date().toISOString().replace(/[:.]/g, '-'));
await fs.mkdir(backup, { recursive: true });
for (const name of ['archive-collector.dll', 'manifest.json']) await fs.copyFile(path.join(collector, name), path.join(backup, name));
await fs.copyFile(collectorConfigPath, path.join(backup, 'collector-config.private.json'));
const gameConfigPath = path.join(bridge, 'mcmanager-game-ai.json');
await fs.copyFile(gameConfigPath, path.join(backup, 'mcmanager-game-ai.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
const atomicReplace = async (target, content) => {
  const tmp = target + '.mcmanager-' + crypto.randomUUID();
  try {
    await fs.writeFile(tmp, content, { flag: 'wx' });
    await fs.rename(tmp, target);
  } finally { await fs.unlink(tmp).catch(() => {}); }
};
const originals = new Map();
const targets = [path.join(bridge, 'src', 'bridge.js'), path.join(bridge, 'src', 'mcmanager-game-ai.mjs'),
  ...['archive-collector.dll', 'manifest.json'].map(name => path.join(collector, name)), collectorConfigPath, gameConfigPath];
for (const target of targets) originals.set(target, await fs.readFile(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; }));
const touched = new Set();
try {
  touched.add(targets[0]); touched.add(targets[1]);
  const bridgeBackup = await installBridge(bridge);
  await fs.writeFile(path.join(backup, 'bridge-backup.txt'), bridgeBackup + '\n', 'utf8');
  for (const name of ['archive-collector.dll', 'manifest.json']) {
    const target = path.join(collector, name); touched.add(target);
    await atomicReplace(target, await fs.readFile(path.join(here, 'plugins/archive-collector', name)));
  }
  touched.add(collectorConfigPath);
  await atomicReplace(collectorConfigPath, JSON.stringify({ ...collectorConfig, gameAiEnabled: true }, null, 2) + '\n');
  touched.add(gameConfigPath);
  await atomicReplace(gameConfigPath, JSON.stringify({ schema: 1, enabled: true,
    directory: path.join(collector, 'data', 'game-ai'), serverId: configuration.serverId,
    groupKey: 'group:' + configuration.groupId }, null, 2) + '\n');
} catch (failure) {
  const incomplete = [];
  for (const target of [...touched].reverse()) {
    try {
      const previous = originals.get(target);
      if (previous === null) await fs.unlink(target).catch(e => { if (e.code !== 'ENOENT') throw e; });
      else if (!(await fs.readFile(target).catch(() => Buffer.alloc(0))).equals(previous)) await atomicReplace(target, previous);
    } catch { incomplete.push(target); }
  }
  console.error(incomplete.length ? '自动回滚未完成，请按备份恢复：' + incomplete.join('、') : '安装未完成，已恢复本次修改的原文件。');
  console.error('原文件备份：' + backup);
  throw failure;
}
console.log('游戏 /ai 接入已安装。备份目录：' + backup);
console.log('请重新启动“启动桥接-群聊.bat”，再按原来的 03-start.cmd 启动游戏。DSH 不用重置，会继续使用原群会话和记忆。');
console.log('游戏里输入 /ai 你好，告诉我这条消息来自哪里。回答应仅显示给提问玩家。');
