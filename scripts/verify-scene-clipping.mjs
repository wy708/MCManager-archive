import {createServer} from '../frontend/node_modules/vite/dist/node/index.js';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Use an actual archived scene, not replacement block geometry.
const fixture=process.env.MCM_SCENE_QA_OUTPUT;
assert.ok(fixture,'Set MCM_SCENE_QA_OUTPUT to a captured scene and its textures');
const output=path.resolve('frontend/test-results/clipping');await mkdir(output,{recursive:true});
const server=await createServer({root:path.resolve('frontend'),server:{host:'127.0.0.1',port:0},plugins:[{name:'clipping-proof',configureServer(s){s.middlewares.use(async(req,res,next)=>{
  const url=req.url?.split('?')[0];
  if(url==='/__clip'){res.setHeader('Content-Type','text/html');res.end('<html><body style="margin:0"></body></html>');return;}
  if(url?.startsWith('/__fixture/')){const file=url.slice(11);if(file!=='scene.json'&&!/^[a-f0-9]{64}\.png$/.test(file)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',file.endsWith('.png')?'image/png':'application/json');res.end(await readFile(path.join(fixture,file)));return;}next();
});}}]});await server.listen();
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:600,height:600}});await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__clip`);
 const results=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js'),{createProjectScene}=await import('/src/projectScene.ts'),{projectHeightClipping}=await import('/src/projectHeightClipping.ts');
  const data=await(await fetch('/__fixture/scene.json')).json();data.models=data.models.filter(m=>m.y===50);
  if(data.models.length!==143)throw Error('Expected the complete 13 by 11 captured floor');
  const object=await createProjectScene(data,f=>'/__fixture/'+f),scene=new T.Scene();scene.add(object.group);scene.add(new T.HemisphereLight(0xffffff,0x778878,2));
  const renderer=new T.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});renderer.setSize(600,600);document.body.append(renderer.domElement);
  const camera=new T.PerspectiveCamera(42,1,.05,2000),target=new T.Vector3(0,50-object.center.y,0),pixels=new Uint8Array(600*600*4);
  const gl=renderer.getContext(),results=[];
  for(const angle of [[.1,-1,.1],[.3,-1,.2],[.01,-1,.02],[.3,1,.2]]){
   camera.position.copy(target).add(new T.Vector3(...angle).normalize().multiplyScalar(21));camera.lookAt(target);camera.updateMatrixWorld();
   for(const epsilon of [0,.001]){
    renderer.clippingPlanes=epsilon?projectHeightClipping(object.center.y,50,50):[new T.Plane(new T.Vector3(0,1,0),object.center.y-50),new T.Plane(new T.Vector3(0,-1,0),51-object.center.y)];renderer.render(scene,camera);
    gl.readPixels(0,0,600,600,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let holes=0;
    for(let y=220;y<380;y++)for(let x=220;x<380;x++)if(pixels[(y*600+x)*4+3]<250)holes++;
    results.push({angle,epsilon,holes});
    if(angle[0]===.3&&angle[1]===-1){window.clipProof??={};window.clipProof[epsilon===0?'before':'after']=renderer.domElement.toDataURL();}
   }
  }
  object.dispose();renderer.dispose();return results;
 });
 for(const which of ['before','after']){const data=await page.evaluate(k=>window.clipProof[k],which);const {writeFile}=await import('node:fs/promises');await writeFile(path.join(output,which+'.png'),Buffer.from(data.split(',')[1],'base64'));}
 console.log(JSON.stringify(results,null,2));assert.ok(results.some(r=>r.epsilon===0&&r.holes>0),'Regression must reproduce old clipping holes');assert.ok(results.filter(r=>r.epsilon>0).every(r=>r.holes===0),'Boundary faces must stay solid');
}finally{await browser.close();await server.close();}
