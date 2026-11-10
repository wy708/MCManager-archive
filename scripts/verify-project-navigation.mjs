import {createServer} from '../frontend/node_modules/vite/dist/node/index.js';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd();
// Test-only inspection is injected by Vite; production exposes no camera internals.
const server=await createServer({root:path.join(root,'frontend'),plugins:[{name:'navigation-proof',enforce:'pre',transform(code,id){
 if(id.endsWith('/components/ProjectModelView.vue'))return code.replace('const expanded=ref(false)',`const expanded=ref(false)
defineExpose({snapshot:()=>({position:camera.position.toArray(),target:controls.target.toArray(),center:object?.center.toArray(),busy:busy.value,moving:moving.value}),turn:()=>{camera.position.set(-20,15,10);controls.target.set(0,0,0);controls.update()}})`);
},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/__navigation')return next();res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module">import {createApp,h,ref} from '/node_modules/.vite/deps/vue.js';import Model from '/src/components/ProjectModelView.vue';const model=ref();window.app=createApp({setup(){return()=>h(Model,{id:'navigation-test',revision:1,ref:model})}});window.model=model;window.app.mount('#app');</script>`);});}}],server:{host:'127.0.0.1',port:0}});
await server.listen();const browser=await chromium.launch({headless:true});
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const close=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-6),sub=(a,b)=>a.map((v,i)=>v-b[i]);
try{
 await mkdir('frontend/test-results',{recursive:true});
 for(const width of [1440]){
 const page=await browser.newPage({viewport:{width,height:900},hasTouch:width===390}),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});
 const texture='a'.repeat(64)+'.png';
 await page.route('**/api/public/projects/navigation-test/**',async route=>{
 const url=route.request().url();
 if(url.endsWith('/status'))return route.fulfill({json:{state:'READY',build:'fixture',version:1,latestVersion:1,observedAt:new Date().toISOString(),issues:[]}});
 if(new URL(url).pathname.endsWith('/height-range'))return route.fulfill({json:{minY:0,maxY:9,suggestedMinY:0,basis:'PLAYER_PLACEMENT'}});
 if(new URL(url).pathname.endsWith('/scene.json'))return route.fulfill({json:{format:1,renderer:'test',issues:[],models:[{x:0,y:0,z:0,entity:false,faces:[{points:[0,0,0,16,0,0,16,160,0,0,160,0],uvs:[0,0,16,0,16,16,0,16],texture,doubleSided:true}]}]}});
 return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGPU6An4z8DAwMAEIkAYAB5AAgfNdB03AAAAAElFTkSuQmCC','base64')});
 });
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__navigation`);
 const forward=page.getByRole('button',{name:'前进视角',exact:true});await forward.waitFor();console.log('buttons ready',width);await page.waitForFunction(()=>window.model?.value?.snapshot&& !document.querySelector('.model-move-buttons button').disabled,null,{timeout:15000}).catch(async e=>{console.log(await page.locator('body').innerText());throw e});
 const snapshot=()=>page.evaluate(()=>window.model.value.snapshot());
 for(const turned of [false,true]){
 if(turned)await page.evaluate(()=>window.model.value.turn());
 for(const [positive,negative,axis] of [['前进','后退','horizontal'],['左移','右移','horizontal'],['上升','下降','vertical']]){
 const before=await snapshot();await page.getByRole('button',{name:positive+'视角',exact:true}).click();const after=await snapshot(),delta=sub(after.position,before.position);
 assert.ok(!close(after.position,before.position),positive+' moves');assert.ok(close(delta,sub(after.target,before.target)),'target moves with camera');
 assert.ok(close(sub(before.position,before.target),sub(after.position,after.target)),'orientation and zoom retained');
 if(axis==='horizontal'){assert.ok(Math.abs(delta[1])<1e-6);const view=sub(before.target,before.position);view[1]=0;if(positive==='前进')assert.ok(dot(view,delta)>0,'forward follows view heading');if(positive==='左移')assert.ok(dot([view[2],0,-view[0]],delta)>0,'left follows view heading')}else assert.ok(Math.abs(delta[0])+Math.abs(delta[2])<1e-6&&delta[1]>0);
 await page.getByRole('button',{name:negative+'视角',exact:true}).click();assert.ok(close((await snapshot()).position,before.position),'opposite restores position');
 }
 }
 await forward.focus();const keyboardBefore=await snapshot();await page.keyboard.press('Enter');assert.ok(!close((await snapshot()).position,keyboardBefore.position));
 const box=await forward.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();const start=await snapshot();await page.waitForTimeout(600);const held=await snapshot();assert.ok(!close(start.position,held.position),'hold repeats');
 await page.mouse.move(5,5);await page.mouse.up();const released=await snapshot();await page.waitForTimeout(180);assert.ok(close(released.position,(await snapshot()).position),'release outside stops');
 await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));const blurred=await snapshot();await page.waitForTimeout(160);assert.equal(blurred.moving,null);assert.ok(close(blurred.position,(await snapshot()).position));await page.mouse.up();
 // Touch pointers use the same captured pointer path; cancellation and tab blur must stop it.
 const touch=await page.context().newCDPSession(page),touchBox=await forward.boundingBox();
 await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchBox.x+20,y:touchBox.y+20}]});await page.waitForTimeout(300);
 await touch.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});assert.equal((await snapshot()).moving,null);await touch.detach();

 await page.getByRole('button',{name:'重新居中',exact:true}).click();
 const centered=await snapshot(),distance=s=>Math.hypot(...sub(s.position,s.target));assert.ok(close(centered.target,[0,0,0]));
 for(const [a,b] of [['向左旋转','向右旋转'],['向上环绕','向下环绕']]){
  const before=await snapshot();await page.getByRole('button',{name:a,exact:true}).click();const rotated=await snapshot();assert.ok(!close(before.position,rotated.position));assert.ok(close(before.target,rotated.target));assert.ok(Math.abs(distance(before)-distance(rotated))<1e-6);
  await page.getByRole('button',{name:b,exact:true}).click();assert.ok(close((await snapshot()).position,before.position),'inverse orbit restores camera');
 }
 await page.getByRole('button',{name:'右移视角',exact:true}).click();
 const canvas=page.locator('.model-canvas canvas');await canvas.scrollIntoViewIfNeeded();let cb=await canvas.boundingBox();
 await page.mouse.move(cb.x+cb.width/2,cb.y+cb.height/2);const beforeZoom=await snapshot();await page.mouse.wheel(0,-300);
 await page.waitForFunction(d=>{const s=window.model.value.snapshot();return Math.abs(Math.hypot(...s.position.map((v,i)=>v-s.target[i]))-d)>.1},distance(beforeZoom));
 const zoomed=await snapshot();assert.ok(distance(zoomed)<distance(beforeZoom));
 for(const [a,b] of [['向左旋转','向右旋转'],['向上环绕','向下环绕']]){
  const before=await snapshot();await page.getByRole('button',{name:a,exact:true}).click();const after=await snapshot();
  assert.ok(close(after.target,before.target),'rotation after pan and zoom must preserve the current pivot');assert.ok(Math.abs(distance(after)-distance(before))<1e-6,'rotation must preserve zoom');
  await page.getByRole('button',{name:b,exact:true}).click();assert.ok(close((await snapshot()).position,before.position),'inverse rotation restores the panned, zoomed view');
 }
 const beforeHeight=await snapshot();await page.getByLabel('最低显示高度 Y').fill('6');await page.getByLabel('最高显示高度 Y').fill('9');await page.getByRole('button',{name:'查看这一层',exact:true}).click();await page.waitForFunction(()=>!window.model.value.snapshot().busy);const afterHeight=await snapshot(),world=(s,key)=>s[key].map((v,i)=>v+s.center[i]);assert.ok(close(world(afterHeight,'position'),world(beforeHeight,'position'))&&close(world(afterHeight,'target'),world(beforeHeight,'target')),'height loading must preserve the world-space view');
 await canvas.scrollIntoViewIfNeeded();cb=await canvas.boundingBox();
 // Pan with the actual mouse gesture, then rotate: both desktop and touch must retain this focus.
 await page.mouse.move(cb.x+cb.width/2,cb.y+cb.height/2);await page.mouse.down({button:'right'});await page.mouse.move(cb.x+cb.width/2+30,cb.y+cb.height/2+15);await page.mouse.up({button:'right'});
 const panned=await snapshot();assert.ok(!close(panned.target,beforeHeight.target));
 await page.mouse.move(cb.x+cb.width/2,cb.y+cb.height/2);await page.mouse.down();await page.mouse.move(cb.x+cb.width/2+15,cb.y+cb.height/2+10);await page.mouse.up();assert.ok(close((await snapshot()).target,panned.target),'mouse rotation must preserve the panned pivot');
 if(width===390){const session=await page.context().newCDPSession(page),before=await snapshot();await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cb.x+cb.width/2,y:cb.y+cb.height/2}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cb.x+cb.width/2+25,y:cb.y+cb.height/2+10}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.ok(close((await snapshot()).target,before.target),'touch rotation must preserve the panned pivot');assert.ok(!close((await snapshot()).position,before.position));await session.detach();}
 const beforeCenter=await snapshot();await page.getByRole('button',{name:'重新居中',exact:true}).click();const recentered=await snapshot();assert.ok(close(recentered.target,[0,3,0]),'explicit recenter uses clipped model bounds');assert.ok(Math.abs(distance(beforeCenter)-distance(recentered))<1e-6,'explicit recenter preserves zoom');
 await page.getByRole('button',{name:'右移视角',exact:true}).click();const beforeAll=await snapshot();await page.getByRole('button',{name:'全部高度',exact:true}).click();assert.ok(close((await snapshot()).target,beforeAll.target),'removing clipping must not reset focus');
 await page.getByRole('button',{name:'全屏查看',exact:true}).click();assert.equal(await page.locator('.model-expanded .model-move-buttons button').count(),6);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 for(const b of await page.locator('.model-move-buttons button').all())assert.ok((await b.boundingBox()).height>=44);
 await page.getByRole('button',{name:'回到全景',exact:true}).click();await page.screenshot({path:`frontend/test-results/project-navigation-${width}.png`,fullPage:true});
 await page.keyboard.press('Escape');await page.locator('.model-expanded').waitFor({state:'detached'});
 await page.evaluate(()=>window.app.unmount());assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Desktop navigation passed (mobile gestures and fullscreen covered by verify-project-fullscreen): six directions, pan and zoom then four rotations, mouse and touch pivot preservation, explicit recenter, clipping without jumps, inverse moves, keyboard, hold/release, cancel, fullscreen, cleanup.');
}finally{await browser.close();await server.close();}
