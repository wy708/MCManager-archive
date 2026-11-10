import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ManagedGame} from '../src/managed-game.mjs';

test('bootstrap tolerates queued startup beyond five seconds without sending stop or duplicate commands',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'mcm-startup-'));
 const root=await realpath(directory),commands=[],bootId=randomUUID();
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new EventEmitter();child.stdin.writable=true;
 let responseTimer;
 child.stdin.write=(line,callback)=>{
  commands.push(line.trim());callback?.();
  if(line==='stop\n'){queueMicrotask(()=>child.emit('exit',0));return true;}
  const [verb,action,operationId,requestId]=line.trim().split(' ');
  assert.equal(verb,'archivebackup');assert.equal(action,'status');
  responseTimer=setTimeout(()=>child.stdout.write('MCM_ARCHIVE_BACKUP '+JSON.stringify({protocol:1,operationId,requestId,bootId,root,supervisorGuard:false})+'\n'),5500);
  return true;
 };
 t.mock.method(childProcess,'spawn',()=>child);syncBuiltinESMExports();
 let game;
 try{
  game=new ManagedGame(root,()=>{},false);
  const hello=await game.request('status',randomUUID(),0,'bootstrap');
  assert.equal(hello.bootId,bootId);assert.equal(commands.length,1);assert.ok(!commands.includes('stop'));
  await game.stop();assert.equal(commands.at(-1),'stop');
 }finally{clearTimeout(responseTimer);t.mock.restoreAll();syncBuiltinESMExports();await rm(directory,{recursive:true,force:true});}
});
