import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
import {formatValue,dimensions} from '../src/statistics.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),base=process.env.MCM_QA_BASE_URL??'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname,'127.0.0.1');
const game=JSON.parse(await readFile(path.join(root,'.tools/native-crop-evidence.json'),'utf8'));
assert.equal(game.realGameplay,true);assert.equal(game.crops.probeOnly,undefined);
assert.deepEqual(Object.fromEntries(Object.entries(game.crops.increments).filter(([key])=>key.startsWith('crops.'))),{'crops.planted':13,'crops.harvested':18,'crops.interacted':4});
const cache=path.join(root,'.tools/game-qa-26.51.8/plugins/archive-collector/data/outbox/acknowledged');
const batches=await Promise.all((await readdir(cache)).filter(name=>name.endsWith('.pending')).map(async name=>JSON.parse(JSON.parse(await readFile(path.join(cache,name),'utf8')).body)));
const boot=batches.find(batch=>batch.events.some(event=>event.eventId===game.messageId))?.collector.bootId;assert.ok(boot);
const own=batches.filter(batch=>batch.collector.bootId===boot),keys=['crops.planted','crops.harvested','crops.interacted'];
const native=own.flatMap(batch=>batch.events).filter(event=>keys.includes(event.metric));assert.equal(new Set(native.map(event=>event.eventId)).size,native.length);
const used=own.flatMap(batch=>batch.events).filter(event=>event.metric==='items.used');assert.equal(used.some(event=>event.subject==='minecraft:diamond'),false);assert.equal(used.reduce((sum,event)=>sum+Number(event.value),0),14);
for(const batch of own){assert.equal(batch.collector.version,'0.13.0');for(const metric of keys)assert.ok(batch.capabilities.some(cap=>cap.metric===metric&&cap.state==='ACTIVE'&&cap.quality==='EXACT'&&cap.algorithmVersion==='native-crop-state-v1'));}
for(const metric of keys){assert.equal(native.filter(event=>event.metric===metric).reduce((sum,event)=>sum+Number(event.value),0),game.crops.increments[metric]);const subjects=Object.fromEntries([...new Set(native.filter(event=>event.metric===metric).map(event=>event.subject))].map(subject=>[subject,native.filter(event=>event.metric===metric&&event.subject===subject).reduce((sum,event)=>sum+Number(event.value),0)]));assert.deepEqual(subjects,game.crops.originalNativeSubjects[metric]);}
const environment=Object.fromEntries((await readFile(path.join(root,'.env'),'utf8')).split(/\r?\n/).filter(line=>line.startsWith('MCM_')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
const browser=await chromium.launch(),checks=[];
try {
  for(const width of [1440,390,360]) {
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill(environment.MCM_ADMIN_USERNAME??'admin');await page.getByLabel('密码',{exact:true}).fill(environment.MCM_ADMIN_PASSWORD);await page.getByRole('button',{name:'进入工作台'}).click();await page.getByLabel('统计范围',{exact:true}).selectOption(game.serverId);
    const parameters={serverId:game.serverId,playerKey:game.playerKey},summary=await(await page.request.get(base+'/api/statistics/summary?'+new URLSearchParams(parameters))).json();
    assert.equal((await(await page.request.get(base+`/api/servers/${game.serverId}/collector-credential`)).json()).configured,false);
    await page.getByLabel('搜索玩家或服务器',{exact:true}).fill('ArchiveQA');await page.getByRole('button',{name:'搜索工作台'}).click();await page.locator('.search-result').filter({hasText:game.playerKey}).click();
    for(const key of [...keys,'blocks.mined']) {
      const metric=summary.metrics.find(metric=>metric.key===key);assert.equal(metric.value,game.crops.totals[key]);const algorithm=key==='blocks.mined'?'native-mining-v2':'native-crop-state-v1';assert.ok(metric.measurements.some(item=>item.quality==='EXACT'&&item.algorithmVersion===algorithm));
      const response=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/statistics/breakdown'&&url.searchParams.get('metric')===key&&response.status()===200;});
      await page.locator('.player-profile .behavior-options select').first().selectOption(key);await response;
      const note={'crops.planted':'实际形成的新作物','crops.harvested':'这是采收方块数，不是掉落物数量','crops.interacted':'实际采收后状态改变','blocks.mined':'已确认同时消失的配对半格'}[key];await expect(page.locator('.player-profile .data-note').filter({hasText:note})).toBeVisible();
      let index=1,total=0n,seen=0;
      while(true){const breakdown=await(await page.request.get(base+'/api/statistics/breakdown?'+new URLSearchParams({...parameters,metric:key,page:String(index)}))).json();const rows=page.locator('.player-profile [aria-label="行为分类明细"] tbody tr');await expect(rows).toHaveCount(breakdown.items.length);
        for(const [rowIndex,item] of breakdown.items.entries()){assert.equal(item.quality,'EXACT');assert.ok(key==='blocks.mined'?['native-v1',algorithm].includes(item.algorithmVersion):item.algorithmVersion===algorithm);const row=rows.nth(rowIndex);await expect(row.locator('td').first().locator('[data-game-id]')).toHaveAttribute('data-game-id', item.subject);await expect(row.locator('td').nth(1)).toHaveText(dimensions[item.dimension]??item.dimension);await expect(row.locator('td.numeric')).toHaveText(formatValue(item.value,metric.unit));await expect(row.locator('[data-algorithm]')).toHaveAttribute('data-algorithm', item.algorithmVersion);total+=BigInt(item.value);seen++;}
        if(index===1&&key==='crops.harvested'&&width===1440)await page.screenshot({path:path.join(root,'docs/design/native-crop-player-live.png'),fullPage:true});
        if(seen===breakdown.total)break;assert.ok(seen<breakdown.total);index++;const next=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/statistics/breakdown'&&url.searchParams.get('metric')===key&&url.searchParams.get('page')===String(index)&&response.status()===200;});await page.locator('.player-profile .data-panel').getByRole('button',{name:'下一页'}).click();await next;
      }
      assert.equal(total.toString(),game.crops.totals[key]);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);checks.push({width,originalNativeCropsVerified:true,actualCumulativeTotalsMatch:true,allBreakdownPagesMatch:true,maturityAndQuantityDefinitionsVisible:true,collectorCredentialRevoked:true,noHorizontalOverflow:true,noPageErrors:true});await page.close();
  }
  const evidence={verifiedAt:new Date().toISOString(),base,gameEvidenceAt:game.verifiedAt,nativeBootId:boot,originalNativeSubjects:game.crops.originalNativeSubjects,domainDataWritesPerformed:false,checks};await writeFile(path.join(root,'.tools/native-crop-browser-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}finally{await browser.close();}
