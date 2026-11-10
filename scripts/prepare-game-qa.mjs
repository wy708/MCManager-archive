// Creates an isolated BDS world with loopback-only NetherNet signaling under this repository.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertServerStopped } from '../backup/src/processes.mjs';

assert.equal(process.platform, 'win32');
const root = fileURLToPath(new URL('../', import.meta.url)), tools = path.join(root, '.tools');
const qa = path.join(tools, 'game-qa-26.51.8'), marker = path.join(qa, 'qa-provenance.json');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (exe, args, options = {}) => execFileSync(exe, args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function expand(archive, destination) { mkdirSync(destination, { recursive: true }); run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`]); }
const plugin = path.join(root, 'collector/bin/archive-collector');
assert.ok(existsSync(path.join(plugin, 'archive-collector.dll')), 'Build the native collector first');
if (process.argv.includes('--update-plugin')) {
  assert.ok(existsSync(marker), 'No owned isolated game runtime exists');
  assert.equal(JSON.parse(readFileSync(marker)).owner, 'MCManager-archive-isolated-qa');
  await assertServerStopped(qa);
  for (const name of ['archive-collector.dll', 'archive-collector.pdb', 'manifest.json'])
    if (existsSync(path.join(plugin, name))) cpSync(path.join(plugin, name), path.join(qa, 'plugins/archive-collector', name));
  console.log(JSON.stringify({ updatedPlugin: true, qaRoot: qa }));
} else {
  assert.ok(!existsSync(qa), 'QA runtime already exists; use --update-plugin to update only its collector');
  const bdsZip = process.env.MCM_BDS_QA_ZIP ?? path.join(root, '../MCManager/bedrock-server-1.26.51.1.zip');
  assert.ok(existsSync(bdsZip), 'Set MCM_BDS_QA_ZIP to the original BDS 1.26.51.1 Windows ZIP');
  const sdk = path.join(tools, 'collector-sdk-26.51.8');
  const sdkEvidence = JSON.parse(readFileSync(path.join(sdk, 'provenance.json')));
  assert.equal(sdkEvidence.sourceCommit, 'e122f2426fe5d5fb2dd13f3a4d9991cab9f56ef4');
  assert.equal(sha(path.join(sdk, 'runtime/LeviLamina/LeviLamina.dll')), sdkEvidence.runtimeDllSha256);
  const assets = [
    ['preloader-1.16.5.zip', 'https://github.com/LiteLDev/PreLoader/releases/download/v1.16.5/preloader-v1.16.5-windows-x64.zip', '698667831e8336cf9d9accbfb25a84fb6755faea0d2ee9bb48f74d5a9f645967'],
    ['peeditor-3.9.2.zip', 'https://github.com/LiteLDev/PeEditor/releases/download/v3.9.2/peeditor-windows-x64.zip', 'cfeba1e9c40fc65a1310853d5cd3d5431d7bc3855c68e23b3d9c7a26f1fe42c2'],
    ['crashlogger-1.3.3.zip', 'https://github.com/LiteLDev/CrashLogger/releases/download/v1.3.3/CrashLogger-windows-x64.zip', 'ade3fc37affbc187020fd9ecb31883a70ab1f3f8238e447a43174343deb33156'],
    ['bedrockdata-26.51.1-server.11.zip', 'https://github.com/LiteLDev/bedrock-runtime-data/releases/download/v26.51.1-server.11/bedrock-runtime-data-v26.51.1-server.11-windows-x64.zip', '97802eac8dbeb2c355f695e1c773f8db7dc57ae2fee26493d9e34e3843127795'],
  ];
  for (const [name, url, checksum] of assets) {
    const archive = path.join(tools, name);
    if (!existsSync(archive)) {
      console.log(`Downloading ${name}`); const response = await fetch(url, { signal: AbortSignal.timeout(60_000) }); assert.ok(response.ok);
      const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum); writeFileSync(archive, bytes);
    }
    assert.equal(sha(archive), checksum, `${name} checksum mismatch`);
    expand(archive, path.join(tools, name + '.unpacked'));
  }
  const loc = path.join(tools, 'levilamina-loc-1.6.4');
  if (!existsSync(path.join(loc, '.git'))) run('git', ['clone', '--depth', '1', '--branch', 'v1.6.4', 'https://github.com/LiteLDev/levilamina-loc.git', loc]);
  assert.equal(run('git', ['-C', loc, 'rev-parse', 'HEAD']).trim(), '2de56d4ea33e08e5d2cb508086b4871fdda882b7');
  assert.equal(run('git', ['-C', loc, 'status', '--porcelain']).trim(), '');
  console.log('Extracting isolated BDS, then patching only that new executable');
  expand(bdsZip, qa);
  cpSync(path.join(tools, 'preloader-1.16.5.zip.unpacked/bin/PreLoader.dll'), path.join(qa, 'PreLoader.dll'));
  cpSync(path.join(tools, 'peeditor-3.9.2.zip.unpacked/PeEditor.exe'), path.join(qa, 'PeEditor.exe'));
  cpSync(path.join(tools, 'crashlogger-1.3.3.zip.unpacked/CrashLogger.exe'), path.join(qa, 'CrashLogger.exe'));
  cpSync(path.join(tools, 'bedrockdata-26.51.1-server.11.zip.unpacked/bedrock_runtime_data'), path.join(qa, 'bedrock_runtime_data'));
  cpSync(path.join(sdk, 'runtime/LeviLamina'), path.join(qa, 'plugins/LeviLamina'), { recursive: true });
  cpSync(path.join(tools, 'crashlogger-1.3.3.zip.unpacked/CrashLogger.exe'), path.join(qa, 'plugins/LeviLamina/CrashLogger.exe'));
  cpSync(path.join(loc, 'lang'), path.join(qa, 'plugins/LeviLamina/lang'), { recursive: true });
  cpSync(plugin, path.join(qa, 'plugins/archive-collector'), { recursive: true });
  mkdirSync(path.join(qa, 'plugins/LeviLamina/config'), { recursive: true });
  // Disable external crash uploads and loader statistics in this test world.
  cpSync(path.join(root, 'collector/qa/LeviLamina.Config.json'), path.join(qa, 'plugins/LeviLamina/config/Config.json'));
  writeFileSync(path.join(qa, 'PreLoaderConfig.json'), JSON.stringify({ version: 1, colorLog: false, logLevel: 4, logPath: './logs/', modsPath: './plugins/' }, null, 2));
  writeFileSync(path.join(qa, 'server.properties'), [
    'server-name=MCManager Archive isolated QA', 'level-name=Archive-QA', 'level-type=FLAT', 'level-seed=1', 'gamemode=creative', 'force-gamemode=true', 'difficulty=peaceful', 'allow-cheats=true',
    'online-mode=false', 'allow-list=false', 'server-port=19152', 'server-portv6=19153', 'server-ip=127.0.0.1', 'transport=nethernet', 'enable-lan-visibility=false', 'max-players=2', 'view-distance=5', 'tick-distance=4', 'emit-server-telemetry=false',
  ].join('\n') + '\n');
  writeFileSync(path.join(qa, 'allowlist.json'), JSON.stringify([{ name: 'ArchiveQA', ignoresPlayerLimit: true }], null, 2));
  writeFileSync(path.join(qa, 'permissions.json'), '[]\n');
  const patchOutput = run(path.join(qa, 'PeEditor.exe'), ['-mb'], { cwd: qa });
  assert.ok(existsSync(path.join(qa, 'bedrock_server_mod.exe')));
  const evidence = { owner: 'MCManager-archive-isolated-qa', qaRoot: qa, createdAt: new Date().toISOString(), bdsZipSha256: sha(bdsZip), gameExecutableSha256: sha(path.join(qa, 'bedrock_server_mod.exe')), leviLaminaVersion: '26.51.8', leviLaminaDllSha256: sdkEvidence.runtimeDllSha256, preloaderVersion: '1.16.5', bedrockRuntimeDataVersion: '26.51.1-server.11', signalingLoopbackOnly: true, transport: 'nethernet', crashUploadsEnabled: false, loaderStatisticsEnabled: false, assets: assets.map(([name, url, checksum]) => ({ name, url, sha256: checksum })), patchOutput };
  writeFileSync(marker, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ prepared: true, qaRoot: qa, gameExecutableSha256: evidence.gameExecutableSha256, signalingLoopbackOnly: true }));
}
