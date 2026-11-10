import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
import { chromium } from '../frontend/node_modules/playwright/index.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.resolve(process.env.MCM_SCENE_QA_OUTPUT??'.tools/scene-engine-prototype/output');
const scene=JSON.parse(await readFile(path.join(output,'scene.json'),'utf8'));
assert.ok(scene.issues.every(issue=>issue==='部分区域尚无群系记录，植物与水面采用默认配色'),'This fixture must have no missing models or textures');
for(const type of ['minecraft:cow','minecraft:armor_stand','minecraft:diamond_helmet'])assert.ok(scene.models.some(m=>m.type===type&&m.faces.length>0),type+' geometry missing');
assert.ok(scene.models.every(m=>!['minecraft:item','minecraft:player'].includes(m.type)),'Dropped items and players must not be rendered');
const sign=scene.models.find(m=>m.x===3&&m.y===100&&m.z===1);
if(sign)assert.ok(sign.faces.filter(f=>f.vertexColor).length>=8,'Chinese and numeric sign glyphs must not silently disappear');
const frame=scene.models.find(m=>m.type==='minecraft:item_frame');if(frame)assert.ok(frame.faces.length>26,'The displayed diamond must have geometry in addition to the frame');
const server=await createServer({root:path.join(root,'frontend'),server:{host:'127.0.0.1',port:0},plugins:[{name:'isolated-scene-proof',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  const url=req.url?.split('?')[0];
  if(url==='/__scene_proof'){res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#edf5f0"><main id="scene"></main></body></html>');return;}
  if(url?.startsWith('/__scene_fixture/')){const file=url.slice('/__scene_fixture/'.length);if(!['scene.json','scene-building.glb','scene-all.glb'].includes(file)&&!/^[a-f0-9]{64}\.png$/.test(file)){res.statusCode=404;res.end();return;}res.setHeader('content-type',file.endsWith('.png')?'image/png':file.endsWith('.glb')?'model/gltf-binary':'application/json');res.end(await readFile(path.join(output,file)));return;}next();
});}}]});
await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({headless:true});
try{
  await mkdir(path.join(root,'frontend/test-results'),{recursive:true});
  for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:width===390?650:950},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/__scene_proof');
    const result=await page.evaluate(async()=>{
      const THREE=await import('/node_modules/three/build/three.module.js');
      const {OrbitControls}=await import('/node_modules/three/examples/jsm/controls/OrbitControls.js');
      const {createProjectScene}=await import('/src/projectScene.ts');
      const input=await(await fetch('/__scene_fixture/scene.json')).json(),rendered=await createProjectScene(input,file=>'/__scene_fixture/'+file);
      const moving=rendered.group.children.filter(m=>m.userData.movingEntity),decorations=rendered.group.children.filter(m=>!m.userData.movingEntity);
      if(!moving.length||moving.some(m=>m.visible)||decorations.some(m=>!m.visible))throw new Error('Default visibility must hide moving entities and keep building decorations');
      const ids=rendered.group.children.map(m=>m.geometry.uuid).join(',');rendered.setMovingEntities(true);
      if(moving.some(m=>!m.visible)||decorations.some(m=>!m.visible))throw new Error('Showing creatures must preserve decorations');
      rendered.setMovingEntities(false);
      if(moving.some(m=>m.visible)||decorations.some(m=>!m.visible)||ids!==rendered.group.children.map(m=>m.geometry.uuid).join(','))throw new Error('Visibility toggle must not remove or rebuild recorded models');
      const {GLTFLoader}=await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
      for(const [filename,expected] of [['scene-building.glb',decorations.reduce((n,m)=>n+m.geometry.getAttribute('position').count/3,0)],['scene-all.glb',rendered.triangles]]){
        const bytes=await(await fetch('/__scene_fixture/'+filename)).arrayBuffer(),exported=await new GLTFLoader().parseAsync(bytes,'');let triangles=0;
        exported.scene.traverse(child=>{if(child.isMesh){triangles+=(child.geometry.index?.count??child.geometry.getAttribute('position').count)/3;if(!child.material.map)throw new Error('GLB texture not embedded');child.geometry.dispose();child.material.map.dispose();child.material.dispose()}});
        if(triangles!==expected)throw new Error('GLB must preserve every selected triangle: '+filename+' '+triangles+' vs '+expected);
      }
      const scene=new THREE.Scene();scene.background=new THREE.Color('#edf5f0');scene.add(rendered.group);scene.add(new THREE.HemisphereLight(0xffffff,0x738c7c,2));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(30,60,20);scene.add(light);
      const camera=new THREE.PerspectiveCamera(42,innerWidth/innerHeight,0.05,1000),size=rendered.bounds.getSize(new THREE.Vector3()),radius=size.length()/2;
      const half=Math.min(camera.fov*Math.PI/360,Math.atan(Math.tan(camera.fov*Math.PI/360)*camera.aspect));camera.position.set(0.8,0.65,-0.8).normalize().multiplyScalar(radius/Math.sin(half)*1.15);
      const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(1);renderer.domElement.setAttribute('aria-label','真实采集场景渲染验证');document.querySelector('#scene').appendChild(renderer.domElement);
      const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,0,0);controls.update();const render=()=>renderer.render(scene,camera);controls.addEventListener('change',render);render();window.sceneProof={renderer,scene,camera,controls,rendered};
      return {triangles:rendered.triangles,issues:rendered.issues,meshes:rendered.group.children.length};
    });
    assert.ok(result.triangles>1000);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(root,`frontend/test-results/full-scene-${width}.png`)});console.log({width,...result});
    if(width===1440)for(const detail of ['sign','equipment','frame']){
      const result=await page.evaluate(async(detail)=>{
        const THREE=await import('/node_modules/three/build/three.module.js'),{createProjectScene}=await import('/src/projectScene.ts');
        const data=await(await fetch('/__scene_fixture/scene.json')).json();
        data.models=data.models.filter(m=>detail==='sign'?m.x===3&&m.y===100&&m.z===1:detail==='frame'?m.type==='minecraft:item_frame':m.type==='minecraft:armor_stand'||m.type==='minecraft:diamond_helmet');
        const proof=window.sceneProof;proof.scene.remove(proof.rendered.group);proof.rendered.dispose();
        proof.rendered=await createProjectScene(data,file=>'/__scene_fixture/'+file);proof.scene.add(proof.rendered.group);
        const size=proof.rendered.bounds.getSize(new THREE.Vector3());proof.camera.position.set(detail==='equipment'?.3:0,.08,-1).normalize().multiplyScalar(size.length()*1.55);proof.controls.target.set(0,0,0);proof.controls.update();proof.renderer.render(proof.scene,proof.camera);
        let cyan=0,opaque=0;
        if(detail==='equipment'){
          const file=data.models.find(m=>m.type==='minecraft:diamond_helmet').faces[0].texture;
          const bitmap=await createImageBitmap(await(await fetch('/__scene_fixture/'+file)).blob()),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
          for(let n=0;n<pixels.length;n+=4)if(pixels[n+3]>0){opaque++;if(pixels[n+1]>pixels[n]+20&&pixels[n+2]>pixels[n]+20)cyan++;}bitmap.close();
        }
        return {triangles:proof.rendered.triangles,cyan,opaque};
      },detail);
      assert.ok(result.triangles>0);if(detail==='equipment')assert.ok(result.cyan>result.opaque*.1,'Diamond armor must retain its cyan texture, not the black glint layer');
      await page.screenshot({path:path.join(root,`frontend/test-results/full-scene-${detail}.png`)});
    }
    assert.deepEqual(errors,[]);await page.close();
  }
}finally{await browser.close();await server.close();}
