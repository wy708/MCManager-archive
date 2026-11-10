// Real isolated BDS -> MipMap wheel -> HTTP receiver -> original map renderer.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';import {createServer} from 'node:http';
import {readFileSync,writeFileSync,copyFileSync,readdirSync,unlinkSync,mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';import {fileURLToPath} from 'node:url';import {setTimeout as delay} from 'node:timers/promises';
const root=fileURLToPath(new URL('../',import.meta.url)),game=path.resolve(process.env.MCM_MAP_QA_GAME??''),python=path.resolve(process.env.MCM_MAP_QA_PYTHON??''),out=path.resolve(process.env.MCM_MAP_QA_OUTPUT??'');
assert.ok(process.env.MCM_MAP_QA_GAME&&process.env.MCM_MAP_QA_PYTHON&&process.env.MCM_MAP_QA_OUTPUT);
const props=readFileSync(path.join(game,'server.properties'),'utf8');assert.match(props,/^level-name=MapReleaseVerification$/m);assert.match(props,/^online-mode=false$/m);
mkdirSync(out,{recursive:true});const plugins=path.join(game,'plugins'),config=path.join(plugins,'mipmap/config.toml'),previousConfig=readFileSync(config),previousWheels=readdirSync(plugins).filter(n=>/^endstone_mipmap-.*\.whl$/.test(n)).map(n=>[n,readFileSync(path.join(plugins,n))]);
const wheel='endstone_mipmap-1.0.3+mcmanager.6-py2.py3-none-any.whl';let gameProcess,gameLog='';const columns=new Map(),requests=[];
const receiver=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);const body=JSON.parse(raw);if(body.chunk){requests.push(body);if(body.chunk.blocks.some(b=>b.coordinates[0]===0&&b.coordinates[2]===0))writeFileSync(path.join(out,'latest-chunk.json'),JSON.stringify(body.chunk));for(const b of body.chunk.blocks)columns.set(`${b.coordinates[0]},${b.coordinates[2]}`,b);}const response=await fetch('http://127.0.0.1:18764/api/chunks-data',{method:'POST',headers:{'Content-Type':'application/json'},body:raw});res.writeHead(response.status);res.end(await response.text());}catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(resolve=>receiver.listen(18763,'127.0.0.1',resolve));
async function until(fn,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;if(gameProcess?.exitCode!=null)throw Error('Game exited '+gameProcess.exitCode);await delay(250)}throw Error('Timed out')}
async function command(text){gameProcess.stdin.write(text+'\n');await delay(200)}
async function image(name){const r=await fetch('http://127.0.0.1:18764/api/tiles/Overworld/4/0/0');assert.equal(r.status,200);writeFileSync(path.join(out,name),Buffer.from(await r.arrayBuffer()));}
try{
 for(const [name] of previousWheels)unlinkSync(path.join(plugins,name));copyFileSync(path.join(root,'map/dist',wheel),path.join(plugins,wheel));
 writeFileSync(config,'sendPlayers = false\nsurfaceRefreshTicks = 10\nsurfaceBudgetMs = 1\n[api]\nchunks = "http://127.0.0.1:18763/chunks"\nplayers = "http://127.0.0.1:18763/players"\n[blacklist]\nblocks = ["minecraft:air"]\n');
 gameProcess=spawn(path.join(game,'bedrock_server_mod.exe'),[],{cwd:game,windowsHide:true,detached:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PATH:python+path.delimiter+process.env.PATH,PYTHONHOME:python,PYTHONPATH:path.join(plugins,'EndstoneRuntime'),PYTHONNOUSERSITE:'1',PIP_NO_INDEX:'1',ENDSTONE_PYTHON_EXECUTABLE:path.join(python,'python.exe')}});
 for(const s of [gameProcess.stdout,gameProcess.stderr])s.on('data',c=>{gameLog+=c;writeFileSync(path.join(out,'game.log'),gameLog)});
 await until(()=>gameLog.includes('Server started.'));assert.match(gameLog,/mipmap v1\.0\.3\+mcmanager\.5/);assert.doesNotMatch(gameLog,/Traceback|Couldn't find:/);
 await until(()=>gameLog.includes('Enabling mipmap'));await command('tickingarea remove MapLayersQA');await command('tickingarea add 0 300 0 15 319 15 MapLayersQA');await until(()=>columns.has('0,0'));await delay(1000);
 await command('fill 0 301 0 15 319 15 air');await command('fill 0 299 0 15 299 15 stone');await command('fill 0 300 0 15 300 15 grass_block');
 for(const [x,name,ground] of [[1,'torch','grass_block'],[3,'dandelion','grass_block'],[5,'glass','grass_block'],[7,'red_stained_glass','sand'],[9,'glass_pane','stone'],[13,'wheat','farmland']]){await command(`setblock ${x} 300 2 ${ground}`);await command(`setblock ${x} 301 2 ${name}`)}
 await command('setblock 11 304 2 glass');await command('setblock 11 305 2 red_stained_glass');await command('setblock 11 306 2 torch');
 await until(()=>[1,3,5,7,9,11,13].every(x=>columns.get(`${x},2`)?.layers?.some(b=>b.coordinates[1]===300)));
 const selected=[1,3,5,7,9,11,13].map(x=>columns.get(`${x},2`));
 assert.deepEqual(selected.map(b=>b.name),['torch','dandelion','glass','red_stained_glass','glass_pane','torch','wheat'].map(n=>'minecraft:'+n));
 assert.equal(selected[3].layers.at(-1).name,'minecraft:sand');assert.equal(selected[4].layers.at(-1).name,'minecraft:stone');assert.equal(selected[6].layers.at(-1).name,'minecraft:farmland');
 assert.deepEqual(selected[5].layers.map(b=>b.coordinates[1]),[305,304,300]);
 writeFileSync(path.join(out,'real-columns.json'),JSON.stringify(selected,null,2));await delay(2000);await image('before.png');
 await command('setblock 1 301 2 air');await command('setblock 7 301 2 air');
 await until(()=>columns.get('1,2')?.coordinates[1]===300&&columns.get('7,2')?.coordinates[1]===300);await delay(1500);await image('after.png');
 assert.doesNotMatch(gameLog,/Traceback|HTTP error/);
 writeFileSync(path.join(out,'evidence.json'),JSON.stringify({realBds:'1.26.61.1',plugin:'1.0.3+mcmanager.6',columns:7,uploads:requests.length,checks:['Actual lower grass, sand, stone and farmland','Glass and stained glass under a torch above an air gap','Removed overlays uploaded and rendered'],at:new Date().toISOString()},null,2));console.log('Real layered capture and removal PASS');
}finally{
 if(gameProcess?.exitCode===null){gameProcess.stdin.write('stop\n');await Promise.race([new Promise(r=>gameProcess.once('exit',r)),delay(20000)]);if(gameProcess.exitCode===null)gameProcess.kill();}
 if(existsSync(path.join(plugins,wheel)))unlinkSync(path.join(plugins,wheel));for(const [name,data] of previousWheels)writeFileSync(path.join(plugins,name),data);writeFileSync(config,previousConfig);receiver.closeAllConnections();receiver.close();
}
