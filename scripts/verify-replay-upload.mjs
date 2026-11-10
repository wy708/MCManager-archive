// Native WinHTTP + durable outbox -> real PostgreSQL backend, with controlled faults.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,unlinkSync,existsSync,copyFileSync,renameSync} from 'node:fs';
import path from 'node:path';
const root=process.cwd(),out=path.resolve(process.argv[2]??'');assert.ok(process.argv[2]&&!existsSync(out),'Fresh output directory required');mkdirSync(out,{recursive:true});
const binary=path.join(root,'collector/build/1.26.61.1/windows/x64/release/verify-collector-core.exe');
const password=randomBytes(24).toString('hex'),db='mcm-replay-'+randomUUID().slice(0,8),cookies=new Map();let backend,base,csrf,proxy,game,restore;let backendLog='';
let mode='normal',latency=0,requests=0,sockets=new Set(),fault=false,bulkAccepted=0;
const results=[];
async function until(fn,ms=60000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await delay(150)}throw Error('Timed out')}
async function request(p,options={}){const r=await fetch(base+p,{...options,headers:{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const [k,...v]=c.split(';')[0].split('=');cookies.set(k,v.join('='))}return r}
async function admin(p,body){const r=await request(p,{method:'POST',headers:{[csrf.headerName]:csrf.token,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,p+' '+r.status);return r.json()}
async function native(phase,fixture){const file=path.join(out,randomUUID()+'.private.json');writeFileSync(file,JSON.stringify(fixture));try{const child=spawn(binary,[phase,file],{windowsHide:true});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const [code]=await once(child,'exit');assert.equal(code,0,stderr);return JSON.parse(stdout.trim())}finally{unlinkSync(file)}}
const sql=q=>execFileSync('docker',['exec',db,'psql','-U','postgres','-Atc',q],{encoding:'utf8'}).trim();
function bodies(count){const at=new Date(Date.now()-10000).toISOString(),bootId=randomUUID();return Array.from({length:count},(_,i)=>JSON.stringify({protocolVersion:1,batchId:randomUUID(),reportedAt:at,collector:{version:'legacy-fixture',bdsVersion:'1.26.61.1',leviLaminaVersion:'26.60.2',bootId,pendingEvents:count-i},capabilities:[{metric:'blocks.placed',state:'ACTIVE',quality:'EXACT',algorithmVersion:'native-placement-v2',dimensionAware:true}],events:[{eventId:randomUUID(),kind:'COUNTER',at,player:{identityType:'XUID',identity:'123456789',name:'补传测试'},metric:'blocks.placed',value:1,subject:'minecraft:stone',dimension:'minecraft:overworld',position:{x:i,y:64,z:0}}]},null,i%2?0:2))}
async function fixture(name,count){const s=await admin('/api/servers',{name,description:'Isolated replay QA',startDate:'2020-01-01'}),c=await admin(`/api/servers/${s.id}/collector-credential`,{});return {serverId:s.id,token:c.token,endpoint:`http://127.0.0.1:${proxy.address().port}/api/ingest/v1/batches`,outbox:path.join(out,name),bodies:bodies(count)}}
function count(f){return Number(sql(`select coalesce(sum(statistic_value),0) from daily_statistics where server_id='${f.serverId}' and metric='blocks.placed'`))}
async function stopGame(){if(game?.exitCode===null){game.stdin.write('stop\n');await Promise.race([once(game,'exit'),delay(20000)]);if(game.exitCode===null){game.kill();await once(game,'exit')}}}
try {
 execFileSync('docker',['run','--rm','-d','--name',db,'-e','POSTGRES_PASSWORD','-p','127.0.0.1::5432','postgres:17-alpine'],{env:{...process.env,POSTGRES_PASSWORD:password},stdio:'pipe'});
 const port=execFileSync('docker',['port',db,'5432/tcp'],{encoding:'utf8'}).trim().split(':').pop();await until(()=>{try{execFileSync('docker',['exec',db,'pg_isready','-U','postgres'],{stdio:'pipe'});return true}catch{return false}});
 backend=spawn('C:/Program Files/Java/jdk-21/bin/java.exe',['-jar',path.join(root,'backend/target/mcmanager-archive-0.1.0.jar')],{cwd:out,windowsHide:true,env:{...process.env,MCM_PORT:'0',MCM_BIND_ADDRESS:'127.0.0.1',MCM_ADMIN_USERNAME:'admin',MCM_ADMIN_PASSWORD:password,MCM_COOKIE_SECURE:'false',MCM_DB_URL:`jdbc:postgresql://127.0.0.1:${port}/postgres`,MCM_DB_USER:'postgres',MCM_DB_PASSWORD:password}});
 for(const s of [backend.stdout,backend.stderr])s.on('data',x=>{backendLog+=x;writeFileSync(path.join(out,'backend.log'),backendLog)});
 await until(()=>{const m=backendLog.match(/Tomcat started on port (\d+)/);if(m)base='http://127.0.0.1:'+m[1];return base});
 csrf=await(await request('/api/auth/csrf')).json();assert.equal((await request('/api/auth/login',{method:'POST',headers:{[csrf.headerName]:csrf.token},body:new URLSearchParams({username:'admin',password})})).status,204);csrf=await(await request('/api/auth/csrf')).json();
 proxy=createServer(async(req,res)=>{try{requests++;sockets.add(req.socket);let body='';for await(const chunk of req)body+=chunk;await delay(latency);
  if(mode==='legacy'&&req.url.endsWith('/bulk')){res.writeHead(404).end();return}
  if(mode==='failure'&&!fault&&req.url.endsWith('/bulk')){fault=true;res.writeHead(502).end();return}
  const r=await fetch(base+req.url,{method:'POST',headers:{authorization:req.headers.authorization,'content-type':'application/json'},body});let text=await r.text();
  if(req.url.endsWith('/bulk')&&r.ok){bulkAccepted+=JSON.parse(text).reduce((n,r)=>n+r.acceptedEvents,0);if(mode==='lost'&&!fault){fault=true;req.socket.destroy();return}if(mode==='missing')text=JSON.stringify(JSON.parse(text).slice(1));if(mode==='reorder')text=JSON.stringify(JSON.parse(text).reverse());if(mode==='counts'){const a=JSON.parse(text);a[0].acceptedEvents+=1;text=JSON.stringify(a)}}
  res.writeHead(r.status,{'Content-Type':'application/json'}).end(text);
 }catch(e){res.writeHead(500).end()}});await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 for(const single of [true,false]){const f=await fixture(single?'single':'bulk',128);mode='normal';latency=80;requests=0;sockets.clear();const result=await native('--http-drain',{...f,single});assert.equal(count(f),128);assert.equal(result.pending,0);assert.equal(sockets.size,1,'Ingest connection not reused');results.push({name:single?'single':'bulk',...result,connections:sockets.size,addedLatencyMillis:latency});console.log(JSON.stringify(results.at(-1)))}
 latency=0;
 for(const corruption of ['missing','reorder','counts','lost']){const f=await fixture(corruption,16);mode=corruption;fault=false;await native('--http-bulk-reject',f);assert.equal(count(f),16);mode='normal';const result=await native('--http-drain',{...f,replay:true});assert.equal(count(f),16);results.push({name:corruption,restartReplayRetainedOriginals:true,...result});console.log(corruption+' response recovery passed')}
 for(const compatibility of ['legacy','failure']){const f=await fixture(compatibility,40);mode=compatibility;fault=false;await native('--http-engine-drain',f);assert.equal(count(f),40);results.push({name:compatibility,engineFallback:true});console.log(compatibility+' engine fallback passed')}
 mode='normal';
 if(process.env.MCM_CONTAINER_QA_ROOT){
  const qa=path.resolve(process.env.MCM_CONTAINER_QA_ROOT);assert.equal(readFileSync(path.join(qa,'owner.txt'),'utf8').trim(),'MCManager-container-audit-isolated-qa');const gameRoot=path.join(qa,'game');assert.match(readFileSync(path.join(gameRoot,'server.properties'),'utf8'),/^online-mode=false$/m);
  const plugin=path.join(gameRoot,'plugins/archive-collector'),config=path.join(plugin,'config/config.json'),saved=path.join(out,'prior-plugin');mkdirSync(saved);const original=readFileSync(config);for(const name of ['archive-collector.dll','manifest.json'])copyFileSync(path.join(plugin,name),path.join(saved,name));
  const data=path.join(plugin,'data'),old=path.join(out,'prior-data');if(existsSync(data))renameSync(data,old);
  restore=()=>{writeFileSync(config,original);for(const name of ['archive-collector.dll','manifest.json'])copyFileSync(path.join(saved,name),path.join(plugin,name));if(existsSync(data))renameSync(data,path.join(out,'real-game-data'));if(existsSync(old))renameSync(old,data)};
  const backlog=Number(process.env.MCM_REPLAY_QA_BACKLOG??512);assert.ok(Number.isInteger(backlog)&&backlog>=512&&backlog<=30000);const f=await fixture('real-game',backlog);const spool=path.join(data,'outbox');mkdirSync(path.join(spool,'acknowledged'),{recursive:true});writeFileSync(path.join(spool,'server-id'),f.serverId);
  f.bodies.forEach((body,i)=>writeFileSync(path.join(spool,String(i+1).padStart(20,'0')+'_'+JSON.parse(body).batchId+'.pending'),JSON.stringify({schema:1,body,sha256:createHash('sha256').update(body).digest('hex')})));
  for(const name of ['archive-collector.dll','manifest.json'])copyFileSync(path.join(root,'collector/bin/1.26.61.1/archive-collector',name),path.join(plugin,name));
  writeFileSync(config,JSON.stringify({enabled:true,serverId:f.serverId,token:f.token,endpoint:f.endpoint,activityIdleSeconds:300}));
  let gameLog='';requests=0;bulkAccepted=0;console.log('Starting real BDS with '+backlog+' old-format pending files');const begin=Date.now();game=spawn(path.join(gameRoot,'bedrock_server_mod.exe'),[],{cwd:gameRoot,windowsHide:true,detached:true,stdio:['pipe','pipe','pipe']});for(const s of [game.stdout,game.stderr])s.on('data',x=>{gameLog+=x;writeFileSync(path.join(out,'game.log'),gameLog)});
  await until(()=>gameLog.includes('Native dimension completion subscription established'),120000);assert.doesNotMatch(gameLog,/Couldn't find:|Collector could not start|Unsupported runtime/);
  await until(()=>count(f)===backlog,600000);assert.equal(bulkAccepted,backlog);const runtime=await until(async()=>{const r=await(await request(`/api/servers/${f.serverId}/runtime`)).json();return r.latest?.cpuPercent!=null&&r.latest?.tps>18?r:null});
  results.push({name:'real-bds-1.26.61.1',legacyBatches:backlog,bulkAccepted,requests,elapsedIncludingStartupMillis:Date.now()-begin,tps:runtime.latest.tps});console.log('Real BDS legacy spool drained and live runtime healthy');await stopGame();
 }
 writeFileSync(path.join(out,'evidence.json'),JSON.stringify({at:new Date().toISOString(),database:'PostgreSQL 17',results},null,2));
} finally {await stopGame();restore?.();proxy?.closeAllConnections();proxy?.close();if(backend?.exitCode===null){backend.kill();await once(backend,'exit')}try{execFileSync('docker',['stop',db],{stdio:'pipe'})}catch{}}
