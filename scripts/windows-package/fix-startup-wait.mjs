// Distributed next to 03-start.cmd, using the package's existing portable Node.
import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const base=path.dirname(fileURLToPath(import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
let lock;
try{
 await readFile(path.join(base,'03-start.cmd'));
 const {assertServerStopped}=await import(pathToFileURL(path.join(base,'host/src/processes.mjs')));
 const {acquireHostLock}=await import(pathToFileURL(path.join(base,'host/src/host-config.mjs')));
 const config=JSON.parse(await readFile(path.join(base,'config/host.json'),'utf8'));
 assert.equal(typeof config.root,'string','找不到游戏目录配置');
 lock=await acquireHostLock(config.root);await assertServerStopped(config.root);
 const patch=JSON.parse(await readFile(path.join(base,'startup-fix/patch.json'),'utf8'));
 const target=path.join(base,'host/src/managed-game.mjs');
 const old=await readFile(target),next=await readFile(path.join(base,'startup-fix/managed-game.mjs'));
 assert.equal(hash(next),patch.after,'补丁文件校验失败');
 assert.ok([patch.before,patch.after].includes(hash(old)),'执行端程序与补丁版本不匹配，未覆盖');
 const manifestPath=path.join(base,'SHA256.json'),manifestBytes=await readFile(manifestPath),manifest=JSON.parse(manifestBytes.toString('utf8'));
 assert.ok(manifest&&typeof manifest==='object'&&!Array.isArray(manifest)&&Object.values(manifest).every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/i.test(v)),'原校验清单格式无法识别，未修改');
 // Prior repair packages may have replaced this known program without refreshing
 // the original manifest. Trust the verified program bytes above, not that stale
 // entry. Never recompute or bless any unrelated file's checksum.
 const keys=Object.keys(manifest).filter(k=>k.replaceAll('\\','/').replace(/^\.\//,'')==='host/src/managed-game.mjs');
 if(!keys.length)keys.push('host/src/managed-game.mjs');
 if(hash(old)!==patch.after||keys.some(k=>manifest[k]!==patch.after)){
  const backup=await mkdtemp(path.join(base,'startup-fix-backup-'));
  await writeFile(path.join(backup,'managed-game.mjs'),old,{flag:'wx'});
  await writeFile(path.join(backup,'SHA256.json'),manifestBytes,{flag:'wx'});
  if(hash(old)!==patch.after)await copyFile(path.join(base,'startup-fix/managed-game.mjs'),target);
  for(const key of keys)manifest[key]=patch.after;
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
 }
 console.log('启动等待修复已安装。配置、游戏世界和插件未修改。请运行原来的 03-start.cmd。');
}catch(e){
 console.error('补丁未完成：请确认已解压到原接入包目录，并关闭执行端、正常停止游戏。');
 if(e.code==='EADDRINUSE')console.error('执行端仍占用控制通道。');
 else if(e.code==='ENOENT')console.error('没有找到原接入包文件或配置。');
 else if(e.code==='ERR_ASSERTION')console.error(e.message);
 process.exitCode=1;
}finally{await lock?.close();}
