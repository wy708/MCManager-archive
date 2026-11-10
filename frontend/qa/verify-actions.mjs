import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
import {formatValue,dimensions} from '../src/statistics.ts';

const root=fileURLToPath(new URL('../../',import.meta.url)),base=process.env.MCM_QA_BASE_URL??'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname,'127.0.0.1');
const game=JSON.parse(await readFile(path.join(root,'.tools/native-action-evidence.json'),'utf8'));
assert.equal(game.realGameplay,true);assert.equal(game.actions.algorithmVersion,'native-action-state-v1');
const env=Object.fromEntries((await readFile(path.join(root,'.env'),'utf8')).split(/\r?\n/).filter(line=>line.startsWith('MCM_')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
const browser=await chromium.launch(),checks=[];
try {
  for(const width of [1440,390,360]) {
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill(env.MCM_ADMIN_USERNAME??'admin');await page.getByLabel('密码',{exact:true}).fill(env.MCM_ADMIN_PASSWORD);await page.getByRole('button',{name:'进入工作台'}).click();
    await page.getByLabel('统计范围',{exact:true}).selectOption(game.serverId);
    const parameters={serverId:game.serverId,playerKey:game.playerKey};
    const response=await page.request.get(base+'/api/statistics/summary?'+new URLSearchParams(parameters));assert.equal(response.status(),200);const summary=await response.json();
    const credential=await page.request.get(base+`/api/servers/${game.serverId}/collector-credential`);assert.equal(credential.status(),200);assert.equal((await credential.json()).configured,false);
    await page.getByLabel('搜索玩家或服务器',{exact:true}).fill('ArchiveQA');await page.getByRole('button',{name:'搜索工作台'}).click();await page.locator('.search-result').filter({hasText:game.playerKey}).click();await expect(page.locator('.player-profile h2').filter({hasText:'ArchiveQA'})).toBeVisible();
    const metrics=[];
    for(const [key,total] of Object.entries(game.actions.totals)) {
      const metric=summary.metrics.find(item=>item.key===key);assert.equal(metric.value,total);
      const expected=await page.request.get(base+'/api/statistics/breakdown?'+new URLSearchParams({...parameters,metric:key}));assert.equal(expected.status(),200);const breakdown=await expected.json();
      const wait=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/statistics/breakdown'&&url.searchParams.get('metric')===key&&response.status()===200;});
      await page.locator('.player-profile .behavior-options select').first().selectOption(key);await wait;
      await expect(page.locator('.player-profile .data-note').filter({hasText:'重复开始输入不重复累计'})).toBeVisible();
      const rows=page.locator('.player-profile [aria-label="行为分类明细"] tbody tr');await expect(rows).toHaveCount(breakdown.items.length);
      assert.equal(breakdown.items.reduce((sum,item)=>sum+BigInt(item.value),0n).toString(),total);
      for(const item of breakdown.items) {
        const row=rows.filter({hasText:dimensions[item.dimension]??item.dimension}).filter({hasText:item.algorithmVersion});
        await expect(row.locator('td.numeric')).toHaveText(formatValue(item.value,metric.unit));await expect(row.locator('.quality-badge')).toHaveText('精确记录');
      }
      metrics.push(key);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    if(width===1440)await page.screenshot({path:path.join(root,'docs/design/native-action-player-live.png'),fullPage:true});
    checks.push({width,metrics,actualNativeTotalsMatch:true,breakdownSumsMatch:true,qualityAndAlgorithmVisible:true,collectorCredentialRevoked:true,noHorizontalOverflow:true,noPageErrors:true});await page.close();
  }
  const evidence={verifiedAt:new Date().toISOString(),base,serverId:game.serverId,playerKey:game.playerKey,gameEvidenceAt:game.verifiedAt,domainDataWritesPerformed:false,checks};await writeFile(path.join(root,'.tools/native-action-browser-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
} finally {await browser.close();}
