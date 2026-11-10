import {readFile,writeFile,mkdir} from 'node:fs/promises';import {spawn} from 'node:child_process';import path from 'node:path';import assert from 'node:assert/strict';
const runtime=path.resolve(process.env.MCM_SCENE_RUNTIME??'.tools/scene-runtime-release-033'),out=path.resolve(process.argv[2]??'.tools/scene-biomes-qa');await mkdir(out,{recursive:true});
const biomes=['minecraft:plains','minecraft:jungle','minecraft:desert',null,'minecraft:cold_taiga'];
const input=biomes.map((biome,i)=>({x:i*8,y:64,z:0,palette:[{name:'minecraft:air',states:''},{name:'minecraft:grass_block',states:'{name:"minecraft:grass_block",states:{}}'}],runs:[1,1,0,511],scene:{version:1,extraRuns:[0,512],blockEntities:[],entities:[],blocksComplete:true,entitiesComplete:true,...(biome?{biomePalette:[biome],biomeRuns:[0,512]}:{})}}));
await writeFile(path.join(out,'input.json'),JSON.stringify(input));
await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(runtime,'run.mjs'),path.join(out,'input.json'),path.join(out,'rendered')],{windowsHide:true,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Baker failed '+code)))});
const scene=JSON.parse(await readFile(path.join(out,'rendered/scene.json'),'utf8'));const colors=[];
for(let i=0;i<biomes.length;i++){
 const faces=scene.models.filter(m=>m.x===i*8).flatMap(m=>m.faces),tops=faces.filter(f=>f.points.filter((_,n)=>n%3===1).every(y=>y===16));assert.equal(tops.length,1);assert.ok(tops[0].vertexColor);colors.push(tops[0].vertexColor);
 const sides=faces.filter(f=>new Set(f.points.filter((_,n)=>n%3===1)).size>1);assert.equal(sides.length,8);assert.equal(sides.filter(f=>!f.vertexColor).length,4,'Dirt base must not receive grass tint');assert.equal(sides.filter(f=>f.vertexColor).length,4,'Grass fringe must receive tint exactly once');
}
assert.notDeepEqual(colors[0],colors[1]);assert.notDeepEqual(colors[1],colors[2]);assert.notDeepEqual(colors[0],colors[4]);assert.deepEqual(colors[0],colors[3]);assert.deepEqual(scene.issues,['部分区域尚无群系记录，植物与水面采用默认配色']);
for(const file of ['scene-all.glb','scene-building.glb'])assert.equal((await readFile(path.join(out,'rendered',file))).subarray(0,4).toString(),'glTF');
await writeFile(path.join(out,'evidence.json'),JSON.stringify({biomes,linearTintColors:colors,sideTintSeparated:true,missingBiomeReported:true,exports:true},null,2));console.log('Grass biome tint, untinted dirt sides, fallback disclosure and GLB exports PASS');
