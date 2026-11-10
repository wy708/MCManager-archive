// Same original bytes against the previous and current backend, using isolated PostgreSQL.
import assert from 'node:assert/strict';import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';
import {randomUUID,randomBytes} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
const root=process.cwd(),[oldJar,templateFile,directory]=process.argv.slice(2);assert.ok(oldJar&&templateFile&&directory&&!existsSync(directory));mkdirSync(directory,{recursive:true});const out=path.resolve(directory);
const template=JSON.parse(JSON.parse(readFileSync(templateFile,'utf8')).body),password=randomBytes(24).toString('hex'),db='mcm-parity-'+randomUUID().slice(0,8),boot=randomUUID();let backend,base,log='',cookies,csrf;
const sql=q=>execFileSync('docker',['exec',db,'psql','-U','postgres','-Atc',q],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function until(fn){const end=Date.now()+60000;while(Date.now()<end){const r=await fn();if(r)return r;await delay(200)}throw Error('Backend did not start')}
async function req(p,options={}){const r=await fetch(base+p,{...options,headers:{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const [k,...v]=c.split(';')[0].split('=');cookies.set(k,v.join('='))}return r}
async function admin(p,body){const r=await req(p,{method:'POST',headers:{[csrf.headerName]:csrf.token,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok,await r.clone().text());return r.json()}
function batch(events,at){return JSON.stringify({protocolVersion:1,batchId:randomUUID(),reportedAt:at,collector:{version:'0.35.0',bdsVersion:'1.26.61.1',leviLaminaVersion:'26.60.2',bootId:boot,pendingEvents:0},capabilities:template.capabilities,events})}
const start=Date.now()-86400000,stamp=n=>new Date(start+n*1000).toISOString(),bodies=[];
const player=(i)=>({identityType:'XUID',identity:String(123456789+i%2),name:i%3?'玩家中文':'曾用名'});
for(let i=0;i<192;i++){
 const events=[];for(let j=0;j<1+i%6;j++){
  const event={eventId:randomUUID(),kind:'COUNTER',at:stamp(i),player:player(i),metric:j%2?'blocks.mined':'blocks.placed',value:1,subject:j%2?'minecraft:stone':'minecraft:oak_log',dimension:'minecraft:overworld',position:{x:i,y:64+j,z:-i}};events.push(event);
 }
 if(i%16===0)events.push({eventId:randomUUID(),kind:'CHAT',at:stamp(i),player:player(i),dimension:'minecraft:overworld',text:'完整聊天内容 '+i});
 if(i%16===1)events.push({eventId:randomUUID(),kind:'CONTAINER',at:stamp(i),player:player(i),dimension:'minecraft:overworld',container:{operation:'TRANSFER',evidence:'COMMITTED_TRANSACTION',block:'minecraft:chest',positions:[{x:i,y:64,z:0}],changes:[{slot:0,before:{type:'minecraft:diamond',count:3},after:{type:'minecraft:diamond',count:2}}]}});
 bodies.push(batch(events,stamp(i+1)));
}
const bootstrap=[batch([],stamp(-60)),batch([],new Date().toISOString())];
const tables=['players','player_names','player_servers','player_server_names','daily_statistics','metric_coverage','collector_capabilities','telemetry_events','telemetry_batches','activity_feed','container_audit','container_audit_locations'];
function snapshot(){const result={};for(const table of tables){const select=table==='container_audit_locations'?'select l.*,a.event_id from container_audit_locations l join container_audit a on a.id=l.audit_id':'select * from '+table;const data=sql(`select row_to_json(t) from (${select}) t`);result[table]=(data?data.split('\n').map(JSON.parse):[]).map(row=>{for(const k of ['server_id','received_at','cursor_id'])delete row[k];if(table==='container_audit')delete row.id;if(table==='container_audit_locations')delete row.audit_id;return JSON.stringify(row)}).sort()}result.activityOrder=sql('select event_id from activity_feed order by cursor_id').split('\n');return result}
async function stop(){const child=backend;backend=undefined;if(child?.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit')}}
const results=[];let previous;
try{
 execFileSync('docker',['run','--rm','-d','--name',db,'-e','POSTGRES_PASSWORD','-p','127.0.0.1::5432','postgres:17-alpine'],{env:{...process.env,POSTGRES_PASSWORD:password},stdio:'pipe'});
 const port=execFileSync('docker',['port',db,'5432/tcp'],{encoding:'utf8'}).trim().split(':').pop();await until(()=>{try{execFileSync('docker',['exec',db,'pg_isready','-U','postgres'],{stdio:'pipe'});return true}catch{return false}});
 for(const [name,jar] of [['before',path.resolve(oldJar)],['after',path.join(root,'backend/target/mcmanager-archive-0.1.0.jar')]]){
  if(name==='after')sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  cookies=new Map();log='';base=undefined;
  backend=spawn('C:/Program Files/Java/jdk-21/bin/java.exe',['-jar',jar],{cwd:out,windowsHide:true,env:{...process.env,MCM_PORT:'0',MCM_BIND_ADDRESS:'127.0.0.1',MCM_ADMIN_USERNAME:'admin',MCM_ADMIN_PASSWORD:password,MCM_COOKIE_SECURE:'false',MCM_DB_URL:`jdbc:postgresql://127.0.0.1:${port}/postgres`,MCM_DB_USER:'postgres',MCM_DB_PASSWORD:password}});
  for(const stream of [backend.stdout,backend.stderr])stream.on('data',x=>{log+=x;writeFileSync(path.join(out,name+'.log'),log)});
  await until(()=>{const m=log.match(/Tomcat started on port (\d+)/);if(m)base='http://127.0.0.1:'+m[1];return base});
  csrf=await(await req('/api/auth/csrf')).json();assert.equal((await req('/api/auth/login',{method:'POST',headers:{[csrf.headerName]:csrf.token},body:new URLSearchParams({username:'admin',password})})).status,204);csrf=await(await req('/api/auth/csrf')).json();
  const server=await admin('/api/servers',{name:'Parity QA',description:'isolated',startDate:'2020-01-01'}),credential=await admin(`/api/servers/${server.id}/collector-credential`,{});
  async function ingest(group){const r=await fetch(base+'/api/ingest/v1/batches/bulk',{method:'POST',headers:{Authorization:'Bearer '+credential.token,'Content-Type':'application/json'},body:JSON.stringify({batches:group})});assert.equal(r.status,200,await r.clone().text());return r.json()}
  await ingest(bootstrap);const begin=performance.now();let accepted=0;
  for(let i=0;i<bodies.length;i+=16){const receipts=await ingest(bodies.slice(i,i+16));assert.equal(receipts.length,Math.min(16,bodies.length-i));accepted+=receipts.reduce((n,r)=>n+r.acceptedEvents,0)}
  const millis=Math.round(performance.now()-begin);assert.equal(accepted,bodies.reduce((n,b)=>n+JSON.parse(b).events.length,0));
  const snap=snapshot();if(previous)assert.deepEqual(snap,previous);else previous=snap;
  for(let i=0;i<bodies.length;i+=16){const receipts=await ingest(bodies.slice(i,i+16));assert.ok(receipts.every(r=>r.duplicateBatch&&r.acceptedEvents===0))}assert.deepEqual(snapshot(),snap);
  await delay(1500);const updates=JSON.parse(sql("select json_object_agg(relname,n_tup_upd) from pg_stat_user_tables where relname in ('metric_coverage','players','player_names','player_servers','player_server_names')"));
  results.push({name,batches:bodies.length,events:accepted,millis,updates});console.log(JSON.stringify(results.at(-1)));writeFileSync(path.join(out,name+'-snapshot.json'),JSON.stringify(snap,null,2));await stop();
 }
 writeFileSync(path.join(out,'evidence.json'),JSON.stringify({sameOriginalBytes:true,sameLogicalData:true,sameActivityOrder:true,replaysDeduplicated:true,results},null,2));
}finally{await stop();try{execFileSync('docker',['stop',db],{stdio:'pipe'})}catch{}}
