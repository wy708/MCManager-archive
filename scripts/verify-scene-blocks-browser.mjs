import {createServer} from '../frontend/node_modules/vite/dist/node/index.js';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),output=path.join(root,'.tools/scene-shapes-qa/rendered');
const server=await createServer({root:path.join(root,'frontend'),server:{host:'127.0.0.1',port:0},plugins:[{name:'shape-view',configureServer(s){s.middlewares.use(async(req,res,next)=>{
 if(req.url==='/__shapes'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#eef5f1"><div id="view"></div>');return}
 if(req.url?.startsWith('/__shape_asset/')){const file=req.url.slice(15);if(file!=='scene.json'&&!/^[a-f0-9]{64}\.png$/.test(file)){res.statusCode=404;res.end();return}res.setHeader('content-type',file.endsWith('.png')?'image/png':'application/json');res.end(await readFile(path.join(output,file)));return}next();
 })}}]});
await server.listen();const browser=await chromium.launch({headless:true}),base=`http://127.0.0.1:${server.httpServer.address().port}`;
try{
 await mkdir(path.join(root,'frontend/test-results'),{recursive:true});
 const page=await browser.newPage({viewport:{width:1200,height:760}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/__shapes');
 for(const [name,indices] of [['logs',[0,1,2,3,4,5]],['torches',[27,28,29,30,31]],['vines',[47,48,49,50,51,53]],['steps',[62,63,64,65,70,71]]]){
  const result=await page.evaluate(async(indices)=>{
   const THREE=await import('/node_modules/three/build/three.module.js'),{createProjectScene}=await import('/src/projectScene.ts');
   const data=await(await fetch('/__shape_asset/scene.json')).json();data.models=data.models.filter(m=>indices.includes(m.x/8));
   for(const m of data.models){const i=indices.indexOf(m.x/8);m.x=i%3*1.6;m.z=Math.floor(i/3)*1.7}
   const object=await createProjectScene(data,file=>'/__shape_asset/'+file),scene=new THREE.Scene();scene.background=new THREE.Color('#eef5f1');scene.add(object.group,new THREE.HemisphereLight(0xffffff,0x809080,2));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(5,10,3);scene.add(light);
   const camera=new THREE.PerspectiveCamera(35,innerWidth/innerHeight,.01,100);camera.position.set(6,6,-8);camera.lookAt(0,0,0);
   const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(innerWidth,innerHeight);document.getElementById('view').replaceChildren(renderer.domElement);renderer.render(scene,camera);
   window.previousProof?.dispose();window.previousProof={dispose(){object.dispose();renderer.dispose();renderer.forceContextLoss()}};
   return {triangles:object.triangles};
  },indices);
  assert.ok(result.triangles>0);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(root,`frontend/test-results/scene-shapes-${name}.png`)});
 }
 await page.close();console.log('Block geometry rendered in browser: logs, torches, vines, steps');
}finally{await browser.close();await server.close()}
