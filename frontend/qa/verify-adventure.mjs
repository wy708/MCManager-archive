import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { formatValue, formatInteger } from '../src/statistics.ts';

// Read-only UI acceptance against the existing isolated PostgreSQL deployment.
const project=fileURLToPath(new URL('../../',import.meta.url)),base=process.env.MCM_QA_BASE_URL??'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname,'127.0.0.1');
const environment=Object.fromEntries((await readFile(path.join(project,'.env'),'utf8')).split(/\r?\n/).filter(line=>line.startsWith('MCM_')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
const fixture=JSON.parse(await readFile(path.join(project,'.tools/game-qa-26.51.8/live-chat-fixture.json'),'utf8'));
const browser=await chromium.launch(),checks=[];
try{
  for(const viewport of[{width:1440,height:1000},{width:390,height:844},{width:360,height:640}]){
    const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await expect(page.getByRole('button',{name:'进入工作台'})).toBeEnabled();
    if(viewport.width===1440)await page.screenshot({path:path.join(project,'.tools/adventure-login-live.png')});
    await page.getByLabel('用户名',{exact:true}).fill(environment.MCM_ADMIN_USERNAME??'admin');await page.getByLabel('密码',{exact:true}).fill(environment.MCM_ADMIN_PASSWORD);await page.getByRole('button',{name:'进入工作台'}).click();
    await expect(page.getByRole('heading',{name:'数据总览',exact:true})).toBeVisible();await expect(page.locator('.adventure-hero')).toBeVisible();
    if(viewport.width===1440){
      await expect(page.locator('[data-overview-metric="backups"] strong')).not.toHaveText('加载中…');
      await page.setViewportSize({width:1586,height:992});await page.screenshot({path:path.join(project,'docs/design/reference-aligned-live.png')});
      const landscape=await page.locator('.sidebar-landscape').boundingBox(), header=await page.locator('.global-search').boundingBox(), avatar=await page.locator('.account-menu').boundingBox(), hero=await page.locator('.adventure-hero').boundingBox();
      assert.ok(landscape&&landscape.x<=1&&landscape.width>=256);assert.ok(header&&avatar&&header.x<avatar.x);
      assert.ok(hero&&hero.y===70&&hero.height>=354&&hero.height<356);
      const referenceLayout=await page.evaluate(()=>{
        const art=getComputedStyle(document.querySelector('.sidebar-landscape'),'::before');
        const face=getComputedStyle(document.querySelector('.reference-avatar'));
        return {headerHeight:document.querySelector('.reference-topbar').getBoundingClientRect().height,settingsTop:document.querySelector('.settings-nav').getBoundingClientRect().top,artSize:art.backgroundSize,artPosition:art.backgroundPosition,facePosition:face.backgroundPosition,originalArtwork:art.backgroundImage===face.backgroundImage};
      });
      assert.deepEqual(referenceLayout,{headerHeight:56,settingsTop:918,artSize:'1586px 992px',artPosition:'0px calc(100% + 75px)',facePosition:'-1457px -12px',originalArtwork:true});
      await expect(page.locator('.reference-avatar')).toBeVisible();await page.setViewportSize(viewport);
    }
    await page.getByLabel('统计范围',{exact:true}).selectOption(fixture.serverId);await expect(page.locator('[data-metric="blocks.mined"]')).toBeVisible();
    const response=await page.request.get(base+'/api/statistics/summary?serverId='+fixture.serverId);assert.equal(response.status(),200);const summary=await response.json();
    for(const key of['online.millis','blocks.mined','experience.gained']){
      const metric=summary.metrics.find(metric=>metric.key===key);assert.ok(metric);await expect(page.locator(`[data-metric="${key}"] strong`)).toHaveText(formatValue(metric.value,metric.unit));
    }
    const covered=summary.metrics.some(metric=>metric.coveredServers>0);await expect(page.locator('[data-metric="players"] strong')).toHaveText(covered?formatInteger(summary.playerCount):'未接入');
    const counts=await(await page.request.get(base+'/api/backups/summary?serverId='+fixture.serverId)).json();await expect(page.locator('[data-overview-metric="backups"] strong')).toHaveText(formatInteger(counts.readyCount));
    await page.locator('.account-menu summary').click();await expect(page.getByRole('button',{name:'退出登录'})).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'退出登录'})).not.toBeVisible();
    await expect(page.locator('.world-preview')).toHaveCount(1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const artUrl=await page.locator('.adventure-hero').evaluate(element=>getComputedStyle(element).backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1]);assert.ok(artUrl);const art=await page.request.get(artUrl);assert.equal(art.status(),200);assert.match(art.headers()['content-type'],/image\/jpeg/);
    await page.screenshot({path:path.join(project,`.tools/adventure-live-${viewport.width}.png`),fullPage:true});
    if(viewport.width===1440){await page.setViewportSize({width:1440,height:1200});await page.screenshot({path:path.join(project,'docs/design/adventure-dashboard-live.png')});await page.setViewportSize(viewport);}
    await page.locator('.world-preview').click();await expect(page.getByRole('heading',{name:'服务器档案',exact:true})).toBeVisible();await expect(page.locator('.server-card')).toHaveCount(1);await expect(page.locator('.archive-cover')).toBeVisible();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    checks.push({width:viewport.width,realServerId:fixture.serverId,metricsMatchBackend:true,readyBackupCountMatchesBackend:true,avatarMenuAndEscape:true,scopedArchiveNavigation:true,decorativeAssetServed:true,noHorizontalOverflow:true,noPageErrors:true});await page.close();
  }
  const evidence={verifiedAt:new Date().toISOString(),base,source:'existing-isolated-PostgreSQL-real-BDS-history',newGameplayPerformed:false,domainDataWritesPerformed:false,checks};
  await writeFile(path.join(project,'.tools/adventure-ui-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}finally{await browser.close();}
