import { t } from './i18n'
import * as THREE from 'three'
import { loadSceneAssets } from './sceneAssetPool'

export interface SceneFace { points:number[]; uvs:number[]; texture:string; doubleSided:boolean; vertexColor?:number[]; shadingMode?:string }
export interface SceneModel { x:number; y:number; z:number; entity:boolean; yaw?:number; type?:string; moving?:boolean; faces:SceneFace[] }
export interface SceneAnimation { height:number; interpolate:boolean; frames:number[] }
export interface ProjectScene { format:number; models:SceneModel[]; issues:string[]; renderer:string; animations?:Record<string,SceneAnimation> }
export interface SceneObject { group:THREE.Group; bounds:THREE.Box3; center:THREE.Vector3; triangles:number; issues:string[]; pick:(ray:THREE.Raycaster,minY:number,maxY:number)=>SceneModel|null; setMovingEntities:(visible:boolean)=>void; update:(time:number)=>boolean; dispose:()=>void }

/** Uses baked resource-pack geometry; neither substitutes cubes nor drops models at a count threshold. */
export async function createProjectScene(data:ProjectScene,textureUrl:(file:string)=>string,signal?:AbortSignal,range?:{minY:number;maxY:number},onTextures?:(loaded:number,total:number)=>void):Promise<SceneObject> {
  if(data.format!==1 || !Array.isArray(data.models))throw new Error(t('m0221'))
  // Filter before bounds, material loading and vertex allocation. GPU clipping
  // remains only for the edges of models intersecting a selected boundary.
  if(range){
    if(!Number.isInteger(range.minY)||!Number.isInteger(range.maxY)||range.minY < -2048||range.maxY>4095||range.minY>range.maxY)throw new Error(t('m0222'))
    data={...data,models:data.models.map(model=>{
      let bottom=Infinity,top=-Infinity
      const faces=model.faces.filter(face=>{
        const ys=face.points.filter((_,i)=>i%3===1).map(y=>y/16+model.y)
        const low=Math.min(...ys),high=Math.max(...ys)
        bottom=Math.min(bottom,low);top=Math.max(top,high)
        return high>=range.minY&&low<=range.maxY+1
      })
      // A lower block's top face touching minY is not part of the selected
      // layer. Keep genuine crossing models and a selected block's flat base.
      const flatBase=bottom===top&&bottom===range.minY&&model.y===range.minY
      return {...model,faces:((top>range.minY&&bottom<range.maxY+1)||flatBase)?faces:[]}
    }).filter(model=>model.faces.length>0)}
  }
  const group=new THREE.Group(),bounds=new THREE.Box3(),issues=[...(data.issues??[])],textures:THREE.Texture[]=[],materials:THREE.Material[]=[]
  const point=new THREE.Vector3(),center=new THREE.Vector3()
  function transformed(model:SceneModel,points:number[],index:number){
    point.set(points[index]!/16,points[index+1]!/16,points[index+2]!/16)
    if(model.entity&&model.yaw)point.applyAxisAngle(THREE.Object3D.DEFAULT_UP,-model.yaw*Math.PI/180)
    point.x+=model.x;point.y+=model.y;point.z+=model.z;return point
  }
  for(const model of data.models)for(const face of model.faces){
    if(face.points.length!==12 || face.uvs.length!==8 || !face.points.every(Number.isFinite) || !face.uvs.every(Number.isFinite))throw new Error(t('m0223'))
    for(let n=0;n<12;n+=3)bounds.expandByPoint(transformed(model,face.points,n))
  }
  if(bounds.isEmpty())bounds.set(new THREE.Vector3(),new THREE.Vector3());bounds.getCenter(center)
  const batches=new Map<string,{file:string;moving:boolean;doubleSided:boolean;unlit:boolean;positions:number[];uvs:number[];colors:number[];owners:number[]}>()
  const updates:((time:number)=>boolean)[]=[]
  let triangles=0
  const dispose=()=>{group.traverse(child=>{if(child instanceof THREE.Mesh)child.geometry.dispose()});materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());group.clear()}
  try {
    for(let m=0;m<data.models.length;m++){
      signal?.throwIfAborted();const model=data.models[m]!
      for(const face of model.faces){
        if(!/^[a-f0-9]{64}\.png$/.test(face.texture))throw new Error(t('m0224'))
        const moving=model.moving??(model.entity&&!(["minecraft:armor_stand","minecraft:painting","minecraft:item_frame","minecraft:glow_item_frame"].includes(model.type??"")||(model as SceneModel&{equipment?:boolean}).equipment===true))
        const unlit=face.shadingMode==='unlit'||face.shadingMode==='fullbright',key=`${face.texture}:${face.doubleSided}:${unlit}:${moving}`
        let batch=batches.get(key);if(!batch){batch={file:face.texture,moving,doubleSided:face.doubleSided,unlit,positions:[],uvs:[],colors:[],owners:[]};batches.set(key,batch)}
        batch.owners.push(m,m)
        for(const index of [0,1,2,0,2,3]){
          transformed(model,face.points,index*3).sub(center);batch.positions.push(point.x,point.y,point.z)
          batch.uvs.push(face.uvs[index*2]!/16,face.uvs[index*2+1]!/16)
          batch.colors.push(...(face.vertexColor??[1,1,1]))
        }
        triangles+=2
      }
      if(m%128===0)await new Promise<void>(resolve=>setTimeout(resolve,0))
    }
    const loaded=new Map<string,THREE.Texture>()
    const files=[...new Set([...batches.values()].map(batch=>batch.file))]
    let completed=0
    onTextures?.(0,files.length)
    await loadSceneAssets(files,async(file,textureSignal)=>{
        const response=await fetch(textureUrl(file),{signal:textureSignal});if(!response.ok)throw new Error(t('m0225'))
        const bitmap=await createImageBitmap(await response.blob(),{imageOrientation:'flipY'})
        let retained=false
        try {
        textureSignal.throwIfAborted()
        const animation=data.animations?.[file]
        let image:ImageBitmap|HTMLCanvasElement=bitmap
        if(animation){
          const frames=animation.frames,height=animation.height
          if(!Number.isInteger(height)||height<1||height>bitmap.height||bitmap.height%height!==0||!Array.isArray(frames)||frames.length<2||frames.length%2!==0||frames.length>16384||frames.some((n,i)=>!Number.isInteger(n)||(i%2===0?(n<0||n>=bitmap.height/height):(n<1||n>12000)))){bitmap.close();throw new Error(t('m0226'))}
          const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=height;const context=canvas.getContext('2d')!
          image=canvas;const total=frames.filter((_,i)=>i%2===1).reduce((a,b)=>a+b,0)*50
          let previous=-1;          updates.push(time=>{
            // At most 20 updates per second; texture animation does not fetch or change the archived scene.
            const tick=Math.floor(time/50);if(tick===previous)return false;previous=tick
            let elapsed=(tick*50)%total,index=0
            while(elapsed>=frames[index+1]!*50){elapsed-=frames[index+1]!*50;index+=2}
            const frame=frames[index]!,mix=animation.interpolate?elapsed/(frames[index+1]!*50):0
            // Bitmaps are flipped for WebGL. Frame zero is consequently at the bottom of the source image.
            context.globalCompositeOperation='copy';context.globalAlpha=1-mix;context.drawImage(bitmap,0,bitmap.height-(frame+1)*height,bitmap.width,height,0,0,bitmap.width,height)
            if(mix>0){const next=frames[(index+2)%frames.length]!;context.globalCompositeOperation='lighter';context.globalAlpha=mix;context.drawImage(bitmap,0,bitmap.height-(next+1)*height,bitmap.width,height,0,0,bitmap.width,height)}
            context.globalCompositeOperation='source-over';context.globalAlpha=1
            const found=loaded.get(file);if(found)found.needsUpdate=true
            return true
          })
          // Drawing before upload also prevents the first render from showing the whole strip.
          context.drawImage(bitmap,0,bitmap.height-height,bitmap.width,height,0,0,bitmap.width,height)
        }
        const texture=new THREE.Texture(image);if(animation)texture.flipY=false;texture.needsUpdate=true;texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestMipmapNearestFilter;texture.wrapS=texture.wrapT=THREE.RepeatWrapping
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d')!;context.drawImage(bitmap,0,0)
        const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let translucent=false
        for(let n=3;n<pixels.length;n+=4)if(pixels[n]!>0&&pixels[n]!<255){translucent=true;break}
        texture.userData.translucent=translucent;texture.userData.alpha={width:bitmap.width,height:bitmap.height,values:Uint8Array.from({length:bitmap.width*bitmap.height},(_,i)=>pixels[i*4+3]!)};texture.addEventListener('dispose',()=>bitmap.close());textures.push(texture);loaded.set(file,texture);retained=true
        onTextures?.(++completed,files.length)
        } finally {if(!retained)bitmap.close()}
    },signal)
    for(const batch of batches.values()){
      signal?.throwIfAborted();const texture=loaded.get(batch.file)!
      const parameters={map:texture,side:batch.doubleSided?THREE.DoubleSide:THREE.FrontSide,alphaTest:0.01,transparent:!!texture.userData.translucent,depthWrite:!texture.userData.translucent,vertexColors:true}
      const material=batch.unlit?new THREE.MeshBasicMaterial(parameters):new THREE.MeshLambertMaterial(parameters);materials.push(material)
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(batch.positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(batch.uvs,2));geometry.setAttribute('color',new THREE.Float32BufferAttribute(batch.colors,3));geometry.computeVertexNormals();geometry.computeBoundingSphere();const mesh=new THREE.Mesh(geometry,material);mesh.userData.movingEntity=batch.moving;mesh.visible=!batch.moving;group.add(mesh)
      mesh.userData.owners=new Uint32Array(batch.owners)
    }
    const pick=(ray:THREE.Raycaster,minY:number,maxY:number)=>{
      for(const hit of ray.intersectObjects(group.children.filter(child=>child.visible),false)){
        const model=data.models[hit.object.userData.owners[hit.faceIndex??0]]
        if(!model||model.entity||hit.point.y+center.y<minY||hit.point.y+center.y>maxY+1)continue
        const texture=((hit.object as THREE.Mesh).material as THREE.MeshLambertMaterial).map
        // ImageBitmap was flipped on decode; WebGL ignores Texture.flipY for bitmaps.
        if(texture&&hit.uv){const a=texture.userData.alpha,uv=hit.uv.clone();texture.transformUv(uv);if(texture.flipY)uv.y=1-uv.y;const px=Math.min(a.width-1,Math.floor(uv.x*a.width)),py=Math.min(a.height-1,Math.floor(uv.y*a.height));if(a.values[py*a.width+px]<3)continue}
        return model
      }
      return null
    }
    return {group,bounds,center,triangles,issues,pick,setMovingEntities:(visible:boolean)=>{for(const child of group.children)if(child.userData.movingEntity)child.visible=visible},update:(time:number)=>{let changed=false;for(const update of updates)changed=update(time)||changed;return changed},dispose}
  }catch(error){dispose();throw error}
}
