import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, writeFile, realpath, stat, mkdir, copyFile, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { assertServerStopped } from './host/src/processes.mjs';
import { readHostConfig } from './host/src/host-config.mjs';
import { withMapPython } from './host/src/runtime-environment.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.join(base, 'config');
const stateFile = path.join(configDir, 'installation.json');
const defaultOrigin = 'https://mc.example.com';
const connectionFile = path.join(base, 'connection.private.json');
const execute = promisify(execFile);
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const exists = async file => access(file).then(() => true, () => false);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const inside = (parent, child) => child.toLowerCase() === parent.toLowerCase() || child.toLowerCase().startsWith(parent.toLowerCase() + path.sep);
const safeRelative = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');
let input;
async function ask(label) {
  input ??= createInterface({ input: process.stdin, output: process.stdout });
  return (await input.question(label)).trim().replace(/^"(.*)"$/, '$1');
}
async function writeJson(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
async function verify() {
  const hashes = await json(path.join(base, 'SHA256.json'));
  for (const [relative, expected] of Object.entries(hashes)) {
    assert.ok(safeRelative(relative), '安装包清单包含无效路径');
    assert.equal(await sha(path.join(base, relative)), expected, `安装包文件损坏：${relative}`);
  }
  return hashes;
}
async function boundGame() {
  const state = await json(stateFile);
  const root = await realpath(state.gameRoot);
  assert.equal(root, state.gameRoot, '服务端目录已经移动，请重新检查安装配置');
  const identity = await json(path.join(base, 'payload/plugins/AAA-archive-runtime-compat/identity.json'));
  for (const [file, hash] of [
    ['bedrock_server.exe', identity.officialExecutableSHA256], ['bedrock_server_mod.exe', identity.loadedExecutableSHA256],
    ['PreLoader.dll', identity.preLoaderSHA256], ['plugins/LeviLamina/LeviLamina.dll', identity.leviLaminaSHA256],
  ]) assert.equal(await sha(path.join(root, file)), hash, `运行文件不匹配：${file}`);
  return root;
}
async function install() {
  const hashes = await verify();
  assert.ok(!await exists(stateFile), '这个安装包已经绑定过游戏目录，请先查看 config/installation.json');
  const flag = process.argv.indexOf('--game');
  const root = await realpath(flag >= 0 ? process.argv[flag + 1] : await ask('请输入已有 BDS 1.26.61.1 服务端目录：'));
  const packageRoot = await realpath(base);
  assert.ok(!inside(root, packageRoot) && !inside(packageRoot, root), '请把安装包解压到游戏目录之外，两个目录不能互相包含');
  await assertServerStopped(root);
  const identity = await json(path.join(base, 'payload/plugins/AAA-archive-runtime-compat/identity.json'));
  const original = path.join(root, 'bedrock_server.exe');
  assert.equal(await sha(original), identity.officialExecutableSHA256, '仅支持原版 Windows BDS 1.26.61.1；文件不匹配，未安装任何内容');
  const files = Object.keys(hashes).filter(f => f.startsWith('payload/')).map(f => f.slice(8));
  for (const dir of ['plugins/LeviLamina', 'plugins/AAA-archive-runtime-compat', 'plugins/archive-collector']) {
    assert.ok(!await exists(path.join(root, dir)), `检测到已有插件目录 ${dir}，不会覆盖，请先联系维护人员确认升级方式`);
  }
  for (const relative of [...files, 'bedrock_server_mod.exe']) {
    assert.ok(!await exists(path.join(root, relative)), `目标文件已存在，拒绝覆盖：${relative}`);
  }
  await mkdir(configDir, { recursive: true });
  const stage = path.join(configDir, 'install-stage-' + randomUUID());
  await mkdir(stage);
  const installed = [];
  try {
    console.log('校验已通过，正在生成框架启动文件。原始服务端文件保持不变。');
    await copyFile(original, path.join(stage, 'bedrock_server.exe'), constants.COPYFILE_EXCL);
    await copyFile(path.join(base, 'tools/PeEditor.exe'), path.join(stage, 'PeEditor.exe'));
    await copyFile(path.join(base, 'payload/PreLoader.dll'), path.join(stage, 'PreLoader.dll'));
    await execute(path.join(stage, 'PeEditor.exe'), ['-mb'], { cwd: stage, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const patched = path.join(stage, 'bedrock_server_mod.exe');
    assert.equal(await sha(patched), identity.loadedExecutableSHA256, '生成的启动文件与已适配构建不一致，未修改游戏目录');
    await assertServerStopped(root);
    for (const relative of files) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(base, 'payload', relative), target, constants.COPYFILE_EXCL);
      installed.push(relative);
    }
    await copyFile(patched, path.join(root, 'bedrock_server_mod.exe'), constants.COPYFILE_EXCL);
    installed.push('bedrock_server_mod.exe');
    await writeJson(stateFile, { gameRoot: root, runtime: '1.26.61.1', installedAt: new Date().toISOString(), installedFiles: installed });
    console.log('安装完成。世界、白名单、权限和 server.properties 均未修改。');
    console.log('下一步：运行 02-configure.cmd，保存平台接入配置。');
  } catch (error) {
    // Only files created by this invocation are removed; never delete a user's directory.
    for (const relative of installed.reverse()) await rm(path.join(root, relative), { force: true });
    throw error;
  } finally {
    assert.ok(inside(configDir, stage) && path.basename(stage).startsWith('install-stage-'));
    await rm(stage, { recursive: true, force: true });
  }
}
async function configure() {
  const root = await boundGame();
  await assertServerStopped(root);
  const preset = await exists(connectionFile) ? await json(connectionFile) : null;
  const origin = (preset?.apiUrl ?? ((await ask(`平台 HTTPS 地址（回车使用 ${defaultOrigin}）：`)) || defaultOrigin)).replace(/\/+$/, '');
  const platformUrl = new URL(origin);
  assert.ok(platformUrl.origin === origin && !platformUrl.username && !platformUrl.password
    && (platformUrl.protocol === 'https:' || platformUrl.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(platformUrl.hostname)), '请输入 HTTPS 源地址，不包含路径、用户名或密码');
  const serverId = (preset?.serverId ?? await ask('网页服务器档案的 UUID：')).toLowerCase();
  assert.match(serverId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/, '服务器 UUID 格式不正确');
  const token = preset?.collectorCredential?.token ?? await ask('该服的采集凭据（不是管理员密码）：');
  assert.ok(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token), '采集凭据格式不正确');
  assert.equal(token.slice(0, 36), serverId, '采集凭据不属于这个服务器档案');
  const hostToken = preset?.hostCredential?.token ?? await ask('该服的执行端凭据（mcmhost. 开头）：');
  assert.ok(/^mcmhost\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(hostToken), '执行端凭据格式不正确');
  const defaultOutput = path.join(path.dirname(root), 'MCManagerBackups', serverId);
  const outputDirectory = path.resolve(preset ? defaultOutput : (await ask(`备份保存目录（回车使用 ${defaultOutput}）：`)) || defaultOutput);
  assert.ok(!inside(root, outputDirectory), '备份目录必须在游戏目录之外');
  await mkdir(outputDirectory, { recursive: true });
  const outputReal = await realpath(outputDirectory);
  assert.ok(!inside(root, outputReal), '备份目录不能通过链接指向游戏目录内部');
  const file = path.join(root, 'plugins/archive-collector/config/config.json');
  const previous = await json(file);
  assert.ok(!previous.enabled || previous.serverId === serverId, '已有采集配置绑定其他档案，拒绝覆盖');
  const health = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(15000), redirect: 'error' });
  assert.ok(health.ok, '无法连接平台，请检查网络和系统时间');
  const mapConfig = path.join(root, 'plugins/mipmap/config.toml');
  const mapInstalled = await exists(mapConfig);
  const mapUploadKey = preset?.mapUploadKey ?? (mapInstalled ? await ask('地图上传密钥（64 位；由平台管理员提供，留空暂不接入地图）：') : '');
  if (mapUploadKey) {
    assert.ok(mapInstalled, '地图组件尚未安装');
    assert.match(mapUploadKey, /^[a-f0-9]{64}$/);
    let content = await readFile(mapConfig, 'utf8');
    for (const name of ['chunks', 'players']) {
      const pattern = new RegExp('^' + name + '\\s*=.*$', 'm');
      assert.ok(pattern.test(content), '地图配置缺少上传地址');
      content = content.replace(pattern, `${name} = "${origin}/upload/${mapUploadKey}/${name}"`);
    }
    await writeFile(mapConfig, content, { mode: 0o600 });
    console.log('地图地址：' + origin + '/maps/' + serverId + '/');
  } else if (mapInstalled) console.log('未输入地图密钥，保留现有地图配置；首次安装需补充密钥后才能上传地图。');
  await writeJson(file, { enabled: true, serverId, token, endpoint: origin + '/api/ingest/v1/batches', activityIdleSeconds: 300 });
  await writeJson(path.join(configDir, 'host.json'), { apiUrl: origin, root, outputDirectory: outputReal, serverId, token: hostToken, backupScope: 'WORLD' });
  await readHostConfig(path.join(configDir, 'host.json'));
  console.log('接入配置已保存。运行 03-start.cmd 后，网页就能查看日志和控制服务器。');
  console.log('凭据仅写入本机配置文件，请勿分享配置完成后的整个安装目录。');
}
async function addMapToExisting() {
  const hashes = await verify();
  assert.ok(!await exists(stateFile), '这个安装包已经绑定过游戏目录');
  const flag = process.argv.indexOf('--game');
  const root = await realpath(flag >= 0 ? process.argv[flag + 1] : await ask('请输入已安装上一版 MCManager 接入包的游戏目录：'));
  const packageRoot = await realpath(base);
  assert.ok(!inside(root, packageRoot) && !inside(packageRoot, root), '安装包和游戏目录不能互相包含');
  await assertServerStopped(root);
  const identity = await json(path.join(base, 'payload/plugins/AAA-archive-runtime-compat/identity.json'));
  for (const [name, hash] of [
    ['bedrock_server.exe', identity.officialExecutableSHA256], ['bedrock_server_mod.exe', identity.loadedExecutableSHA256],
    ['PreLoader.dll', identity.preLoaderSHA256], ['plugins/LeviLamina/LeviLamina.dll', identity.leviLaminaSHA256],
    ...['plugins/AAA-archive-runtime-compat/archive-runtime-compat.dll', 'plugins/archive-collector/archive-collector.dll'].map(name => [name, hashes['payload/' + name]]),
  ]) assert.equal(await sha(path.join(root, name)), hash, `已有接入包版本不匹配：${name}`);
  for (const name of ['plugins/EndstoneRuntime', 'plugins/mipmap']) assert.ok(!await exists(path.join(root, name)), `地图目录已存在，拒绝覆盖：${name}`);
  const files = Object.keys(hashes).filter(name => /^payload\/plugins\/(EndstoneRuntime\/|mipmap\/|endstone_mipmap-.*\.whl$)/.test(name)).map(name => name.slice(8));
  assert.ok(files.length > 2, '此安装包没有地图组件');
  for (const name of files) assert.ok(!await exists(path.join(root, name)), `文件已存在：${name}`);
  const llFile = path.join(root, 'plugins/LeviLamina/config/Config.json');
  const oldConfig = await readFile(llFile, 'utf8');
  const llConfig = await json(path.join(base, 'payload/plugins/LeviLamina/config/Config.json'));
  const previous = JSON.parse(oldConfig);
  function merge(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') merge(target[key], value);
      else target[key] = value;
    }
  }
  merge(llConfig, previous);
  llConfig.targeted.forceEnableCheatCommands = false;
  llConfig.targeted.enableStatistics = false;
  llConfig.modules.crashLogger.uploadToSentry = false;
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'LeviLamina.before-map.json'), oldConfig, { flag: 'wx' });
  const installed = [];
  try {
    for (const name of files) {
      const dst = path.join(root, name); await mkdir(path.dirname(dst), { recursive: true });
      await copyFile(path.join(base, 'payload', name), dst, constants.COPYFILE_EXCL); installed.push(name);
    }
    await writeJson(llFile, llConfig);
    await writeJson(stateFile, { gameRoot: root, runtime: '1.26.61.1', installedAt: new Date().toISOString(), installedFiles: installed });
    console.log('地图组件已添加，原框架配置备份在 config/LeviLamina.before-map.json。下一步运行 02-configure.cmd。');
  } catch (error) {
    for (const name of installed.reverse()) await rm(path.join(root, name), { force: true });
    await writeFile(llFile, oldConfig); throw error;
  }
}
async function runtimeEnvironment(root) {
  const env = { ...process.env };
  const python = path.join(base, 'runtime/python');
  if (await exists(path.join(python, 'python.exe'))) {
    // A portable base interpreter is required: a venv redirector cannot start
    // MipMap's child processes reliably from the embedded interpreter.
    return withMapPython(env, python, path.join(root, 'plugins/EndstoneRuntime'));
  }
  return env;
}
async function runChild(command, args, root) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: await runtimeEnvironment(root) });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => { process.exitCode = code ?? 1; resolve(); }); });
}
try {
  assert.equal(process.platform, 'win32', '本安装包仅支持 Windows');
  assert.equal(process.arch, 'x64', '需要 Windows x64');
  switch (process.argv[2]) {
    case 'verify': await verify(); console.log('安装包完整性检查通过。'); break;
    case 'install': await install(); break;
    case 'install-map': await addMapToExisting(); break;
    case 'configure': await configure(); break;
    case 'prestart': await boundGame(); await readHostConfig(path.join(configDir, 'host.json')); break;
    case 'start': {
      const root = await boundGame(); await readHostConfig(path.join(configDir, 'host.json'));
      await runChild(process.execPath, [path.join(base, 'host/src/console-host.mjs'), '--config', path.join(configDir, 'host.json'), '--start'], root);
      break;
    }
    case 'local': {
      const root = await boundGame(); await assertServerStopped(root);
      await runChild(path.join(root, 'bedrock_server_mod.exe'), [], root);
      break;
    }
    default: throw new Error('请使用安装包中的 01-install.cmd / 02-configure.cmd / 03-start.cmd');
  }
} catch (error) {
  console.error('未完成：' + error.message);
  process.exitCode = 1;
} finally { input?.close(); }
