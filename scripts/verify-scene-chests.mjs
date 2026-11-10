// Visual regression using the user's captured chest geometry, rendered by the production frontend.
import {createServer} from '../frontend/node_modules/vite/dist/node/index.js';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';import assert from 'node:assert/strict';
const fixtures={before:process.env.MCM_SCENE_BEFORE,after:process.env.MCM_SCENE_QA_OUTPUT};
assert.ok(fixtures.before&&fixtures.after,'Set MCM_SCENE_BEFORE and MCM_SCENE_QA_OUTPUT');
const output=path.resolve('frontend/test-results/chests');await mkdir(output,{recursive:true});
const server=await createServer({root:path.resolve('frontend'),server:{host:'127.0.0.1',port:0},plugins:[{name:'chest-proof',configureServer(s){s.middlewares.use(async(req,res,next)=>{
 const match=req.url?.match(/^\/__fixture\/(before|after)\/(scene\.json|[a-f0-9]{64}\.png)$/);
 if(match){res.setHeader('Content-Type',match[2].endsWith('.png')?'image/png':'application/json');res.end(await readFile(path.join(fixtures[match[1]],match[2])));return;}
 if(req.url==='/__proof'){res.setHeader('Content-Type','text/html');res.end('<html><body style="margin:0"></body></html>');return;}next();
});}}]});await server.listen();const browser=await chromium.launch({headless:true});
try{
 for(const phase of ['before','after']){
  const page=await browser.newPage({viewport:{width:600,height:450}});await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__proof`);
  const result=await page.evaluate(async phase=>{
   const T=await import('/node_modules/three/build/three.module.js'),{createProjectScene}=await import('/src/projectScene.ts');
   const data=await(await fetch(`/__fixture/${phase}/scene.json`)).json();data.models=data.models.filter(m=>m.x===-512&&m.y===64&&[-83,-82].includes(m.z));
   const object=await createProjectScene(data,f=>`/__fixture/${phase}/${f}`),scene=new T.Scene();scene.background=new T.Color('#eef5f1');scene.add(object.group);scene.add(new T.HemisphereLight(0xffffff,0x778878,2));const light=new T.DirectionalLight(0xffffff,2);light.position.set(30,60,20);scene.add(light);
   const camera=new T.PerspectiveCamera(42,600/450,.05,100);camera.position.set(3.2,3.1,1.1);camera.lookAt(0,0,0);
   const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(600,450);document.body.append(renderer.domElement);renderer.render(scene,camera);
   return {models:data.models.length,triangles:object.triangles,topU:data.models.map(m=>Math.min(...m.faces.find(f=>f.points.filter((_,n)=>n%3===1).every(y=>y===14)).uvs.filter((_,n)=>n%2===0)))};
  },phase);
  assert.equal(result.models,2);assert.equal(result.triangles,72);assert.deepEqual(result.topU,phase==='before'?[7,7]:[3.5,3.5]);
  await page.screenshot({path:path.join(output,phase+'.png')});console.log(phase,result);await page.close();
 }
}finally{await browser.close();await server.close();}
