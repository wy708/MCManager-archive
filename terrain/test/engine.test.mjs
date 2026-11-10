import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const binary=process.env.MCM_TERRAIN_ENGINE??fileURLToPath(new URL('../bin/'+(process.platform==='win32'?'mcarchive-terrain.exe':'mcarchive-terrain'),import.meta.url));
const fixture=JSON.parse(readFileSync(new URL('./bedrock-observations.json',import.meta.url),'utf8'));
const query=input=>JSON.parse(execFileSync(binary,[],{input,encoding:'utf8',timeout:3000}));
test('real BDS fixture: 499/500 biome samples agree; the coast discrepancy remains disclosed',()=>{
  let matches=0,disagreements=[];
  for(const run of fixture.runs)for(const region of run.regions){
    const result=query(`bedrock-26.60 ${run.seed} ${region.dimension} ${region.x} ${region.y} ${region.z} 32 16`);
    assert.equal(result.samples.length,25);
    result.samples.forEach((sample,i)=>{
      const actual=region.samples[i];assert.deepEqual([sample.x,sample.y,sample.z],[actual.x,actual.y,actual.z]);
      if(sample.biome===actual.canonical)matches++;else disagreements.push({seed:run.seed,dimension:region.dimension,x:sample.x,y:sample.y,z:sample.z,actual:actual.canonical,prediction:sample.biome});
    });
  }
  assert.equal(matches,499);assert.deepEqual(disagreements,[fixture.knownDisagreement]);
});
test('native worker rejects bad profiles, overflows, extra data and unbounded requests',()=>{
  for(const input of ['java 1 overworld 0 64 0 0 16','bedrock-26.60 9223372036854775808 overworld 0 64 0 0 16','bedrock-26.60 1 overworld 0 64 0 1024 16','bedrock-26.60 1 nether 0 -1 0 0 16','bedrock-26.60 1 overworld 30000000 64 0 128 16','bedrock-26.60 1 overworld 0 64 0 0 16 extra']) {
    const r=spawnSync(binary,[],{input,encoding:'utf8',timeout:3000});assert.equal(r.status,2,input);assert.equal(r.stdout,'');
  }
});
test('signed 64-bit endpoints remain valid and maximum grid stays bounded',()=>{
  for(const seed of ['-9223372036854775808','9223372036854775807']) {
    const result=query(`bedrock-26.60 ${seed} overworld -1 64 -17 128 16`);
    assert.equal(result.samples.length,289);assert.equal(result.samples[0].x,-129);assert.equal(result.samples.at(-1).z,111);
  }
});
