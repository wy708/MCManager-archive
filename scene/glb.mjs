// Offline GLB packaging of the exact baked geometry. No world access or external URLs.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Clip triangles, interpolating UVs along cut edges. Merely filtering whole blocks
// would leak tall models/entities outside the administrator's selected Y range.
function clip(vertices,bound,above){
  const result=[];
  for(let i=0;i<vertices.length;i++){
    const a=vertices[i],b=vertices[(i+1)%vertices.length],insideA=above?a.p[1]>=bound:a.p[1]<=bound,insideB=above?b.p[1]>=bound:b.p[1]<=bound;
    if(insideA)result.push(a);
    if(insideA!==insideB){const t=(bound-a.p[1])/(b.p[1]-a.p[1]);result.push({p:a.p.map((v,n)=>v+(b.p[n]-v)*t),uv:a.uv.map((v,n)=>v+(b.uv[n]-v)*t)});}
  }
  return result;
}
export async function writeGlb(scene,directory,includeCreatures=false,range=null,outputFile=null){
  if(range&&(!Number.isInteger(range.minY)||!Number.isInteger(range.maxY)||range.minY < -2048||range.maxY>4095||range.minY>range.maxY))throw new Error('Invalid export height range');
  const models=scene.models.filter(m=>!['minecraft:item','minecraft:player'].includes(m.type)&& (includeCreatures||!m.moving));
  const origin=models.length?[models[0].x,models[0].y,models[0].z]:[0,0,0];
  const gltf={asset:{version:'2.0',generator:'MCManager Archive'},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],materials:[],textures:[],images:[],samplers:[{magFilter:9728,minFilter:9728,wrapS:10497,wrapT:10497}],buffers:[{byteLength:0}],bufferViews:[],accessors:[],extras:{minecraftOrigin:origin,includesCreatures:includeCreatures,issues:scene.issues??[],description:'Captured project snapshot; fluid geometry is saved, not simulated.'}};
  if(range)gltf.extras.heightRange=range;
  const buffers=[],batches=new Map(),textures=new Map();let offset=0;
  function buffer(bytes,target){const aligned=(bytes.length+3)&~3,storage=Buffer.alloc(aligned);bytes.copy(storage);const view={buffer:0,byteOffset:offset,byteLength:bytes.length};if(target)view.target=target;offset+=aligned;buffers.push(storage);return gltf.bufferViews.push(view)-1;}
  function attribute(values,size,minMax=false){const bytes=Buffer.allocUnsafe(values.length*4);for(let n=0;n<values.length;n++)bytes.writeFloatLE(values[n],n*4);const accessor={bufferView:buffer(bytes,34962),componentType:5126,count:values.length/size,type:size===2?'VEC2':'VEC3'};
    if(minMax){accessor.min=Array(size).fill(Infinity);accessor.max=Array(size).fill(-Infinity);for(let n=0;n<values.length;n++){accessor.min[n%size]=Math.min(accessor.min[n%size],values[n]);accessor.max[n%size]=Math.max(accessor.max[n%size],values[n]);}}
    return gltf.accessors.push(accessor)-1;
  }
  for(const model of models){
    const angle=model.entity?-(model.yaw??0)*Math.PI/180:0,c=Math.cos(angle),s=Math.sin(angle);
    for(const face of model.faces){
      if(!/^[a-f0-9]{64}\.png$/.test(face.texture)||face.points.length!==12||face.uvs.length!==8)throw new Error('Invalid GLB source face');
      const unlit=['unlit','fullbright'].includes(face.shadingMode),key=`${face.texture}:${!!face.doubleSided}:${unlit}`;
      const points=[];for(let n=0;n<12;n+=3){const x=face.points[n]/16,y=face.points[n+1]/16,z=face.points[n+2]/16;points.push([x*c+z*s+model.x-origin[0],y+model.y-origin[1],-x*s+z*c+model.z-origin[2]]);}
      const a=points[1].map((v,n)=>v-points[0][n]),b=points[2].map((v,n)=>v-points[0][n]),normal=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],length=Math.hypot(...normal)||1;
      for(const indices of [[0,1,2],[0,2,3]]){
        let polygon=indices.map(index=>({p:points[index],uv:[face.uvs[index*2]/16,1-face.uvs[index*2+1]/16]}));
        if(range){polygon=clip(polygon,range.minY-origin[1],true);if(polygon.length)polygon=clip(polygon,range.maxY+1-origin[1],false);}
        for(let n=1;n+1<polygon.length;n++){
          const triangle=[polygon[0],polygon[n],polygon[n+1]],u=triangle[1].p.map((v,i)=>v-triangle[0].p[i]),v=triangle[2].p.map((v,i)=>v-triangle[0].p[i]);
          if(range&&Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])<1e-12)continue;
          let batch=batches.get(key);if(!batch){batch={file:face.texture,doubleSided:!!face.doubleSided,unlit,positions:[],normals:[],uvs:[],colors:[]};batches.set(key,batch);}
          for(const vertex of triangle){batch.positions.push(...vertex.p);batch.normals.push(...normal.map(n=>n/length));batch.uvs.push(...vertex.uv);batch.colors.push(...(face.vertexColor??[1,1,1]));}
        }
      }
    }
  }
  for(const batch of batches.values()){
    let texture=textures.get(batch.file);
    if(texture===undefined){const file=scene.exportTextures?.[batch.file]??batch.file;if(!/^[a-f0-9]{64}\.png$/.test(file))throw new Error('Invalid GLB texture');const image=await readFile(path.join(directory,file));const index=gltf.images.push({bufferView:buffer(image),mimeType:'image/png'})-1;texture=gltf.textures.push({sampler:0,source:index})-1;textures.set(batch.file,texture);}
    const material={pbrMetallicRoughness:{baseColorTexture:{index:texture},metallicFactor:0,roughnessFactor:1},doubleSided:batch.doubleSided,alphaMode:scene.textureAlpha?.[batch.file]??'MASK'};if(material.alphaMode==='MASK')material.alphaCutoff=.01;
    if(batch.unlit){material.extensions={KHR_materials_unlit:{}};gltf.extensionsUsed=['KHR_materials_unlit'];}
    const primitive={attributes:{POSITION:attribute(batch.positions,3,true),NORMAL:attribute(batch.normals,3),TEXCOORD_0:attribute(batch.uvs,2),COLOR_0:attribute(batch.colors,3)},material:gltf.materials.push(material)-1,mode:4};
    const mesh=gltf.meshes.push({primitives:[primitive]})-1;gltf.scenes[0].nodes.push(gltf.nodes.push({mesh,name:`Project material ${mesh+1}`})-1);
  }
  gltf.buffers[0].byteLength=offset;const json=Buffer.from(JSON.stringify(gltf)),jsonSize=(json.length+3)&~3,header=Buffer.alloc(20),jsonChunk=Buffer.alloc(jsonSize,32),binHeader=Buffer.alloc(8);json.copy(jsonChunk);
  header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+jsonSize+offset,8);header.writeUInt32LE(jsonSize,12);header.write('JSON',16);binHeader.writeUInt32LE(offset,0);binHeader.writeUInt32LE(0x004e4942,4);
  if(range&&!gltf.meshes.length)throw new Error('Selected height range contains no model geometry');
  const file=outputFile??(includeCreatures?'scene-all.glb':'scene-building.glb');if(path.basename(file)!==file)throw new Error('Invalid GLB output name');await writeFile(path.join(directory,file),Buffer.concat([header,jsonChunk,binHeader,...buffers]));return file;
}
