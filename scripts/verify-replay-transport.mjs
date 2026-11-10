import assert from 'node:assert/strict';
import http from 'node:http';import https from 'node:https';
import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';
import {randomUUID} from 'node:crypto';import path from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
const root=process.cwd(),out=path.resolve(process.argv[2]??'');assert.ok(process.argv[2]&&!existsSync(out));mkdirSync(out,{recursive:true});
const id=randomUUID(),token=id+'.'+'A'.repeat(43),bodies=Array.from({length:2},()=>JSON.stringify({protocolVersion:1,batchId:randomUUID(),events:[]}));
let hits=0,redirects=0,tlsHits=0;
const server=http.createServer((req,res)=>{hits++;req.resume();if(req.url==='/target'){redirects++;res.end();return}res.writeHead(302,{Location:'/target'}).end()});await new Promise(r=>server.listen(0,'127.0.0.1',r));
async function run(name,endpoint,extra={}){const file=path.join(out,name+'.private.json');writeFileSync(file,JSON.stringify({serverId:id,token,bodies,outbox:path.join(out,name),endpoint,...extra}));try{const child=spawn(path.join(root,'collector/build/1.26.61.1/windows/x64/release/verify-collector-core.exe'),['--http-bulk-reject',file],{windowsHide:true});let errors='';child.stderr.on('data',c=>errors+=c);const [code]=await once(child,'exit');assert.equal(code,0,errors)}finally{unlinkSync(file)}}
let tls;
try{
 const endpoint=`http://127.0.0.1:${server.address().port}/api/ingest/v1/batches`;
 await run('redirect',endpoint);assert.equal(hits,1);assert.equal(redirects,0);
 await run('other-server',endpoint,{token:randomUUID()+token.slice(36)});assert.equal(hits,1);
 const key=path.join(out,'qa.key'),cert=path.join(out,'qa.crt');execFileSync('C:/Program Files/Git/usr/bin/openssl.exe',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-days','1'],{windowsHide:true,stdio:'pipe'});
 tls=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{tlsHits++;req.resume();res.end('[]')});await new Promise(r=>tls.listen(0,'127.0.0.1',r));
 await run('untrusted-tls',`https://127.0.0.1:${tls.address().port}/api/ingest/v1/batches`);assert.equal(tlsHits,0);
 writeFileSync(path.join(out,'evidence.json'),JSON.stringify({redirectsFollowed:redirects,wrongServerSent:false,untrustedTlsRequests:tlsHits},null,2));console.log('Bulk upload rejects redirects, wrong-server credentials and untrusted TLS; original pending files retained');
}finally{server.closeAllConnections();server.close();tls?.closeAllConnections();tls?.close()}
