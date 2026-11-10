import {createServer} from '../frontend/node_modules/vite/dist/node/index.js';
import {chromium} from '../frontend/node_modules/playwright/index.mjs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function verifyProjectScenePage(backend,id,cookies){
  const root=process.cwd();
  const server=await createServer({root:path.join(root,'frontend'),server:{host:'127.0.0.1',port:0,strictPort:false,proxy:{'/api':backend}}});
  await server.listen();const base=`http://127.0.0.1:${server.httpServer.address().port}`,browser=await chromium.launch({headless:true});
  try{
    await mkdir(path.join(root,'frontend/test-results'),{recursive:true});
    for(const width of [1440,390]){
      const page=await browser.newPage({viewport:{width,height:width===390?844:1050}}),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(base+`/projects/${id}#model`);
      await page.getByText(/已显示 [\d,]+ 个模型面片/).waitFor({timeout:60000});
      assert.equal(await page.locator('.model-canvas canvas').count(),1);
      const warnings=await page.locator('.project-model details.project-error li').allTextContents();assert.ok(warnings.every(w=>w==='部分区域尚无群系记录，植物与水面采用默认配色'));
      const toggle=page.getByRole('checkbox',{name:'显示动物和怪物'});assert.equal(await toggle.isChecked(),false);
      const sceneRequests=[];page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/scene.json'))sceneRequests.push(request.url())});
      await toggle.check();assert.equal(await toggle.isChecked(),true);
      await toggle.uncheck();assert.equal(await toggle.isChecked(),false);assert.deepEqual(sceneRequests,[],'Visibility toggle must not fetch or rebuild the scene');
      await page.screenshot({path:path.join(root,`frontend/test-results/project-scene-${width}.png`),fullPage:true});
      // Roof cutaway reveals the already captured interior rather than requesting a simplified model.
      await page.getByLabel('最高显示高度 Y').fill('102');
      await page.getByRole('button',{name:'查看这一层',exact:true}).click();
      await page.locator('.model-canvas').screenshot({path:path.join(root,`frontend/test-results/project-scene-interior-${width}.png`)});
      await page.reload();
      await page.getByText(/已显示 [\d,]+ 个模型面片/).waitFor({timeout:60000});
      assert.equal(await page.getByLabel('最高显示高度 Y').inputValue(),'102');
      assert.equal(await page.evaluate(id=>JSON.parse(localStorage.getItem(`mcmanager.project.${id}.height.v1`)).maxY,id),102);
      await page.getByRole('button',{name:'全屏查看',exact:true}).click();
      assert.equal(await page.locator('.model-expanded').count(),1);
      await page.keyboard.press('Escape');await page.locator('.model-expanded').waitFor({state:'detached'});
      await page.getByRole('button',{name:'显示全部模型',exact:true}).click();
      assert.ok(await page.evaluate(id=>JSON.parse(localStorage.getItem(`mcmanager.project.${id}.height.v1`)),id),'Explicit all-height selection must persist');
      assert.equal(await page.getByRole('button',{name:'导出 3D 模型',exact:true}).count(),0);

      assert.deepEqual(errors,[]);await page.close();
    }
    if(cookies){
      const context=await browser.newContext({acceptDownloads:true});
      await context.addCookies([...cookies].map(([name,value])=>({name,value,domain:'127.0.0.1',path:'/'})));
      const page=await context.newPage();await page.goto(base+'/projects');
      const card=page.locator('.project-card').filter({has:page.getByRole('heading',{name:'ModelQA',exact:true})});
      await card.getByRole('button',{name:'导出 3D 模型',exact:true}).click();
      const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'下载 GLB 模型',exact:true}).click();
      const download=await downloadEvent;assert.equal(await download.failure(),null);assert.match(download.suggestedFilename(),/\.glb$/);
      await download.saveAs(path.join(root,'frontend/test-results/admin-project-export.glb'));
      await page.screenshot({path:path.join(root,'frontend/test-results/admin-project-export.png'),fullPage:true});await context.close();
    }
  }finally{await browser.close();await server.close();}
}
