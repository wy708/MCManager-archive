import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {writeGlb} from './glb.mjs';

test('range export clips crossing faces and UVs, embeds only used textures, excludes moving entities',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'mcm-glb-range-'));
 try {
  const texture='a'.repeat(64)+'.png',unused='b'.repeat(64)+'.png';
  await writeFile(path.join(directory,texture),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGPU6An4z8DAwMAEIkAYAB5AAgfNdB03AAAAAElFTkSuQmCC','base64'));
  const face={points:[0,0,0,16,0,0,16,96,0,0,96,0],uvs:[0,0,16,0,16,16,0,16],texture,doubleSided:true};
  const scene={format:1,models:[{x:12,y:-64,z:34,faces:[{...face,texture:unused}]},{x:12,y:62,z:34,entity:true,type:'minecraft:armor_stand',faces:[face]},{x:1000,y:62,z:34,entity:true,type:'minecraft:zombie',moving:true,faces:[face]}]};
  await writeGlb(scene,directory,false,{minY:64,maxY:65},'test.glb');const bytes=await readFile(path.join(directory,'test.glb'));
  const length=bytes.readUInt32LE(12),gltf=JSON.parse(bytes.subarray(20,20+length)),binary=28+length;
  assert.equal(bytes.readUInt32LE(8),bytes.length);assert.equal(gltf.images.length,1);assert.deepEqual(gltf.extras.heightRange,{minY:64,maxY:65});
  for(const mesh of gltf.meshes)for(const primitive of mesh.primitives){
   const pos=gltf.accessors[primitive.attributes.POSITION],uv=gltf.accessors[primitive.attributes.TEXCOORD_0];assert.ok(pos.count>=3);
   for(let i=0;i<pos.count;i++){
    const at=binary+gltf.bufferViews[pos.bufferView].byteOffset+i*12,x=bytes.readFloatLE(at)+gltf.extras.minecraftOrigin[0],y=bytes.readFloatLE(at+4)+gltf.extras.minecraftOrigin[1];
    assert.ok(x>=12&&x<=13);assert.ok(y>=64-1e-6&&y<=66+1e-6);
    const v=bytes.readFloatLE(binary+gltf.bufferViews[uv.bufferView].byteOffset+i*8+4);assert.ok(v>=1/3-1e-6&&v<=2/3+1e-6);
   }
  }
  await assert.rejects(writeGlb(scene,directory,false,{minY:90,maxY:80}));
  await assert.rejects(writeGlb(scene,directory,false,{minY:200,maxY:201}),/no model geometry/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
