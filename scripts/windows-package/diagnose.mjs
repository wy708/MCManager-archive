import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readHostConfig, acquireHostLock } from './host/src/host-config.mjs';
import { assertServerStopped } from './host/src/processes.mjs';
import { hostErrorMessage } from './host/src/host-errors.mjs';
import { withMapPython } from './host/src/runtime-environment.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const lines = ['MCManager 启动检查 ' + new Date().toISOString(), '不会启动或停止游戏，不会上传世界或显示凭据。'];
const note = text => { lines.push(text); console.log(text); };
let config;
async function check(label, action) {
  try { await action(); note('[通过] ' + label); return true; }
  catch (error) { note('[未通过] ' + label + '：' + hostErrorMessage(error, label)); return false; }
}
try {
  const okay = await check('读取执行端配置', async () => { config = await readHostConfig(path.join(base,'config/host.json')); });
  if (okay) {
    note('游戏目录：' + config.root); note('备份目录：' + config.outputDirectory);
    await check('获取执行端控制通道', async () => { const lock = await acquireHostLock(config.root); await lock.close(); });
    await check('检查游戏进程', () => assertServerStopped(config.root));
    await check('地图启动环境中的 PowerShell', async () => {
      const env = withMapPython(process.env,path.join(base,'runtime/python'),path.join(config.root,'plugins/EndstoneRuntime'));
      await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()'],{env,windowsHide:true,timeout:15000,maxBuffer:4096});
    });
    await check('连接平台 HTTPS', async () => {
      const response = await fetch(config.apiUrl+'/api/health',{redirect:'error',signal:AbortSignal.timeout(15000)});
      if (!response.ok) throw Object.assign(new Error(),{status:response.status});
    });
    // Only report selected non-secret settings, never entire config files.
    const properties = await readFile(path.join(config.root,'server.properties'),'utf8');
    for (const name of ['online-mode','transport','server-port']) {
      const match = properties.match(new RegExp('^'+name+'=([^\\r\\n]*)','m'));
      if (match) note(name+'='+match[1]);
    }
  }
  await check('Windows PowerShell', async () => {
    const { stdout } = await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command','$PSVersionTable.PSVersion.ToString()'],{windowsHide:true,timeout:15000,maxBuffer:4096});
    const version=stdout.trim(); if (/^[\d.]+$/.test(version)) note('PowerShell '+version); else throw new Error();
  });
  note('凭据只检查了格式与本地档案绑定；HTTPS 检查不代表凭据已获平台接受。');
} catch (error) { note('[未通过] '+hostErrorMessage(error)); process.exitCode=1; }
const report=path.join(base,'启动检查-'+Date.now()+'.txt');
await writeFile(report,lines.join('\r\n')+'\r\n','utf8');
console.log('检查报告已保存：'+report);
