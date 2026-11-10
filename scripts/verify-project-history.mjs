import {createServer} from '../frontend/node_modules/vite/dist/node/index.js';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';
const root=process.cwd(),out=path.join(root,'frontend/test-results/history');await mkdir(out,{recursive:true});
const server=await createServer({root:path.join(root,'frontend'),plugins:[{name:'history-proof',enforce:'pre',transform(code,id){if(id.endsWith('/components/ProjectModelView.vue'))return code.replace('const expanded=ref(false)',`const expanded=ref(false)
defineExpose({snapshot:()=>({displayed,selected:selectedHistory.value,position:camera.position.toArray(),target:controls.target.toArray()}),face:()=>{camera.position.set(0,0,12);controls.target.set(0,0,0);controls.update();render()}})`);},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url==='/__pick'){res.setHeader('Content-Type','text/html');res.end('<html><body></body></html>');return;}if(req.url!=='/__history')return next();res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module">import {createApp,h,ref} from '/node_modules/.vite/deps/vue.js';import Model from '/src/components/ProjectModelView.vue';const model=ref();window.model=model;window.app=createApp({setup(){return()=>h(Model,{id:'history-test',revision:1,ref:model})}});window.app.mount('#app');</script>`)});}}],server:{host:'127.0.0.1',port:0}});
await server.listen();const browser=await chromium.launch({headless:true}),results=[];
try{for(const mobile of [false,true]){
 const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile});const errors=[],queries=[];page.on('pageerror',e=>errors.push(e.message));let delay=false;
 const texture='a'.repeat(64)+'.png',times={h1:'2026-11-08T01:00:00Z',h2:'2026-11-08T02:00:00Z',live:'2026-11-08T03:00:00Z'};
 await page.route('**/api/public/projects/history-test/**',async route=>{const url=new URL(route.request().url()),p=url.pathname;
  if(p.endsWith('/history'))return route.fulfill({json:{frames:['h2','h1'].map((id,i)=>({id,version:2-i,savedAt:times[id],observedAt:times[id],sections:1})),more:false}});
  if(p.endsWith('/status')){const build=p.includes('/history/h1/')?'h1':p.includes('/history/h2/')?'h2':'live';if(build==='h1'&&delay)await new Promise(r=>setTimeout(r,500));return route.fulfill({json:{state:'READY',build,version:1,latestVersion:1,observedAt:times[build],issues:[]}});}
  if(p.endsWith('/block')){queries.push(url.search);return route.fulfill({json:{x:-1,y:64,z:-1,known:true,block:{name:p.includes('/h1/')?'minecraft:stone':'minecraft:glass',states:'{"states":{"direction":2}}'},extra:null,observedAt:times[p.split('/').at(-2)],events:[{occurredAt:times.h1,player:'建设者',operation:'PLACE',block:'minecraft:stone'}],more:false,notice:'记录截至该分段采集时间'}});}
  if(p.endsWith('/height-range'))return route.fulfill({json:{minY:64,maxY:64,suggestedMinY:64,basis:'PLAYER_PLACEMENT'}});
  if(p.endsWith('/scene.json'))return route.fulfill({json:{format:1,renderer:'fixture',issues:[],models:[{x:-1,y:64,z:-1,entity:false,faces:[{points:[0,0,0,16,0,0,16,16,0,0,16,0],uvs:[0,0,16,0,16,16,0,16],texture,doubleSided:true}]}]}});
  return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGPU6An4z8DAwMAEIkAYAB5AAgfNdB03AAAAAElFTkSuQmCC','base64')});
 });
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__history`);await page.waitForFunction(()=>window.model?.value?.snapshot().displayed==='live');
 await page.evaluate(()=>window.model.value.face());const canvas=page.locator('canvas');await canvas.scrollIntoViewIfNeeded();let box=await canvas.boundingBox();
 if(mobile)await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);else await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await page.getByRole('region',{name:'选中方块信息'}).waitFor();await page.getByText('X -1 · Y 64 · Z -1',{exact:true}).waitFor();assert.match(queries.at(-1),/x=-1&y=64&z=-1/);
 await page.getByRole('button',{name:'关闭方块信息'}).click();await canvas.scrollIntoViewIfNeeded();box=await canvas.boundingBox();const count=queries.length;
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2+20,{steps:5});await page.mouse.up();assert.equal(queries.length,count,'Orbit drag must not inspect a block');
 const before=await page.evaluate(()=>window.model.value.snapshot());await page.getByLabel('选择历史画面').selectOption('h1');await page.waitForFunction(()=>window.model.value.snapshot().displayed==='h1');const after=await page.evaluate(()=>window.model.value.snapshot());assert.ok(after.position.every((v,i)=>Math.abs(v-before.position[i])<1e-6));assert.ok(after.target.every((v,i)=>Math.abs(v-before.target[i])<1e-6));
 await page.evaluate(()=>window.model.value.face());await canvas.scrollIntoViewIfNeeded();box=await canvas.boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);await page.getByRole('heading',{name:'石头',exact:true}).waitFor();await page.screenshot({path:path.join(out,mobile?'phone.png':'desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'回到最新',exact:true}).click();await page.waitForFunction(()=>window.model.value.snapshot().displayed==='live');assert.equal(await page.getByRole('region',{name:'选中方块信息'}).count(),0);
 delay=true;await page.getByLabel('选择历史画面').selectOption('h1');await page.getByLabel('选择历史画面').selectOption('');await page.waitForTimeout(800);assert.equal(await page.evaluate(()=>window.model.value.snapshot().displayed),'live');delay=false;
 await page.getByRole('button',{name:'播放建设过程',exact:true}).click();await page.waitForFunction(()=>window.model.value.snapshot().displayed==='h1');await page.waitForFunction(()=>window.model.value.snapshot().displayed==='h2');await page.getByRole('button',{name:'播放建设过程',exact:true}).waitFor({timeout:10000});
 assert.deepEqual(errors,[]);results.push({mobile,pointSelection:true,dragDoesNotSelect:true,historyCameraPreserved:true,playback:true,raceSafe:true});await page.close();
}
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__pick`);
 const picking=await page.evaluate(async()=>{
  const T=await import('/node_modules/.vite/deps/three.js'),{createProjectScene}=await import('/src/projectScene.ts');
  const cut=document.createElement('canvas');cut.width=2;cut.height=2;const ctx=cut.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,1,2,1);const transparent=cut.toDataURL();ctx.fillRect(0,0,2,2);const opaque=cut.toDataURL();
  const a='a'.repeat(64)+'.png',b='b'.repeat(64)+'.png',face=texture=>({points:[0,0,0,16,0,0,16,16,0,0,16,0],uvs:[0,0,16,0,16,16,0,16],texture,doubleSided:true});
  const obj=await createProjectScene({format:1,models:[{x:-8,y:64,z:1,entity:false,faces:[face(a)]},{x:-8,y:64,z:0,entity:false,faces:[face(b)]},{x:10,y:64,z:0,entity:false,faces:[face(b)]}],issues:[],renderer:'fixture'},f=>f===a?transparent:opaque);obj.group.updateMatrixWorld(true);
  const hit=(x,y,lo=-2048,hi=4095)=>obj.pick(new T.Raycaster(new T.Vector3(x,y,5).sub(obj.center),new T.Vector3(0,0,-1)),lo,hi);
  const result={throughTransparent:hit(-7.5,64.75)?.z,opaqueForeground:hit(-7.5,64.25)?.z,secondBatchedBlock:hit(10.5,64.5)?.x,clipped:hit(-7.5,64.25,65,90)===null};obj.dispose();return result;
 });assert.deepEqual(picking,{throughTransparent:0,opaqueForeground:1,secondBatchedBlock:10,clipped:true});results.push(picking);await page.close();
 await writeFile(path.join(out,'evidence.json'),JSON.stringify(results,null,2));console.log(results);}finally{await browser.close();await server.close();}
