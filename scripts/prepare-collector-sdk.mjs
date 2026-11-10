// Builds an import SDK from exact official headers and the verified release DLL.
// Does not copy, patch or launch an existing game installation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'The pinned collector target is Windows x64');
const root = fileURLToPath(new URL('../', import.meta.url));
const tools = path.join(root, '.tools'); mkdirSync(tools, { recursive: true });
const profiles = {
  '1.26.51.1': { loader: '26.51.8', sourceCommit: 'e122f2426fe5d5fb2dd13f3a4d9991cab9f56ef4', repoCommit: 'a09489eb8f6e6d0d6e59a494550b2c808af91e10', runtimeHash: 'd3bd6acea0566e92eb4789d0d863c41aee42b4d7dbbf459db2ef93f794aaf55f', repository: 'levimc-xmake-repo' },
  '1.26.61.1': { loader: '26.60.2', sourceCommit: 'ec76722309ef163d213f3ed4cf8a269e150028ef', repoCommit: '192f00805cb7160e4cd83ac90c58b22e0bb99d8f', runtimeHash: '3403cd29f46b916ce0d8c9c26c9cb65c913cf8388e878bfe0bff2c16f6771d06', repository: 'levimc-xmake-repo-26.60.2' },
};
assert.ok(process.argv.slice(2).every(value => /^--runtime=/.test(value)), 'Only --runtime=<exact BDS version> is accepted');
assert.ok(process.argv.length <= 3, 'Specify at most one runtime');
const gameVersion = process.argv[2]?.slice('--runtime='.length) ?? '1.26.51.1';
const profile = profiles[gameVersion]; assert.ok(profile, 'Unsupported collector runtime');
const { loader, sourceCommit, repoCommit, runtimeHash } = profile;
const runtimeUrl = `https://github.com/LiteLDev/LeviLamina/releases/download/v${loader}/levilamina-v${loader}-server-release-windows-x64.zip`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (exe, args, options = {}) => execFileSync(exe, args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
function checkout(name, url, commit, branch) {
  const directory = path.join(tools, name);
  if (!existsSync(path.join(directory, '.git'))) {
    console.log(`Fetching ${name}`);
    run('git', ['clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), url, directory]);
  }
  if (run('git', ['-C', directory, 'rev-parse', 'HEAD']).trim() !== commit) {
    assert.equal(run('git', ['-C', directory, 'status', '--porcelain']).trim(), '', `${name} has local changes`);
    run('git', ['-C', directory, 'fetch', '--depth', '1', 'origin', commit]); run('git', ['-C', directory, 'checkout', '--detach', commit]);
  }
  assert.equal(run('git', ['-C', directory, 'rev-parse', 'HEAD']).trim(), commit);
  assert.equal(run('git', ['-C', directory, 'status', '--porcelain', '--untracked-files=all']).trim(), '', `${name} must be an unmodified official source checkout`);
  return directory;
}
const source = checkout(`LeviLamina-${loader}`, 'https://github.com/LiteLDev/LeviLamina.git', sourceCommit, `v${loader}`);
checkout(profile.repository, 'https://github.com/LiteLDev/xmake-repo.git', repoCommit);
const archive = path.join(tools, `levilamina-${loader}-runtime.zip`);
if (!existsSync(archive)) {
  console.log(`Downloading official LeviLamina ${loader} server release`);
  const response = await fetch(runtimeUrl, { signal: AbortSignal.timeout(60_000) }); assert.ok(response.ok);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(sha(bytes), runtimeHash, 'Official runtime checksum mismatch'); writeFileSync(archive, bytes);
}
assert.equal(sha(readFileSync(archive)), runtimeHash, 'Official runtime checksum mismatch');
const llvmCandidates = [process.env.MCM_LLVM_BIN, ...((existsSync(path.join(os.homedir(), 'tools')) ? readdirSync(path.join(os.homedir(), 'tools')) : []).filter(name => name.startsWith('clang+llvm-22.')).map(name => path.join(os.homedir(), 'tools', name, 'bin')))];
let llvm = llvmCandidates.find(directory => directory && existsSync(path.join(directory, 'llvm-dlltool.exe')));
if (!llvm) { try { llvm = path.dirname(run('where.exe', ['llvm-dlltool.exe']).trim().split(/\r?\n/)[0]); } catch { throw new Error('Install LLVM 22 and set MCM_LLVM_BIN or add its bin directory to PATH'); } }
const compilerVersion = run(path.join(llvm, 'clang-cl.exe'), ['--version']).split(/\r?\n/)[0]; assert.match(compilerVersion, /version 22\./);
const sdk = path.join(tools, `collector-sdk-${loader}`); mkdirSync(sdk, { recursive: true });
const quote = value => "'" + value.replaceAll("'", "''") + "'";
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(path.join(sdk, 'runtime'))} -Force`]);
const dll = path.join(sdk, 'runtime/LeviLamina/LeviLamina.dll'); const binary = readFileSync(dll);
// PE32+ export names are enough for an import library; classify data by section flags.
// No function bodies are decompiled or modified.
const pe = binary.readUInt32LE(0x3c); assert.equal(binary.toString('binary', pe, pe + 4), 'PE\0\0'); assert.equal(binary.readUInt16LE(pe + 4), 0x8664);
const optional = pe + 24; assert.equal(binary.readUInt16LE(optional), 0x20b);
const sectionCount = binary.readUInt16LE(pe + 6), sectionStart = optional + binary.readUInt16LE(pe + 20);
const sections = Array.from({ length: sectionCount }, (_, index) => { const offset = sectionStart + index * 40; return { rva: binary.readUInt32LE(offset + 12), size: Math.max(binary.readUInt32LE(offset + 8), binary.readUInt32LE(offset + 16)), raw: binary.readUInt32LE(offset + 20), executable: (binary.readUInt32LE(offset + 36) & 0x20000000) !== 0 }; });
const section = rva => sections.find(item => rva >= item.rva && rva < item.rva + item.size);
const offset = rva => { const item = section(rva); assert.ok(item, `RVA outside PE sections: ${rva}`); const result = item.raw + rva - item.rva; assert.ok(result < binary.length); return result; };
const exportRva = binary.readUInt32LE(optional + 112), exportSize = binary.readUInt32LE(optional + 116), exportsAt = offset(exportRva);
const count = binary.readUInt32LE(exportsAt + 24), functions = offset(binary.readUInt32LE(exportsAt + 28)), names = offset(binary.readUInt32LE(exportsAt + 32)), ordinals = offset(binary.readUInt32LE(exportsAt + 36));
const exports = Array.from({ length: count }, (_, index) => {
  const start = offset(binary.readUInt32LE(names + index * 4)), end = binary.indexOf(0, start); assert.ok(end >= start);
  const name = binary.toString('ascii', start, end); assert.ok(name.length && !/[\s";]/.test(name), 'Unexpected export name');
  const rva = binary.readUInt32LE(functions + binary.readUInt16LE(ordinals + index * 2) * 4);
  assert.ok(rva < exportRva || rva >= exportRva + exportSize, 'Forwarded exports require an explicit definition');
  return name + (section(rva)?.executable ? '' : ' DATA');
});
assert.ok(exports.length > 100, 'Release DLL export table is incomplete');
mkdirSync(path.join(sdk, 'lib'), { recursive: true });
const definition = path.join(sdk, 'LeviLamina.def'); writeFileSync(definition, `LIBRARY LeviLamina.dll\nEXPORTS\n${exports.map(name => '  ' + name).join('\n')}\n`);
run(path.join(llvm, 'llvm-dlltool.exe'), ['-m', 'i386:x86-64', '-d', definition, '-l', path.join(sdk, 'lib/LeviLamina.lib')]);
// Install the same server overlay order as the official source target.
for (const directory of ['src', 'src-server']) for (const tree of ['ll/api', 'mc']) {
  const from = path.join(source, directory, tree); if (existsSync(from)) cpSync(from, path.join(sdk, 'include', tree), { recursive: true });
}
cpSync(path.join(source, 'COPYING'), path.join(sdk, 'COPYING')); cpSync(path.join(source, 'COPYING.LESSER'), path.join(sdk, 'COPYING.LESSER'));
const provenance = { sourceCommit, repoCommit, runtimeUrl, runtimeZipSha256: runtimeHash, runtimeDllSha256: sha(binary), importLibrarySha256: sha(readFileSync(path.join(sdk, 'lib/LeviLamina.lib'))), compilerVersion, llvmBin: llvm, exports: count, target: `BDS ${gameVersion} / LeviLamina ${loader} server Windows x64`, requiresRuntimeAdapter: gameVersion === '1.26.61.1', generatedAt: new Date().toISOString() };
writeFileSync(path.join(sdk, 'provenance.json'), JSON.stringify(provenance, null, 2)); console.log(JSON.stringify(provenance, null, 2));
