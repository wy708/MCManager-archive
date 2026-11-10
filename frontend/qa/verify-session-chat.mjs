import assert from 'node:assert/strict';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium, expect} from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088';
assert.equal(new URL(base).hostname, '127.0.0.1');
const show = process.argv.includes('--show');
const fixture = JSON.parse(await readFile(path.join(root, '.tools/native-special-kill-evidence.json'), 'utf8'));
assert.equal(fixture.realGameplay, true);
const cache = path.join(root, '.tools/game-qa-26.51.8/plugins/archive-collector/data/outbox/acknowledged');
const nativeChats = [];
for (const filename of (await readdir(cache)).filter(name => name.endsWith('.pending')).sort().reverse().slice(0,300)) {
  const batch = JSON.parse(JSON.parse(await readFile(path.join(cache,filename),'utf8')).body);
  nativeChats.push(...batch.events.filter(event =>
    event.kind === 'CHAT' && event.player.name === 'ArchiveQA' &&
    event.text.startsWith('原生玩家聊天验收 ')));
}
assert.ok(nativeChats.length, 'Native QA chat batches are required');
const env = Object.fromEntries((await readFile(path.join(root,'.env'),'utf8')).split(/\r?\n/)
  .filter(line => line.startsWith('MCM_') && line.includes('='))
  .map(line => {const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
const browser = await chromium.launch({headless:!show});
const checks = [];
try {
  for (const width of show ? [1440] : [1440,390,360]) {
    const page = await browser.newPage({viewport:{width,height:950}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.getByLabel('用户名',{exact:true}).fill(env.MCM_ADMIN_USERNAME ?? 'admin');
    await page.getByLabel('密码',{exact:true}).fill(env.MCM_ADMIN_PASSWORD);
    const authenticated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login');
    await page.getByRole('button',{name:'进入工作台'}).click();
    assert.equal((await authenticated).status(),204);
    await page.getByLabel('统计范围').selectOption(fixture.serverId);
    const params = new URLSearchParams({serverId:fixture.serverId,playerKey:fixture.playerKey});
    const response = await page.request.get(base+'/api/sessions?'+params);
    assert.equal(response.status(),200);
    const {items} = await response.json();
    const candidates = items.map(session => ({session, message:nativeChats.find(chat =>
      Date.parse(chat.at) >= Date.parse(session.startedAt) && Date.parse(chat.at) <= Date.parse(session.checkpointAt))}));
    const index = candidates.findIndex(candidate => candidate.message);
    assert.ok(index >= 0,'No native chat matched a stored session checkpoint window');
    const {session,message} = candidates[index];
    await page.getByLabel('搜索玩家或服务器',{exact:true}).fill('ArchiveQA');
    await page.getByRole('button',{name:'搜索工作台'}).click();
    await page.locator('.search-result').filter({hasText:fixture.playerKey}).click();
    await page.locator('.player-profile').getByRole('button',{name:'在线会话',exact:true}).click();
    const link = new URL(page.url());
    assert.equal(link.pathname,'/players/'+encodeURIComponent(fixture.playerKey));
    assert.equal(link.searchParams.get('server'),fixture.serverId);
    assert.equal(link.searchParams.get('tab'),'sessions');
    await page.reload();
    await expect(page.getByLabel('统计范围')).toHaveValue(fixture.serverId);
    await expect(page.locator('.player-profile').getByRole('button',{name:'在线会话',exact:true}))
      .toHaveAttribute('aria-pressed','true');
    const open = page.locator('.player-profile').getByRole('button',{name:'查看聊天',exact:true}).nth(index);
    const route = `/api/activity/sessions/${session.sessionId}/chat`;
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === route);
    await open.click();
    const chat = await pending;
    assert.equal(chat.status(),200);
    const payload = await chat.json();
    assert.equal(payload.messages.items.find(item => item.eventId === message.eventId)?.text,message.text);
    const dialog = page.getByRole('dialog',{name:'会话公开聊天'});
    await expect(dialog.getByText(message.text,{exact:true})).toBeVisible();
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth),true);
    assert.deepEqual(errors,[]);
    checks.push({width,sessionId:session.sessionId,nativeEventId:message.eventId,bodyMatched:true,noOverflow:true,playerSessionPathRestored:true});
    if (show) {
      await page.bringToFront();
      console.log(JSON.stringify({visible:true,loggedIn:true,view:'会话公开聊天',url:page.url()}));
      await page.waitForEvent('close',{timeout:0});
    } else await page.close();
  }
  if (!show) {
    const evidence = {verifiedAt:new Date().toISOString(),base,realGameplay:true,checks};
    await writeFile(path.join(root,'.tools/native-session-chat-browser-evidence.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence,null,2));
  }
} finally {await browser.close();}
