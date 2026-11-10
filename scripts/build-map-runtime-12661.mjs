// Build only in .tools; never installs into or launches a game directory.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

assert.equal(process.platform,'win32','Windows x64 build only');
assert.ok(process.argv.slice(2).every(value=>value==='--prepare-only')&&process.argv.length<=3,'Only --prepare-only is accepted');
const root=fileURLToPath(new URL('../',import.meta.url));
const config=path.join(root,'map/compatibility');
const pins=JSON.parse(readFileSync(path.join(config,'sources.json')));
const work=path.join(root,'.tools/map-runtime-12661');mkdirSync(work,{recursive:true});
const capture=(exe,args,options={})=>execFileSync(exe,args,{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe'],...options}).trim();
const run=(exe,args,options={})=>execFileSync(exe,args,{windowsHide:true,stdio:'inherit',...options});
function checkout(directory,url,commit,allowBuildPatch=false){
  if(!existsSync(path.join(directory,'.git')))run('git',['clone','--depth','10',url,directory]);
  const head=capture('git',['-C',directory,'rev-parse','HEAD']);
  if(head!==commit){
    assert.equal(capture('git',['-C',directory,'status','--porcelain']),'','Source checkout contains unreviewed changes');
    run('git',['-C',directory,'fetch','--depth','10','origin',commit]);
    run('git',['-C',directory,'checkout','--detach',commit]);
  }
  assert.equal(capture('git',['-C',directory,'rev-parse','HEAD']),commit);
  if(!allowBuildPatch)assert.equal(capture('git',['-C',directory,'status','--porcelain']),'','Pinned package source contains local changes');
}
run(process.execPath,[path.join(root,'scripts/prepare-collector-sdk.mjs'),'--runtime=1.26.61.1']);
const sdk=path.join(root,'.tools/collector-sdk-26.60.2');
const provenance=JSON.parse(readFileSync(path.join(sdk,'provenance.json')));
assert.equal(provenance.sourceCommit,pins.levilaminaCommit);
assert.equal(provenance.repoCommit,pins.levimcRepositoryCommit);
assert.ok(provenance.compilerVersion.includes('version '+pins.compiler));
const llSource=path.join(root,'.tools/LeviLamina-26.60.2');
const leviRepo=path.join(root,'.tools/levimc-xmake-repo-26.60.2');
const packageRepo=path.join(work,'xmake-repo');
checkout(packageRepo,pins.xmakeRepository.url,pins.xmakeRepository.commit);
const source=path.join(work,'LeviStone');
checkout(source,pins.levistone.url,pins.levistone.commit,true);
run('git',['-C',source,'fetch','--depth','10','origin','tag','v0.11.14']);
run('git',['-C',source,'submodule','update','--init','--depth','1']);
assert.equal(capture('git',['-C',path.join(source,'endstone'),'rev-parse','HEAD']),pins.endstoneCommit);
const patch=path.join(work,'levistone-12661-build.patch');
writeFileSync(patch,readFileSync(path.join(config,'levistone-12661-build.patch'),'utf8').replaceAll('\r\n','\n'));
try{capture('git',['-C',source,'apply','--reverse','--check',patch]);}
catch{run('git',['-C',source,'apply','--check',patch]);run('git',['-C',source,'apply',patch]);}
const changed=capture('git',['-C',source,'diff','--name-only']).split(/\r?\n/).filter(Boolean);
assert.deepEqual(changed,['xmake.lua'],'Only the reviewed build configuration may differ');
const actualPatch=capture('git',['-C',source,'diff','--no-ext-diff','--','xmake.lua']);
// Git may append a function/context label to hunk headers; the changed lines
// and hunk ranges must still match the reviewed patch exactly.
const normalizedPatch = value => value.replaceAll('\r\n','\n').replace(/^(@@[^\n]+?@@)[^\n]*$/gm,'$1').trim();
assert.equal(normalizedPatch(actualPatch.slice(actualPatch.indexOf('---'))),normalizedPatch(readFileSync(patch,'utf8')),'Build configuration differs from the reviewed patch');
const pythonInfo=JSON.parse(capture('py',['-3.12','-c','import sys,json; print(json.dumps({"base":sys.base_prefix,"version":".".join(map(str,sys.version_info[:3]))}))']));
assert.equal(pythonInfo.version,pins.python,'Use the reviewed CPython patch version');
const python=path.join(pythonInfo.base,'python.exe');
const env={...process.env,PATH:provenance.llvmBin+';'+pythonInfo.base+';'+process.env.PATH,PYTHON_VERSION:'3.12',MCM_MAP_LL_SOURCE:llSource,MCM_MAP_LL_SDK:sdk,MCM_MAP_LEVIMC_REPO:leviRepo,MCM_MAP_XMAKE_REPO:packageRepo};
writeFileSync(path.join(work,'source-manifest.json'),JSON.stringify({pins,sdkRuntimeHash:provenance.runtimeDllSha256,patchSha256:createHash('sha256').update(readFileSync(patch)).digest('hex')},null,2));
if(process.argv.includes('--prepare-only')){console.log('Pinned sources and reviewed build patch prepared; no compilation or game startup.');process.exit(0);}
run('xmake',['f','-y','-m','release','--vs=2022'],{cwd:source,env});
run('xmake',['-y','-j4'],{cwd:source,env});
const venv=path.join(work,'wheel-env');
if(!existsSync(path.join(venv,'Scripts/python.exe')))run(python,['-m','venv',venv]);
const packagePython=path.join(venv,'Scripts/python.exe');
run(packagePython,['-m','pip','install','--disable-pip-version-check',...pins.buildPythonPackages]);
const packageEnv={...env,SETUPTOOLS_SCM_PRETEND_VERSION_FOR_LEVISTONE:pins.wheelVersion};
run(packagePython,['setup.py','--version'],{cwd:source,env:packageEnv});
copyFileSync(path.join(source,'endstone/endstone/_version.py'),path.join(source,'bin/EndstoneRuntime/endstone/_version.py'));
const manifestPath=path.join(source,'bin/EndstoneRuntime/manifest.json');
const manifest=JSON.parse(readFileSync(manifestPath));manifest.version=pins.modVersion;writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
run(packagePython,['-m','build','--wheel','--no-isolation'],{cwd:source,env:packageEnv});
const wheel=path.join(source,'dist',`levistone-${pins.wheelVersion}-cp312-cp312-win_amd64.whl`);
assert.ok(existsSync(wheel));
const files={};for(const relative of ['endstone_runtime.dll','endstone/_python.cp312-win_amd64.pyd'])files[relative]=createHash('sha256').update(readFileSync(path.join(source,'bin/EndstoneRuntime',relative))).digest('hex');
const report={runtimeProfile:pins.runtimeProfile,status:'built-not-runtime-verified',wheel:path.relative(root,wheel),wheelSha256:createHash('sha256').update(readFileSync(wheel)).digest('hex'),files,sourceCommit:pins.levistone.commit,endstoneCommit:pins.endstoneCommit,requiresCheckedRuntimeAdapter:true};
writeFileSync(path.join(work,'built-artifacts.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
console.log('A new build is not automatically approved for installation. Complete real-game verification before reviewing verified-artifacts.json.');
