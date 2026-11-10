// Private bounded worker, invoked by the same platform queue as scene baking.
import {readFile,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {writeGlb} from './glb.mjs';
const [input,directory,min,max,creatures,filename]=process.argv.slice(2);
if(!path.isAbsolute(input)||!path.isAbsolute(directory)||!/^range--?\d+--?\d+-(building|all)\.glb$/.test(filename))throw new Error('Invalid range export paths');
const range={minY:Number(min),maxY:Number(max)};
const scene=JSON.parse(await readFile(input,'utf8'));
try{await writeGlb(scene,directory,creatures==='true',range,filename+'.tmp');await rename(path.join(directory,filename+'.tmp'),path.join(directory,filename));}
finally{await unlink(path.join(directory,filename+'.tmp')).catch(()=>{});}
