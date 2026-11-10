import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const pins=JSON.parse(readFileSync(path.join(root,'terrain/sources.json'),'utf8'));
const source=path.join(root,'.tools/terrain-cubiomes');
const run=(exe,args,options={})=>execFileSync(exe,args,{encoding:'utf8',windowsHide:true,...options});
if(!existsSync(source)) run('git',['clone',pins.repository,source],{stdio:'inherit'});
run('git',['-C',source,'checkout','--detach',pins.commit]);
if(run('git',['-C',source,'rev-parse','HEAD']).trim()!==pins.commit || run('git',['-C',source,'status','--porcelain']).trim()) throw Error('Terrain source must match the pinned clean revision');
const out=path.join(root,'terrain/bin');mkdirSync(out,{recursive:true});
const binary=path.join(out,process.platform==='win32'?'mcarchive-terrain.exe':'mcarchive-terrain');
let cc=process.env.CC || 'cc';
if(process.platform==='win32') {
  let bin=process.env.MCM_LLVM_BIN;
  const provenance=path.join(root,'.tools/collector-sdk-26.60.2/provenance.json');
  if(!bin && existsSync(provenance)) bin=JSON.parse(readFileSync(provenance,'utf8')).llvmBin;
  cc=process.env.CC || (bin?path.join(bin,'clang.exe'):'clang.exe');
}
const files=['noise','biomes','layers','biomenoise','cave','generator','finders','util','quadbase','mt'].map(n=>path.join(source,n+'.c'));
run(cc,['-O2','-fwrapv','-D_CRT_SECURE_NO_WARNINGS','-Wno-parentheses','-I',source,path.join(root,'terrain/native/query.c'),...files,'-o',binary,...(process.platform==='win32'?[]:['-lm'])],{stdio:'inherit'});
copyFileSync(path.join(source,'LICENSE'),path.join(out,'CUBIOMES-LICENSE.txt'));
const result=JSON.parse(run(binary,[],{input:'bedrock-26.60 1 overworld 0 64 0 0 16\n'}));
if(result.engine!==pins.engine || result.samples.length!==1) throw Error('Terrain smoke check failed');
writeFileSync(path.join(out,'build.json'),JSON.stringify({...pins,binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),builtAt:new Date().toISOString()},null,2));
console.log(JSON.stringify({binary,smoke:result}));
