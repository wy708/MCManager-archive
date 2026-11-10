import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { check } from './paths.mjs';

const execute = promisify(execFile);
export async function assertServerStopped(root) {
  const candidates = new Set(['bedrock_server.exe', 'bedrock_server_mod.exe', 'bedrock_server'].map(file => path.join(root, file).toLowerCase()));
  if (process.platform === 'win32') {
    const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "Name='bedrock_server.exe' OR Name='bedrock_server_mod.exe'" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`;
    const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 1048576 });
    const result = stdout.trim() ? JSON.parse(stdout) : [];
    for (const entry of Array.isArray(result) ? result : [result]) {
      check(entry.ExecutablePath, 'Cannot prove whether a BDS process belongs to this server');
      check(!candidates.has(path.resolve(entry.ExecutablePath).toLowerCase()), 'Server is running; a stopped-server snapshot requires a clean stop first');
    }
  } else if (process.platform === 'linux') {
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try { check(!candidates.has((await readlink(`/proc/${name}/exe`)).toLowerCase()), 'Server is running; stop it before a stopped-server snapshot'); }
      catch (error) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
    }
  } else throw new Error('Stopped-server process verification is supported on Windows and Linux');
}
export async function executableVersion(file) {
  if (process.platform !== 'win32') return null;
  const { stdout } = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Diagnostics.FileVersionInfo]::GetVersionInfo($env:MCM_VERSION_FILE).ProductVersion'],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536, env: { ...process.env, MCM_VERSION_FILE: file } });
  const value = stdout.trim(); return value && value.length <= 128 && !/[\x00-\x1f]/.test(value) ? value : null;
}
