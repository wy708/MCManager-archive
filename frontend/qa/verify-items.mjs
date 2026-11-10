import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
import {formatValue,dimensions} from '../src/statistics.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),base=process.env.MCM_QA_BASE_URL??'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname,'127.0.0.1');
const game=JSON.parse(await readFile(path.join(root,'.tools/native-item-evidence.json'),'utf8'));
assert.equal(game.realGameplay,true);assert.equal(game.items.partialPickup,4);assert.equal(game.items.probeOnly,undefined);
const algorithms={'items.picked_up':'native-item-inventory-v1','items.use_requests':'native-item-request-v1'};
const cache=path.join(root,'.tools/game-qa-26.51.8/plugins/archive-collector/data/outbox/acknowledged');
const batches=await Promise.all((await readdir(cache)).filter(name=>name.endsWith('.pending')).map(async name=>JSON.parse(JSON.parse(await readFile(path.join(cache,name),'utf8')).body)));
const boot=batches.find(batch=>batch.events.some(event=>event.eventId===game.messageId))?.collector.bootId;assert.ok(boot);
const ownBatches=batches.filter(batch=>batch.collector.bootId===boot);
const actualItems=ownBatches.flatMap(batch=>batch.events).filter(event=>event.metric in algorithms);
const subjects=Object.fromEntries(Object.keys(algorithms).map(metric=>[metric,Object.fromEntries([...new Set(actualItems.filter(event=>event.metric===metric).map(event=>event.subject))].map(subject=>[subject,actualItems.filter(event=>event.metric===metric&&event.subject===subject).reduce((sum,event)=>sum+Number(event.value),0)]))]));
assert.deepEqual(subjects,{'items.picked_up':{'minecraft:diamond':22},'items.use_requests':{'minecraft:diamond':1,'minecraft:snowball':2,'minecraft:stone':2}});
assert.equal(new Set(actualItems.map(event=>event.eventId)).size,actualItems.length);
for(const batch of ownBatches)for(const [metric,algorithm] of Object.entries(algorithms))assert.ok(batch.capabilities.some(capability=>capability.metric===metric&&capability.quality==='EXACT'&&capability.algorithmVersion===algorithm));
const environment=Object.fromEntries((await readFile(path.join(root,'.env'),'utf8')).split(/\r?\n/).filter(line=>line.startsWith('MCM_')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
const browser=await chromium.launch(),checks=[];
try {
  for(const width of [1440,390,360]) {
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill(environment.MCM_ADMIN_USERNAME??'admin');await page.getByLabel('密码',{exact:true}).fill(environment.MCM_ADMIN_PASSWORD);await page.getByRole('button',{name:'进入工作台'}).click();
    await page.getByLabel('统计范围',{exact:true}).selectOption(game.serverId);
    const parameters={serverId:game.serverId,playerKey:game.playerKey};
    const summary=await(await page.request.get(base+'/api/statistics/summary?'+new URLSearchParams(parameters))).json();
    const confirmedUse=summary.metrics.find(metric=>metric.key==='items.used');assert.ok(confirmedUse.measurements.some(item=>item.quality==='EXACT'&&item.algorithmVersion==='native-item-confirmed-v2'));
    assert.equal((await(await page.request.get(base+`/api/servers/${game.serverId}/collector-credential`)).json()).configured,false);
    await page.getByLabel('搜索玩家或服务器',{exact:true}).fill('ArchiveQA');await page.getByRole('button',{name:'搜索工作台'}).click();await page.locator('.search-result').filter({hasText:game.playerKey}).click();await expect(page.locator('.player-profile h2').filter({hasText:'ArchiveQA'})).toBeVisible();
    for(const [key,total] of Object.entries(game.items.totals)) {
      const metric=summary.metrics.find(metric=>metric.key===key);assert.equal(metric.value,total);
      assert.ok(metric.measurements.some(item=>item.quality==='EXACT'&&item.algorithmVersion===algorithms[key]));
      const breakdown=await(await page.request.get(base+'/api/statistics/breakdown?'+new URLSearchParams({...parameters,metric:key}))).json();
      const response=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/statistics/breakdown'&&url.searchParams.get('metric')===key&&response.status()===200;});
      await page.locator('.player-profile .behavior-options select').first().selectOption(key);await response;
      await expect(page.locator('.player-profile .data-note').filter({hasText:key==='items.picked_up'?'部分拾取只计收入部分':'请求次数不等于成功使用'})).toBeVisible();
      const rows=page.locator('.player-profile [aria-label="行为分类明细"] tbody tr');await expect(rows).toHaveCount(breakdown.items.length);
      assert.equal(breakdown.items.reduce((sum,item)=>sum+BigInt(item.value),0n).toString(),total);
      for(const [index,item] of breakdown.items.entries()) {
        assert.equal(item.quality,'EXACT');assert.equal(item.algorithmVersion,algorithms[key]);
        const row=rows.nth(index);await expect(row.locator('td').first().locator('[data-game-id]')).toHaveAttribute('data-game-id', item.subject);await expect(row.locator('td').nth(1)).toHaveText(dimensions[item.dimension]??item.dimension);await expect(row.locator('td.numeric')).toHaveText(formatValue(item.value,metric.unit));await expect(row.locator('.quality-badge')).toHaveText('精确记录');await expect(row.locator('[data-algorithm]')).toHaveAttribute('data-algorithm', item.algorithmVersion);
      }
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    if(width===1440)await page.screenshot({path:path.join(root,'docs/design/native-item-player-live.png'),fullPage:true});
    checks.push({width,originalNativeTotalsMatch:true,itemAndDimensionBreakdownMatches:true,definitionsVisible:true,confirmedUsesAvailableSeparately:true,collectorCredentialRevoked:true,noHorizontalOverflow:true,noPageErrors:true});await page.close();
  }
  const evidence={verifiedAt:new Date().toISOString(),base,serverId:game.serverId,gameEvidenceAt:game.verifiedAt,nativeBootId:boot,originalNativeSubjects:subjects,nativeCapabilitiesVerified:true,domainDataWritesPerformed:false,checks};await writeFile(path.join(root,'.tools/native-item-browser-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
} finally {await browser.close();}
