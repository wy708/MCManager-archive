import {createServer} from '../frontend/node_modules/vite/dist/node/index.js';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';
import {mkdir,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';import path from 'node:path';
const out=path.resolve('.tools/chart-spacing',String(Date.now()));await mkdir(out,{recursive:true});
const server=await createServer({root:path.resolve('frontend'),plugins:[{name:'chart-spacing-qa',configureServer(s){s.middlewares.use((req,res,next)=>{
 if(req.url!=='/__charts')return next();res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app" style="max-width:1200px;margin:20px auto;padding:16px"></div><script type="module">
 import {createApp,h} from '/node_modules/.vite/deps/vue.js';import World from '/src/components/WorldInsights.vue';import Daily from '/src/components/DailyReportsView.vue';import '/src/style.css';import '/src/statistics.css';import '/src/adventure.css';import '/src/reference.css';
 const metrics=[['blocks.mined',18500,'blocks'],['blocks.placed',10700,'blocks'],['crops.harvested',700,'blocks'],['crops.planted',1400,'blocks'],['travel.walk.mm',100000000,'mm'],['travel.swim.mm',8000000,'mm'],['travel.fly.mm',500000,'mm'],['travel.glide.mm',19000000,'mm']].map(([key,value,unit])=>({key,label:key,value:String(value),unit,aggregation:'SUM',coveredServers:1,selectedServers:1,measurements:[]}));
 createApp({render:()=>h('div',[h(World,{points:[],dimensionPoints:[],summary:{metrics}}),h(Daily,{scope:'qa',servers:[]})])}).mount('#app');</script>`);
 });}}],server:{host:'127.0.0.1',port:0}});await server.listen();const browser=await chromium.launch({headless:true});
const results=[];
try{for(const width of [2560,1440,390]){
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/servers/qa/daily-report',r=>r.fulfill({json:{serverName:'验收服',date:'2026-11-08',timezone:'UTC+8',recordedPlayers:4,totals:[],materials:[],projects:[],notice:'图表布局测试',trend:[6,7,8].flatMap((d,i)=>['blocks.placed','blocks.mined'].map((metric,m)=>({date:'2026-11-0'+d,metric,value:String([0,4200,800][i]+m*100)})))}}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__charts`);await page.getByRole('img',{name:'七天放置与挖掘趋势'}).locator('svg').waitFor();await page.waitForTimeout(700);
 for(const label of ['挖掘、放置和作物方块数量','不同移动方式的距离，单位米']){
  const positions=await page.getByRole('img',{name:label,exact:true}).locator('svg text').evaluateAll(nodes=>nodes.filter(n=>/^\d+(\.\d+)?[千万亿]?$/.test(n.textContent)).map(n=>({text:n.textContent,x:n.getBoundingClientRect().x,y:n.getBoundingClientRect().y,w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height})));
  assert.ok(positions.length>=2);for(let i=0;i<positions.length;i++)for(let j=i+1;j<positions.length;j++){const a=positions[i],b=positions[j];assert.ok(a.x+a.w<=b.x+1||b.x+b.w<=a.x+1||a.y+a.h<=b.y+1||b.y+b.h<=a.y+1,`${width}: axis labels overlap ${a.text}/${b.text}`);}
 }
 const labels=await page.getByRole('img',{name:'七天放置与挖掘趋势'}).locator('svg text').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom})));
 const legends=labels.filter(n=>['放置方块','挖掘方块'].includes(n.text)),dates=labels.filter(n=>/^11-0[678]$/.test(n.text));assert.equal(legends.length,2);assert.ok(dates.length>=2);assert.ok(Math.max(...legends.map(n=>n.bottom))<Math.min(...dates.map(n=>n.top)));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,`charts-${width}.png`),fullPage:true});results.push({width,noTickCollisions:true,legendSeparated:true});await page.close();
}await writeFile(path.join(out,'verification.json'),JSON.stringify(results,null,2));console.log('PASS chart label spacing:',out);
}finally{await browser.close();await server.close();}
