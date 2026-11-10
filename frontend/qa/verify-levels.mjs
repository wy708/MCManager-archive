import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { formatInteger } from '../src/statistics.ts';

// Read the actual native-game result; never create telemetry for browser acceptance.
const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname, '127.0.0.1');
const game = JSON.parse(await readFile(path.join(root, '.tools/native-level-evidence.json'), 'utf8'));
assert.equal(game.realGameplay, true); assert.equal(game.levels.quality, 'OBSERVED');
const env = Object.fromEntries((await readFile(path.join(root, '.env'), 'utf8')).split(/\r?\n/).filter(line => line.startsWith('MCM_') && line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const browser = await chromium.launch(), checks = [];
try {
  for (const width of [1440,390,360]) {
    const page = await browser.newPage({ viewport: {width,height:1000} }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.getByLabel('用户名', {exact:true}).fill(env.MCM_ADMIN_USERNAME ?? 'admin');
    await page.getByLabel('密码', {exact:true}).fill(env.MCM_ADMIN_PASSWORD);
    await page.getByRole('button', {name:'进入工作台'}).click();
    await page.getByLabel('统计范围', {exact:true}).selectOption(game.serverId);
    const credentialResponse = await page.request.get(base+`/api/servers/${game.serverId}/collector-credential`);
    assert.equal(credentialResponse.status(),200);
    assert.equal((await credentialResponse.json()).configured,false,'The completed game fixture must revoke its collector credential');
    const response = await page.request.get(base+'/api/statistics/summary?'+new URLSearchParams({serverId:game.serverId,playerKey:game.playerKey}));
    assert.equal(response.status(),200); const summary = await response.json();
    const metric = summary.metrics.find(item => item.key === 'level.max');
    assert.equal(Number(metric.value),game.levels.higherPeak);
    assert.ok(metric.measurements.some(item => item.quality === 'OBSERVED' && item.algorithmVersion === game.levels.algorithmVersion));
    await page.getByLabel('搜索玩家或服务器', {exact:true}).fill('ArchiveQA');
    await page.getByRole('button', {name:'搜索工作台'}).click();
    await page.locator('.search-result').filter({hasText:game.playerKey}).click();
    await expect(page.locator('.player-profile h2').filter({hasText:'ArchiveQA'})).toBeVisible();
    const highest = page.locator('.summary-details dl > div').filter({has:page.locator('dt',{hasText:'已观测最高等级'})}).locator('dd');
    await expect(highest).toHaveText(formatInteger(metric.value));
    await expect(page.locator('.summary-details')).toContainText('跨服、跨日期不相加');
    await page.locator('.player-profile .behavior-options select').first().selectOption('level.max');
    const nativeRows = page.locator('.data-panel tbody tr').filter({hasText:game.levels.algorithmVersion});
    await expect(nativeRows).toHaveCount(2);
    await expect(nativeRows.filter({hasText:'主世界'})).toContainText(formatInteger(metric.value));
    await expect(nativeRows.filter({hasText:'下界'})).toContainText('2');
    for (const row of await nativeRows.all()) await expect(row.locator('.quality-badge')).toHaveText('已观测');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
    if (width===1440) await page.screenshot({path:path.join(root,'docs/design/native-level-player-live.png'),fullPage:true});
    checks.push({width,actualNativeMaximum:metric.value,playerProfileMatches:true,dimensionRowsMatch:true,observedQualityAndAlgorithmVisible:true,collectorCredentialRevoked:true,noHorizontalOverflow:true,noPageErrors:true});
    await page.close();
  }
  const evidence={verifiedAt:new Date().toISOString(),base,serverId:game.serverId,playerKey:game.playerKey,gameEvidenceAt:game.verifiedAt,domainDataWritesPerformed:false,checks};
  await writeFile(path.join(root,'.tools/native-level-browser-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally { await browser.close(); }
