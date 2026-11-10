import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
import {formatValue,dimensions} from '../src/statistics.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),base=process.env.MCM_QA_BASE_URL??'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname,'127.0.0.1');
const pet=process.argv.includes('--pet-restart'),special=process.argv.includes('--special');
const show=process.argv.includes('--show');
const prefix=pet?'native-pet-restart':special?'native-special-kill':'native-kill';
const game=JSON.parse(await readFile(path.join(root,`.tools/${prefix}-evidence.json`),'utf8')),algorithm=game.kills.algorithmVersion;
assert.equal(game.realGameplay,true);assert.equal(game.cleanGameStop,true);assert.equal(game.kills.probeOnly,undefined);
assert.deepEqual(game.kills.increments,{'kills.mobs':pet?1:8,'kills.players':pet||special?0:2});
if(pet){assert.equal(game.kills.ownerStayedOffline,true);assert.equal(game.kills.nativeBatchReplayDeduplicated,true);}
else if(special){assert.equal(game.kills.witherSourceOfflineRetained,true);assert.equal(game.kills.changedSourceRejected,true);assert.equal(game.kills.petOwnerOfflineRetained,true);assert.equal(game.kills.netherKillDimensionVerified,true);}else{assert.equal(game.kills.totemProtected,true);assert.equal(game.kills.respawnNewLife,true);}
const algorithms=['native-kill-source-v1','native-kill-source-v2','native-kill-source-v3'];
assert.ok(algorithms.includes(algorithm));
const cache=path.join(root,'.tools/game-qa-26.51.8/plugins/archive-collector/data/outbox/acknowledged');
const batches=await Promise.all((await readdir(cache)).filter(name=>name.endsWith('.pending')).map(async name=>JSON.parse(JSON.parse(await readFile(path.join(cache,name),'utf8')).body)));
const boot=pet?game.kills.bootId:batches.find(batch=>batch.events.some(event=>event.eventId===game.messageId))?.collector.bootId;assert.ok(boot);
const own=batches.filter(batch=>batch.collector.bootId===boot),keys=['kills.mobs','kills.players'],native=own.flatMap(batch=>batch.events).filter(event=>keys.includes(event.metric));
assert.equal(new Set(native.map(event=>event.eventId)).size,native.length);
for(const batch of own){assert.equal(batch.collector.version,game.nativeCollectorVersion??(algorithm==='native-kill-source-v2'?'0.15.0':'0.14.0'));for(const metric of keys)assert.ok(batch.capabilities.some(cap=>cap.metric===metric&&cap.state==='ACTIVE'&&cap.quality==='EXACT'&&cap.algorithmVersion===algorithm));}
for(const metric of keys){assert.equal(native.filter(event=>event.metric===metric).reduce((sum,event)=>sum+Number(event.value),0),game.kills.increments[metric]);const subjects=Object.fromEntries([...new Set(native.filter(event=>event.metric===metric).map(event=>event.subject))].map(subject=>[subject,native.filter(event=>event.metric===metric&&event.subject===subject).reduce((sum,event)=>sum+Number(event.value),0)]));assert.deepEqual(subjects,game.kills.originalNativeSubjects[metric]??{});}
const environment=Object.fromEntries((await readFile(path.join(root,'.env'),'utf8')).split(/\r?\n/).filter(line=>line.startsWith('MCM_')&&line.includes('=')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
const browser=await chromium.launch({headless:!show}),checks=[];
try {
  for(const width of show?[1440]:[1440,390,360]){
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base);await page.getByLabel('用户名',{exact:true}).fill(environment.MCM_ADMIN_USERNAME??'admin');await page.getByLabel('密码',{exact:true}).fill(environment.MCM_ADMIN_PASSWORD);await page.getByRole('button',{name:'进入工作台'}).click();await page.getByLabel('统计范围',{exact:true}).selectOption(game.serverId);
    const parameters={serverId:game.serverId,playerKey:game.playerKey},summary=await(await page.request.get(base+'/api/statistics/summary?'+new URLSearchParams(parameters))).json();
    assert.equal((await(await page.request.get(base+`/api/servers/${game.serverId}/collector-credential`)).json()).configured,false);
    await page.getByLabel('搜索玩家或服务器',{exact:true}).fill('ArchiveQA');await page.getByRole('button',{name:'搜索工作台'}).click();await page.locator('.search-result').filter({hasText:game.playerKey}).click();
    for(const key of keys){
      const metric=summary.metrics.find(metric=>metric.key===key);assert.equal(metric.value,game.kills.totals[key]);if((!special&&!pet)||key==='kills.mobs')assert.ok(metric.measurements.some(item=>item.quality==='EXACT'&&item.algorithmVersion===algorithm));
      const response=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/statistics/breakdown'&&url.searchParams.get('metric')===key&&response.status()===200;});await page.locator('.player-profile .behavior-options select').first().selectOption(key);await response;
      await expect(page.locator('.player-profile .data-note').filter({hasText:'无法可靠识别来源时不计入玩家击杀'})).toBeVisible();
      if(metric.measurements.some(item=>item.algorithmVersion==='native-kill-source-v1'))await expect(page.locator('.player-profile .data-note').filter({hasText:'旧版本可能漏记击杀者离线后的凋零结算和宠物击杀'})).toBeVisible();
      if(pet&&key==='kills.mobs')await expect(page.locator('.player-profile .data-note').filter({hasText:'宠物随世界保存的主人身份可跨游戏进程使用'})).toBeVisible();
      let index=1,total=0n,seen=0;
      while(true){
        const breakdown=await(await page.request.get(base+'/api/statistics/breakdown?'+new URLSearchParams({...parameters,metric:key,page:String(index)}))).json(),rows=page.locator('.player-profile [aria-label="行为分类明细"] tbody tr');await expect(rows).toHaveCount(breakdown.items.length);
        for(const [rowIndex,item] of breakdown.items.entries()){assert.equal(item.quality,'EXACT');assert.ok(algorithms.includes(item.algorithmVersion));const row=rows.nth(rowIndex);await expect(row.locator('td').first().locator('[data-game-id]')).toHaveAttribute('data-game-id', item.subject);await expect(row.locator('td').nth(1)).toHaveText(dimensions[item.dimension]??item.dimension);await expect(row.locator('td.numeric')).toHaveText(formatValue(item.value,metric.unit));await expect(row.locator('[data-algorithm]')).toHaveAttribute('data-algorithm', item.algorithmVersion);total+=BigInt(item.value);seen++;}
        if(index===1&&key===(special||pet?'kills.mobs':'kills.players')&&width===1440)await page.screenshot({path:path.join(root,`${pet?'.tools':'docs/design'}/${prefix}-player-live.png`),fullPage:true});
        if(seen===breakdown.total)break;assert.ok(seen<breakdown.total);index++;const next=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/statistics/breakdown'&&url.searchParams.get('metric')===key&&url.searchParams.get('page')===String(index)&&response.status()===200;});await page.locator('.player-profile .data-panel').getByRole('button',{name:'下一页'}).click();await next;
      }
      assert.equal(total.toString(),game.kills.totals[key]);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);checks.push({width,nativeKillSubjectsVerified:true,actualCumulativeTotalsMatch:true,allBreakdownPagesMatch:true,sourceAndExclusionDefinitionsVisible:true,collectorCredentialRevoked:true,noHorizontalOverflow:true,noPageErrors:true});
    if (show) {
      await page.locator('.player-profile .behavior-options select').first().selectOption('kills.mobs');
      await expect(page.locator('.player-profile [aria-label="行为分类明细"]')).toBeVisible();
      await page.locator('.player-profile .behavior-options').scrollIntoViewIfNeeded();
      await page.bringToFront();
      console.log(JSON.stringify({visible:true,loggedIn:true,player:'ArchiveQA',metric:'kills.mobs',url:page.url()}));
      await page.waitForEvent('close',{timeout:0});
    } else await page.close();
  }
  const evidence={verifiedAt:new Date().toISOString(),base,gameEvidenceAt:game.verifiedAt,nativeBootId:boot,originalNativeSubjects:game.kills.originalNativeSubjects,domainDataWritesPerformed:false,checks};if(!show)await writeFile(path.join(root,`.tools/${prefix}-browser-evidence.json`),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}finally{await browser.close();}
