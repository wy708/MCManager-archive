import {createServer} from '../frontend/node_modules/vite/dist/node/index.js';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),server=await createServer({root:path.join(root,'frontend'),server:{host:'127.0.0.1',port:0},plugins:[{name:'map-fixture',configureServer(s){s.middlewares.use((req,res,next)=>{
 if(req.url==='/__map_test'){res.setHeader('content-type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:16px}.project-map{height:65vh;background:#dae6dc}</style><div id="app"></div><script type="module" src="/test-results/project-map-entry.ts"></script>`);return}
 if(req.url==='/__map_image'){res.setHeader('content-type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="800"><rect width="200" height="800" fill="#8dbd70"/><path d="M0 0H200V800H0Z" fill="none" stroke="#205d35" stroke-width="10"/><path d="M100 0V800M0 400H200" stroke="#367bb4" stroke-width="12"/></svg>');return}next();
 })}}]});
await mkdir(path.join(root,'frontend/test-results'),{recursive:true});
await writeFile(path.join(root,'frontend/test-results/project-map-entry.ts'),`import {createApp,h} from 'vue';import Map from '../src/components/ProjectMapView.vue';createApp({render:()=>h(Map,{url:'/__map_image',minX:-100,maxX:99,minZ:-400,maxZ:399})}).mount('#app');`);
await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({headless:true});
try{
 await mkdir(path.join(root,'frontend/test-results'),{recursive:true});
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width===390}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/__map_test');const img=page.locator('.leaflet-image-layer');await img.waitFor();await page.waitForFunction(()=>document.querySelector('.leaflet-image-layer')?.style.opacity==='1');
  const map=page.locator('.project-map'),frame=await map.boundingBox(),initial=await img.boundingBox();
  assert.ok(initial.x>=frame.x&&initial.y>=frame.y&&initial.x+initial.width<=frame.x+frame.width+1&&initial.y+initial.height<=frame.y+frame.height+1,'Initial view must contain the entire tall project');
  await page.getByTitle('放大地图',{exact:true}).click();await page.waitForTimeout(400);assert.ok((await img.boundingBox()).height>initial.height);
  await page.mouse.move(frame.x+frame.width/2,frame.y+frame.height/2);await page.mouse.wheel(0,-200);await page.waitForTimeout(400);const zoomed=await img.boundingBox();assert.ok(zoomed.height>initial.height*1.5);
  await page.mouse.move(frame.x+frame.width/2,frame.y+frame.height/2);await page.mouse.down();await page.mouse.move(frame.x+frame.width/2+60,frame.y+frame.height/2+50,{steps:12});await page.mouse.up();await page.waitForTimeout(400);assert.ok(Math.abs((await img.boundingBox()).x-zoomed.x)>20,'Drag must move map');
  await page.getByRole('button',{name:'全景',exact:true}).click();const fitted=await img.boundingBox();assert.ok(Math.abs(fitted.height-initial.height)<2);
  if(width===390){
   const session=await page.context().newCDPSession(page),cx=frame.x+frame.width/2,cy=frame.y+frame.height/2;
   await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx-20,y:cy,id:1},{x:cx+20,y:cy,id:2}]});
   for(let n=1;n<=8;n++)await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx-20-n*5,y:cy,id:1},{x:cx+20+n*5,y:cy,id:2}]});
   await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(400);assert.ok((await img.boundingBox()).height>initial.height*1.5,'Pinch must zoom on mobile');await page.getByRole('button',{name:'全景',exact:true}).click();
  }
  await page.screenshot({path:path.join(root,`frontend/test-results/project-map-controls-${width}.png`)});
  const prefs=await page.evaluate(async()=>{const p=await import('/src/projectViewPreferences.ts');p.saveHeight('a',{minY:10,maxY:90});p.saveHeight('b',{minY:-20,maxY:35});const a=p.readHeight('a'),b=p.readHeight('b');localStorage.setItem('mcmanager.project.b.height.v1','{"minY":"bad","maxY":40}');const invalid=p.readHeight('b');p.saveHeight('a',null);return {a,b,invalid,cleared:p.readHeight('a')}});
  assert.deepEqual(prefs,{a:{minY:10,maxY:90},b:{minY:-20,maxY:35},invalid:null,cleared:null});assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Project map pan/wheel/pinch/overview and per-project local preferences passed');
}finally{await browser.close();await server.close()}
