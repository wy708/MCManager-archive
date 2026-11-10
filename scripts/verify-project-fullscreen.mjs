import {createServer} from '../frontend/node_modules/vite/dist/node/index.js';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';
const root=process.cwd(),output=path.join(root,'frontend/test-results/fullscreen');await mkdir(output,{recursive:true});
const server=await createServer({root:path.join(root,'frontend'),plugins:[{name:'fullscreen-proof',enforce:'pre',transform(code,id){if(id.endsWith('/components/ProjectModelView.vue'))return code.replace('const expanded=ref(false)',`const expanded=ref(false)
defineExpose({snapshot:()=>({position:camera.position.toArray(),target:controls.target.toArray()})})`);},configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/__fullscreen')return next();res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="app" style="transform:translateZ(0);overflow:hidden;margin:30px"></main><aside inert id="already-inert"></aside><script type="module">import {createApp,h,ref} from '/node_modules/.vite/deps/vue.js';import Model from '/src/components/ProjectModelView.vue';const model=ref();window.model=model;window.app=createApp({setup(){return()=>h(Model,{id:'fullscreen-test',revision:1,ref:model})}});window.app.mount('#app');</script>`)});}}],server:{host:'127.0.0.1',port:0}});
await server.listen();const browser=await chromium.launch({headless:true}),results=[];
const close=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<1e-6);
try{for(const scenario of [
 {name:'desktop-native',width:1440,height:900,touch:false},
 {name:'phone-native',width:390,height:844,touch:true},
 {name:'phone-landscape',width:844,height:390,touch:true},
 {name:'phone-no-api',width:390,height:844,touch:true,mode:'missing'},
 {name:'phone-denied',width:390,height:844,touch:true,mode:'denied'}
]){
 const page=await browser.newPage({viewport:{width:scenario.width,height:scenario.height},hasTouch:scenario.touch}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(scenario.mode)await page.addInitScript(mode=>{Object.defineProperty(Element.prototype,'requestFullscreen',{configurable:true,value:mode==='missing'?undefined:()=>Promise.reject(new Error('Fullscreen unavailable'))});Object.defineProperty(Element.prototype,'webkitRequestFullscreen',{configurable:true,value:undefined});},scenario.mode);
 const texture='a'.repeat(64)+'.png';
 await page.route('**/api/public/projects/fullscreen-test/**',route=>{const url=route.request().url();if(url.endsWith('/status'))return route.fulfill({json:{state:'READY',build:'fixture',version:1,latestVersion:1,issues:[]}});if(new URL(url).pathname.endsWith('/height-range'))return route.fulfill({json:{minY:0,maxY:9,suggestedMinY:0,basis:'PLAYER_PLACEMENT'}});
 if(new URL(url).pathname.endsWith('/scene.json'))return route.fulfill({json:{format:1,renderer:'test',issues:[],models:[{x:0,y:0,z:0,entity:false,faces:[{points:[0,0,0,16,0,0,16,160,0,0,160,0],uvs:[0,0,16,0,16,16,0,16],texture,doubleSided:true}]}]}});return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGPU6An4z8DAwMAEIkAYAB5AAgfNdB03AAAAAElFTkSuQmCC','base64')});});
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__fullscreen`);await page.waitForFunction(()=>window.model?.value?.snapshot&&!document.querySelector('.model-move-buttons button').disabled);
 assert.equal(await page.locator('.model-navigation').first().isVisible(),!scenario.touch);
 const before=await page.evaluate(()=>window.model.value.snapshot());
 await page.getByRole('button',{name:'全屏查看',exact:true}).click();await page.getByRole('button',{name:'退出全屏',exact:true}).waitFor();
 if(!scenario.mode)await page.waitForFunction(()=>document.fullscreenElement===document.querySelector('.model-expanded'));
 else assert.equal(await page.evaluate(()=>document.fullscreenElement),null);
 const state=await page.evaluate(()=>{const canvas=document.querySelector('.model-canvas canvas').getBoundingClientRect();return {x:canvas.x,y:canvas.y,width:canvas.width,height:canvas.height,w:innerWidth,h:innerHeight,overflow:document.body.style.overflow,parent:document.querySelector('.model-expanded').parentElement.tagName,inert:document.querySelector('#app').inert};});
 assert.equal(state.x,0);assert.equal(state.y,0);assert.ok(Math.abs(state.width-state.w)<1&&Math.abs(state.height-state.h)<1,JSON.stringify(state));assert.equal(state.parent,'BODY');assert.equal(state.overflow,'hidden');assert.ok(state.inert);
 const after=await page.evaluate(()=>window.model.value.snapshot());assert.ok(close(before.position,after.position)&&close(before.target,after.target),'Fullscreen preserves current viewing focus');
 if(scenario.touch){
  const buttons=page.getByRole('button');assert.equal(await buttons.count(),1);assert.equal(await buttons.first().textContent(),'退出全屏');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'退出全屏');
  const session=await page.context().newCDPSession(page),x=state.w/2,y=state.h/2;
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+30,y:y+15}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const rotated=await page.evaluate(()=>window.model.value.snapshot());assert.ok(!close(rotated.position,after.position));assert.ok(close(rotated.target,after.target));
  await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-40,y,id:1},{x:x+40,y,id:2}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-40,y:y+20,id:1},{x:x+60,y:y+20,id:2}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const shifted=await page.evaluate(()=>window.model.value.snapshot());assert.ok(!close(shifted.target,rotated.target),'Two finger pan remains usable');assert.ok(!close(shifted.position,rotated.position));await session.detach();
 }else{assert.equal(await page.getByRole('group',{name:'移动三维视角'}).getByRole('button').count(),6);await page.getByRole('button',{name:'右移视角',exact:true}).click();}
 await page.screenshot({path:path.join(output,scenario.name+'.png')});
 await page.getByRole('button',{name:'退出全屏',exact:true}).click();await page.locator('.model-expanded').waitFor({state:'detached'});assert.equal(await page.evaluate(()=>document.fullscreenElement),null);assert.equal(await page.evaluate(()=>document.activeElement.textContent),'全屏查看');
 assert.deepEqual(await page.evaluate(()=>[document.body.style.overflow,document.documentElement.style.overflow,document.querySelector('#app').inert,document.querySelector('#already-inert').inert]),['','',false,true]);
 await page.getByRole('button',{name:'全屏查看',exact:true}).click();await page.getByRole('button',{name:'退出全屏',exact:true}).waitFor();
 if(!scenario.mode){await page.waitForFunction(()=>!!document.fullscreenElement);await page.evaluate(()=>document.exitFullscreen());}else await page.keyboard.press('Escape');
 await page.locator('.model-expanded').waitFor({state:'detached'});
 await page.getByRole('button',{name:'全屏查看',exact:true}).click();await page.getByRole('button',{name:'退出全屏',exact:true}).waitFor();await page.evaluate(()=>window.app.unmount());await page.waitForFunction(()=>!document.fullscreenElement&&!document.querySelector('.model-expanded'));
 assert.equal(await page.evaluate(()=>document.body.style.overflow),'');assert.deepEqual(errors,[]);results.push({...scenario,canvasFillsViewport:true,nativeFullscreen:!scenario.mode,gestures:true,cleanup:true});console.log('PASS',scenario.name);await page.close();
}await writeFile(path.join(output,'evidence.json'),JSON.stringify(results,null,2));}finally{await browser.close();await server.close();}
