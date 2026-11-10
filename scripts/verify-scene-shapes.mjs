// State-matrix regression using the same pinned baker as production. Synthetic input,
// deliberately separate from verify-project-model.mjs's real BDS evidence.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve(process.env.MCM_SHAPES_OUTPUT??'.tools/scene-shapes-qa');
const runner=path.resolve(process.env.MCM_SCENE_RUNNER??'.tools/scene-runtime/run.mjs');
await mkdir(output,{recursive:true});
const cases=[];
for(const wood of ['oak','spruce','birch','jungle','acacia','dark_oak','mangrove','cherry','pale_oak'])for(const axis of ['x','y','z'])cases.push({name:`minecraft:${wood}_log`,states:{pillar_axis:axis},kind:'log',axis});
for(const name of ['torch','soul_torch','redstone_torch','unlit_redstone_torch'])for(const direction of ['top','north','east','south','west'])cases.push({name:'minecraft:'+name,states:{torch_facing_direction:direction},kind:'torch',direction});
for(let bits=1;bits<16;bits++)cases.push({name:'minecraft:vine',states:{vine_direction_bits:bits},kind:'vine',bits});
for(const upside of [0,1])for(let direction=0;direction<4;direction++)cases.push({name:'minecraft:oak_stairs',states:{upside_down_bit:upside,weirdo_direction:direction},kind:'stairs'});
for(const half of ['bottom','top'])cases.push({name:'minecraft:stone_block_slab',states:{'minecraft:vertical_half':half,stone_slab_type:'stone'},kind:'slab'});
for(const name of ['glass_pane','oak_fence','chest','crafting_table','furnace','lantern','rail','red_flower','oak_leaves'])cases.push({name:'minecraft:'+name,states:{},kind:'other'});
// Bedrock snapshots currently omit chest pairing NBT; do not fabricate double chests from adjacency.
for(const name of ['chest','trapped_chest','ender_chest'])for(const facing of ['north','east','south','west'])cases.push({name:'minecraft:'+name,states:{'minecraft:cardinal_direction':facing},kind:'chest'});
const input=cases.map((c,i)=>({x:i*8,y:0,z:0,palette:[{name:'minecraft:air',states:''},{name:c.name,states:JSON.stringify({name:c.name,states:c.states})}],runs:[1,1,0,511],scene:{version:1,extraRuns:[0,512],blockEntities:[],entities:[],blocksComplete:true,entitiesComplete:true,biomePalette:['minecraft:plains'],biomeRuns:[0,512]}}));
await writeFile(path.join(output,'input.json'),JSON.stringify(input));
const child=spawn(process.execPath,[runner,path.join(output,'input.json'),path.join(output,'rendered')],{stdio:'inherit',windowsHide:true});
await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Baker failed '+code)))});
const scene=JSON.parse(await readFile(path.join(output,'rendered/scene.json'),'utf8'));assert.deepEqual(scene.issues,[]);
function axisRange(faces,axis){const values=faces.flatMap(f=>f.points.filter((_,i)=>i%3===axis));return Math.max(...values)-Math.min(...values)}
for(let i=0;i<cases.length;i++){
 const c=cases[i],models=scene.models.filter(m=>m.x===i*8&&m.y===0&&m.z===0),faces=models.flatMap(m=>m.faces);assert.ok(faces.length,c.name+' missing');
 if(c.kind==='log'){
  const textures=new Map();for(const f of faces)textures.set(f.texture,(textures.get(f.texture)??0)+1);
  assert.deepEqual([...textures.values()].sort(),[2,4],`${c.name}/${c.axis}: end grain and bark must be distinct`);
  const end=[...textures].find(([,count])=>count===2)[0],axis='xyz'.indexOf(c.axis);
  for(const f of faces.filter(f=>f.texture===end))assert.ok(axisRange([f],axis)<.001,`${c.name}: end grain on wrong axis`);
 }
 if(c.kind==='torch'){
  assert.ok(axisRange(faces,1)<12,'Torch height must not fill a block');
  if(c.direction==='top'){assert.ok(axisRange(faces,0)<=4);assert.ok(axisRange(faces,2)<=4)}
  else assert.ok(Math.min(axisRange(faces,0),axisRange(faces,2))<=4.01,'Wall torch must remain narrow');
 }
 if(c.kind==='vine'){
  for(const f of faces)assert.ok(Math.min(axisRange([f],0),axisRange([f],2))<.001,'Vines must be attached planes');
  assert.ok(faces.length<12,'Vines must not become six textured cube faces');
 }
 if(c.kind==='slab')assert.equal(axisRange(faces,1),8,'Slab must be half height');
 if(c.kind==='stairs')assert.ok(faces.length>6,'Stairs must include real steps');
 if(c.kind==='chest'){
  const top=faces.find(f=>f.points.filter((_,n)=>n%3===1).every(y=>y===14));
  assert.ok(top,`${c.name}: closed lid missing`);
  const u=top.uvs.filter((_,n)=>n%2===0);
  assert.equal(Math.min(...u),3.5,'Chest lid must sample its exterior, not its underside');
  assert.equal(Math.max(...u),7,'Chest lid must use its exterior atlas width');
  const a=top.points.slice(0,3),b=top.points.slice(3,6),d=top.points.slice(6,9);
  assert.ok((b[2]-a[2])*(d[0]-a[0])-(b[0]-a[0])*(d[2]-a[2])>0,'Lid winding must face upwards');
 }
}
await writeFile(path.join(output,'evidence.json'),JSON.stringify({cases:cases.length,passed:true,at:new Date().toISOString()},null,2));
console.log('Shape/texture state matrix passed:',cases.length);
