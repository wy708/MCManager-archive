import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const qa = path.join(root, '.tools/game-qa-26.51.8');
const provenance = JSON.parse(readFileSync(path.join(qa, 'qa-provenance.json')));
assert.equal(provenance.owner, 'MCManager-archive-isolated-qa');
assert.equal(provenance.qaRoot, qa);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
assert.equal(sha(path.join(qa, 'bedrock_server_mod.exe')), provenance.gameExecutableSha256);
assert.equal(sha(path.join(qa, 'plugins/LeviLamina/LeviLamina.dll')), provenance.leviLaminaDllSha256);
const loaderOnly = process.argv.includes('--loader-only');
const plugin = path.join(qa, 'plugins/archive-collector'), disabled = path.join(qa, 'disabled-archive-collector');
if (loaderOnly) {
  assert.ok(plugin.startsWith(qa + path.sep) && disabled.startsWith(qa + path.sep) && !existsSync(disabled));
  renameSync(plugin, disabled);
}
const child = spawn(path.join(qa, 'bedrock_server_mod.exe'), [], { cwd: qa, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const logFile = path.join(qa, 'runtime-verification.log'); writeFileSync(logFile, '');
let output = '', exitCode;
const exited = new Promise((resolve, reject) => { child.once('exit', code => { exitCode = code; resolve(code); }); child.once('error', reject); });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; appendFileSync(logFile, chunk); });
async function until(condition, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (condition()) return; if (exitCode !== undefined) throw new Error(`Isolated BDS exited with code ${exitCode}`); if (/Quit correctly/.test(output)) throw new Error('Isolated BDS refused startup; inspect runtime-verification.log'); await delay(100); }
  throw new Error('Timed out waiting for isolated BDS runtime');
}
try {
  await until(() => /Server started\.?/i.test(output), 120_000);
  if (!loaderOnly) assert.match(output, /Archive collector 0\.[0-9]+\.[0-9]+ runtime linkage verified: BDS 1\.26\.51.*LeviLamina 26\.51\.8/);
  const endpoints = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[pscustomobject]@{tcp=@(Get-NetTCPConnection -OwningProcess ${child.pid} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort);udp=@(Get-NetUDPEndpoint -OwningProcess ${child.pid} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort)} | ConvertTo-Json -Depth 3 -Compress`], { windowsHide: true, encoding: 'utf8' }));
  writeFileSync(path.join(qa, 'network-endpoints.json'), JSON.stringify(endpoints, null, 2));
  assert.ok(endpoints.tcp.some(row => row.LocalAddress === '127.0.0.1' && row.LocalPort === 19152), 'QA NetherNet signaling must bind loopback');
  assert.ok(endpoints.tcp.every(row => ['127.0.0.1', '::1'].includes(row.LocalAddress)), 'Unexpected TCP listener on a non-loopback interface');
  child.stdin.write('version\nlist\n'); await delay(1000); child.stdin.write('stop\n');
  const code = await Promise.race([exited, delay(30_000, undefined, { ref: false }).then(() => { throw new Error('QA server did not stop cleanly'); })]);
  assert.equal(code, 0);
  const config = JSON.parse(readFileSync(path.join(qa, 'plugins/LeviLamina/config/Config.json')));
  assert.equal(config.modules.crashLogger.uploadToSentry, false); assert.equal(config.targeted.enableStatistics, false);
  assert.doesNotMatch(output, /\bERR \[/);
  const collectorConfig = !loaderOnly && existsSync(path.join(plugin, 'config/config.json')) ? JSON.parse(readFileSync(path.join(plugin, 'config/config.json'))) : {};
  const enabled = !loaderOnly && collectorConfig.enabled === true;
  const evidence = { verifiedAt: new Date().toISOString(), actualGameBoot: true, gameVersion: '1.26.51.1', leviLaminaVersion: '26.51.8', leviLaminaDllSha256: provenance.leviLaminaDllSha256, collectorDllSha256: sha(path.join(loaderOnly ? disabled : plugin, 'archive-collector.dll')), pluginLoaded: !loaderOnly, signalingLoopbackOnly: true, networkEndpoints: endpoints, cleanStop: true, playerGameplayTested: false, telemetryEnabled: enabled, repliesEnabled: enabled };
  writeFileSync(path.join(root, '.tools/game-runtime-evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (exitCode === undefined) { try { child.stdin.write('stop\n'); } catch {} await Promise.race([exited, delay(5000, undefined, { ref: false })]); if (exitCode === undefined) child.kill(); }
  writeFileSync(path.join(qa, 'runtime-verification.log'), output);
  if (loaderOnly && existsSync(disabled)) renameSync(disabled, plugin);
}
