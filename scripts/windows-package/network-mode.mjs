import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assertServerStopped } from './host/src/processes.mjs';
import { acquireHostLock } from './host/src/host-config.mjs';
import { hostErrorMessage } from './host/src/host-errors.mjs';

const base=path.dirname(fileURLToPath(import.meta.url));
const stateFile=path.join(base,'config/network-adjustment.json');
let lock;
try {
  const mode=process.argv[2];assert.ok(['disable','restore'].includes(mode),'Use disable or restore');
  const installation=JSON.parse(await readFile(path.join(base,'config/installation.json'),'utf8'));
  const root=await realpath(installation.gameRoot);
  const identity=JSON.parse(await readFile(path.join(base,'payload/plugins/AAA-archive-runtime-compat/identity.json'),'utf8'));
  const dll=await readFile(path.join(root,'plugins/LeviLamina/LeviLamina.dll'));
  assert.equal(createHash('sha256').update(dll).digest('hex'),identity.leviLaminaSHA256,'框架版本不匹配，未修改配置');
  lock=await acquireHostLock(root);await assertServerStopped(root);
  const file=path.join(root,'plugins/LeviLamina/config/Config.json');
  const before=await readFile(file,'utf8'),config=JSON.parse(before);
  assert.equal(typeof config.targeted?.netherNetPatch?.enable,'boolean','框架配置缺少联网调整开关，未修改');
  let state;
  try {state=JSON.parse(await readFile(stateFile,'utf8'));} catch(error) {if(error.code!=='ENOENT')throw error;}
  if(mode==='disable') {
    if(!config.targeted.netherNetPatch.enable) console.log('框架额外联网调整已经关闭，无需重复修改。');
    else {
      assert.ok(!state || state.restored,'已有未还原的调整记录，请先运行 09-restore-network.cmd');
      await mkdir(path.join(base,'config'),{recursive:true});
      const backup='LeviLamina-before-network-'+Date.now()+'.json';
      await writeFile(path.join(base,'config',backup),before,{flag:'wx'});
      await writeFile(stateFile,JSON.stringify({gameRoot:root,previousEnable:true,backup,restored:false},null,2));
      config.targeted.netherNetPatch.enable=false;
      await writeFile(file,JSON.stringify(config,null,2)+'\n');
      console.log('已关闭 LeviLamina 额外添加 STUN 的联网调整。原配置已备份到 config/'+backup+'。');
    }
    console.log('现在运行 03-start.cmd，再用同一个客户端加入。游戏端口、在线验证、地图和采集配置均未改动。');
  } else {
    assert.ok(state && state.gameRoot===root && typeof state.previousEnable==='boolean','没有匹配此游戏目录的还原记录');
    config.targeted.netherNetPatch.enable=state.previousEnable;
    await writeFile(file,JSON.stringify(config,null,2)+'\n');
    await writeFile(stateFile,JSON.stringify({...state,restored:true},null,2));
    console.log('已还原联网调整开关，其他配置保持现状。');
  }
} catch(error) {
  console.error('未修改或未完成：'+(error.code==='ERR_ASSERTION'?error.message:hostErrorMessage(error)));
  process.exitCode=1;
} finally {await lock?.close();}
