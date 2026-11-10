import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
import {formatValue,dimensions} from '../src/statistics.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),base=process.env.MCM_QA_BASE_URL??'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname,'127.0.0.1');
const game=JSON.parse(await readFile(path.join(root,'.tools/native-completed-use-evidence.json'),'utf8'));
assert.equal(game.realGameplay,true);assert.equal(game.completedUses.successfulUses,12);assert.equal(game.completedUses.probeOnly,undefined);
const cache=path.join(root,'.tools/game-qa-26.51.8/plugins/archive-collector/data/outbox/acknowledged');
const batches=await Promise.all((await readdir(cache)).filter(name=>name.endsWith('.pending')).map(async name=>JSON.parse(JSON.parse(await readFile(path.join(cache,name),'utf8')).body)));
const boot=batches.find(batch=>batch.events.some(event=>event.eventId===game.messageId))?.collector.bootId;assert.ok(boot);
const ownBatches=batches.filter(batch=>batch.collector.bootId===boot),native=ownBatches.flatMap(batch=>batch.events).filter(event=>event.metric==='items.used');
assert.equal(native.length,12);assert.equal(new Set(native.map(event=>event.eventId)).size,12);
const subjects=Object.fromEntries([...new Set(native.map(event=>event.subject))].map(subject=>[subject,native.filter(event=>event.subject===subject).reduce((sum,event)=>sum+Number(event.value),0)]));
assert.deepEqual(subjects,{'minecraft:apple':2,'minecraft:snowball':2,'minecraft:stone':1,'minecraft:iron_hoe':2,'minecraft:bucket':1,'minecraft:water_bucket':1,'minecraft:iron_helmet':1,'minecraft:bow':2});
for(const batch of ownBatches)assert.ok(batch.capabilities.some(cap=>cap.metric==='items.used'&&cap.state==='ACTIVE'&&cap.quality==='EXACT'&&cap.algorithmVersion==='native-item-confirmed-v2'));
const environment=Object.fromEntries((await readFile(path.join(root,'.env'),'utf8')).split(/\r?\n/).filter(line=>line.startsWith('MCM_')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
const browser=await chromium.launch(),checks=[];
try {
  for(const width of [1440,390,360]) {
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill(environment.MCM_ADMIN_USERNAME??'admin');await page.getByLabel('密码',{exact:true}).fill(environment.MCM_ADMIN_PASSWORD);await page.getByRole('button',{name:'进入工作台'}).click();
    await page.getByLabel('统计范围',{exact:true}).selectOption(game.serverId);
    const parameters={serverId:game.serverId,playerKey:game.playerKey};
    const summary=await(await page.request.get(base+'/api/statistics/summary?'+new URLSearchParams(parameters))).json(),metric=summary.metrics.find(metric=>metric.key==='items.used');
    assert.equal(metric.value,game.completedUses.total);assert.ok(metric.measurements.some(item=>item.quality==='EXACT'&&item.algorithmVersion==='native-item-confirmed-v2'));
    assert.equal((await(await page.request.get(base+`/api/servers/${game.serverId}/collector-credential`)).json()).configured,false);
    await page.getByLabel('搜索玩家或服务器',{exact:true}).fill('ArchiveQA');await page.getByRole('button',{name:'搜索工作台'}).click();await page.locator('.search-result').filter({hasText:game.playerKey}).click();
    const response=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/statistics/breakdown'&&url.searchParams.get('metric')==='items.used'&&response.status()===200;});
    await page.locator('.player-profile .behavior-options select').first().selectOption('items.used');await response;
    await expect(page.locator('.player-profile .data-note').filter({hasText:'一次使用不等于消耗一个物品'})).toBeVisible();
    await expect(page.locator('.player-profile .data-note').filter({hasText:'旧版记录可能包含持物采浆果的误计'})).toBeVisible();
    let index=1,seen=0,total=0n;
    while(true) {
      const breakdown=await(await page.request.get(base+'/api/statistics/breakdown?'+new URLSearchParams({...parameters,metric:'items.used',page:String(index)}))).json();
      const rows=page.locator('.player-profile [aria-label="行为分类明细"] tbody tr');await expect(rows).toHaveCount(breakdown.items.length);
      for(const [rowIndex,item] of breakdown.items.entries()) {
        assert.equal(item.quality,'EXACT');assert.ok(['native-item-confirmed-v1','native-item-confirmed-v2'].includes(item.algorithmVersion));
        const row=rows.nth(rowIndex);await expect(row.locator('td').first().locator('[data-game-id]')).toHaveAttribute('data-game-id', item.subject);await expect(row.locator('td').nth(1)).toHaveText(dimensions[item.dimension]??item.dimension);await expect(row.locator('td.numeric')).toHaveText(formatValue(item.value,metric.unit));await expect(row.locator('.quality-badge')).toHaveText('精确记录');await expect(row.locator('[data-algorithm]')).toHaveAttribute('data-algorithm', item.algorithmVersion);seen++;total+=BigInt(item.value);
      }
      if(index===1&&width===1440)await page.screenshot({path:path.join(root,'docs/design/native-confirmed-use-player-live.png'),fullPage:true});
      if(seen===breakdown.total)break;assert.ok(seen<breakdown.total);index++;
      const next=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/statistics/breakdown'&&url.searchParams.get('metric')==='items.used'&&url.searchParams.get('page')===String(index)&&response.status()===200;});await page.locator('.player-profile .data-panel').getByRole('button',{name:'下一页'}).click();await next;
    }
    assert.equal(total.toString(),game.completedUses.total);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    checks.push({width,gameNativeSubjectsVerified:true,actualCumulativeTotalMatches:true,itemAndDimensionBreakdownMatches:true,qualityAndAlgorithmMatch:true,definitionsVisible:true,collectorCredentialRevoked:true,noHorizontalOverflow:true,noPageErrors:true});await page.close();
  }
  const evidence={verifiedAt:new Date().toISOString(),base,gameEvidenceAt:game.verifiedAt,nativeBootId:boot,originalNativeSubjects:subjects,domainDataWritesPerformed:false,checks};await writeFile(path.join(root,'.tools/native-completed-use-browser-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}finally{await browser.close();}
