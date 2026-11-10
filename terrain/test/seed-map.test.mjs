import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const binary=process.env.MCM_TERRAIN_ENGINE??fileURLToPath(new URL('../bin/'+(process.platform==='win32'?'mcarchive-terrain.exe':'mcarchive-terrain'),import.meta.url));
const query=input=>JSON.parse(execFileSync(binary,[],{input,encoding:'utf8',timeout:5000}));
const fixture=JSON.parse(readFileSync(new URL('./structure-observations.json',import.meta.url),'utf8'));

test('structure candidate regression preserves actual BDS locate comparisons including known false positives and reference-point offsets',()=>{
  let observed=0;const different=[];
  for(const run of fixture.runs)for(const row of run.rows){
    const result=query(`structures bedrock-26.60 ${run.seed} ${row.dimension} ${row.type} 0 0 4096 1`);
    if(row.skipped){assert.equal(result.candidates.length,0);continue;}
    assert.deepEqual(result.candidates[0],row.prediction);assert.ok(row.actual);observed++;
    if(!row.sameChunk)different.push([run.seed,row.type]);
  }
  assert.equal(observed,23);
  assert.deepEqual(different,[['1','jungle_temple'],['-9007199254740993','desert_pyramid'],['-9007199254740993','trial_chambers']]);
});

test('structure search is bounded, distance ordered, type/dimension specific and honestly truncated',()=>{
  for(const [dim,type] of [['overworld','all'],['nether','all'],['overworld','village']]){
    const r=query(`structures bedrock-26.60 1 ${dim} ${type} -1 -17 4096 32`);
    assert.ok(r.candidates.length<=32);assert.equal(r.truncated,r.totalCandidates>r.candidates.length);
    let last=-1;for(const c of r.candidates){assert.ok(c.distanceSquared>=last);assert.equal(c.distanceSquared,(c.x+1)**2+(c.z+17)**2);assert.ok(c.distanceSquared<=4096**2);last=c.distanceSquared;if(type!=='all')assert.equal(c.structure,type);}
  }
  assert.equal(query('structures bedrock-26.60 1 overworld all 0 0 0 1').candidates.length,0);
  for(const input of ['structures bedrock-26.60 1 nether village 0 0 10 1','structures bedrock-26.60 1 overworld village 0 0 4097 1','structures bedrock-26.60 1 overworld all 0 0 100 33','structures bedrock-26.60 9223372036854775808 overworld all 0 0 100 1','structures bedrock-26.60 1 overworld all 30000000 0 100 1','chunks bedrock-26.60 overworld 0 0 9','chunks bedrock-26.60 overworld 30000000 0 0','chunks bedrock-26.60 overworld 0 0 0 extra']){
    const result=spawnSync(binary,[],{input,encoding:'utf8',timeout:5000});assert.equal(result.status,2,input);assert.equal(result.stdout,'');
  }
});

// Independent full-state MT19937 reference; does not call the upstream optimized C code.
function referenceSlime(x,z){
  const mt=new Uint32Array(624);mt[0]=(Math.imul(x,522133279)^z)>>>0;
  for(let i=1;i<624;i++)mt[i]=(Math.imul(1812433253,mt[i-1]^(mt[i-1]>>>30))+i)>>>0;
  const y=((mt[0]&0x80000000)|(mt[1]&0x7fffffff))>>>0;
  let v=(mt[397]^(y>>>1)^((y&1)?0x9908b0df:0))>>>0;
  v^=v>>>11;v^=(v<<7)&0x9d2c5680;v^=(v<<15)&0xefc60000;v^=v>>>18;
  return (v>>>0)%10===0;
}
test('slime chunks match independent unsigned MT19937 and negative block coordinates use floor division',()=>{
  for(const [x,z] of [[-1,-17],[0,0],[123456,-765432],[29999800,-29999800]]){
    const result=query(`chunks bedrock-26.60 overworld ${x} ${z} 8`);
    assert.equal(result.chunks.length,289);assert.equal(result.seedIndependent,true);
    assert.deepEqual(result.centerChunk,{x:Math.floor(x/16),z:Math.floor(z/16)});
    for(const c of result.chunks){assert.equal(c.slimeChunk,referenceSlime(c.chunkX,c.chunkZ));assert.equal(c.minX,c.chunkX*16);assert.equal(c.maxX,c.minX+15);assert.equal(c.minZ,c.chunkZ*16);assert.equal(c.maxZ,c.minZ+15);}
  }
  assert.ok(query('chunks bedrock-26.50 nether -1 -17 2').chunks.every(c=>c.slimeChunk===null));
  assert.deepEqual(query('chunks bedrock-26.50 overworld 0 0 2').chunks,query('chunks bedrock-26.60 overworld 0 0 2').chunks);
});
