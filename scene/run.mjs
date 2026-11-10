// Invoked by the platform with private, generated absolute paths. No public listener.
import { spawn } from 'node:child_process';
import {writeGlb} from './glb.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const [input,output]=process.argv.slice(2);
if(!input||!output||!path.isAbsolute(input)||!path.isAbsolute(output))throw new Error('Absolute input and output paths required');
await mkdir(output,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(root,'packs/bedrock/manifest.json'),'utf8'));
const commands=[{command:'setActiveResourcePacks',resourcePacks:[manifest.header.uuid,'base_resource_pack']},{command:'mcmScene',input,output}];
const commandFile=path.join(output,'commands.json');await writeFile(commandFile,JSON.stringify(commands));
const java=process.env.MCM_SCENE_JAVA||(process.env.JAVA_HOME?path.join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java');
const args=['-Duser.language=en','-Xmx1g','-cp',path.join(root,'classes')+path.delimiter+path.join(root,'libs','*'),'org.mcmanager.scene.SceneBaker','-cli','-offlineMode','-rpDir',path.join(root,'packs'),'-homeDir',output,'-commandFile',commandFile,'-cliAutoQuit'];
// Upstream CLI initializes Swing. Linux uses a private virtual display, never a new network port.
const command=process.platform==='win32'?java:'xvfb-run';
const child=spawn(command,process.platform==='win32'?args:['-a','-s','-screen 0 640x480x24 -nolisten tcp',java,...args],{cwd:output,windowsHide:true,detached:process.platform!=='win32',env:{...process.env,XDG_CACHE_HOME:path.join(output,'.cache')},stdio:['ignore','pipe','pipe']});
function stop(){if(!child.pid)return;try{if(process.platform==='win32')child.kill();else process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')console.error('Could not stop scene process:',error.message);}}
let failed=false,pending='';
child.stdout.on('data',chunk=>{process.stdout.write(chunk);pending+=chunk;let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at).trim();pending=pending.slice(at+1);if(line.startsWith('[COMMAND] ')){try{const result=JSON.parse(line.slice(10));if(result.error||result.success===false||result.status==='error')failed=true;}catch{failed=true;}}}if(pending.length>1048576){failed=true;stop();}});
child.stderr.pipe(process.stderr);
const timer=setTimeout(()=>{failed=true;stop();},120000);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{failed=true;stop();process.exitCode=1;});
child.on('error',error=>{clearTimeout(timer);console.error(error.message);process.exitCode=1;});
child.on('exit',async code=>{clearTimeout(timer);try{const scene=JSON.parse(await readFile(path.join(output,'scene.json'),'utf8'));if(scene.format!==1||!Array.isArray(scene.models))failed=true;else if(code===0&&!failed){await writeGlb(scene,output,false);await writeGlb(scene,output,true);}}catch{failed=true;}process.exitCode=code===0&&!failed?0:1;});
