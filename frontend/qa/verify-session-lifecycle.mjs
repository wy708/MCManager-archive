import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { formatInteger, formatValue } from '../src/statistics.ts'

const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'
assert.equal(new URL(base).hostname, '127.0.0.1')
const evidence = JSON.parse(
  await readFile(
    new URL('../../.tools/native-session-lifecycle-evidence.json', import.meta.url),
    'utf8',
  ),
)
assert.equal(evidence.realGameplay, true)
assert.equal(evidence.cleanGameStop, true)
const { serverId, playerKey, sessionLifecycle } = evidence
const env = Object.fromEntries(
  (await readFile(new URL('../../.env', import.meta.url), 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('MCM_') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
)
const browser = await chromium.launch()
const checks = []
try {
  for (const width of [1440, 390, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base)
    await page.getByLabel('用户名', { exact: true }).fill(env.MCM_ADMIN_USERNAME ?? 'admin')
    await page.getByLabel('密码', { exact: true }).fill(env.MCM_ADMIN_PASSWORD)
    await page.getByRole('button', { name: '进入工作台' }).click()
    await page.getByLabel('统计范围', { exact: true }).selectOption(serverId)
    await page.getByLabel('搜索玩家或服务器', { exact: true }).fill('ArchiveQA')
    await page.getByRole('button', { name: '搜索工作台' }).click()
    await page.locator('.search-result').filter({ hasText: playerKey }).click()
    const profile = page.locator('.player-profile')
    const query = new URLSearchParams({ serverId, playerKey })
    const summaryResponse = await page.request.get(`${base}/api/statistics/summary?${query}`)
    assert.equal(summaryResponse.status(), 200)
    const summary = await summaryResponse.json()
    assert.equal(summary.confirmedJoinCount, sessionLifecycle.finalConfirmedJoinCount)
    for (const [label, count] of [
      ['已确认上线次数', summary.confirmedJoinCount],
      ['会话记录数', summary.sessionCount],
    ]) {
      await expect(
        profile.locator('.summary-details dl div').filter({ hasText: label }).locator('dd'),
      ).toHaveText(formatInteger(count))
    }
    await profile.getByRole('button', { name: '在线会话', exact: true }).click()
    const sessionsResponse = await page.request.get(`${base}/api/sessions?${query}`)
    assert.equal(sessionsResponse.status(), 200)
    const sessions = await sessionsResponse.json()
    assert.deepEqual(
      sessions.items.slice(0, 5).map((row) => row.sessionId),
      [...sessionLifecycle.sessionIds].reverse(),
    )
    const rows = profile.locator('[aria-label="在线会话明细"] tbody tr')
    await expect(rows).toHaveCount(sessions.items.length)
    for (const [index, session] of sessions.items.entries()) {
      const row = rows.nth(index)
      const reason =
        { JOIN: '确认进服', OBSERVED: '采集开始时已在线' }[session.startReason] ?? '旧版未区分'
      await expect(row).toContainText(reason)
      await expect(row.locator('td').nth(3)).toHaveText(formatValue(session.onlineMillis, 'ms'))
      if (session.endReason === 'CAPTURE_STOPPED') await expect(row).toContainText('采集停止')
    }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    )
    assert.deepEqual(errors, [])
    checks.push({ width, matchesApi: true, nativeSegmentsVisible: true })
    await page.close()
  }
  const result = {
    verifiedAt: new Date().toISOString(),
    sessionIds: sessionLifecycle.sessionIds,
    checks,
  }
  await writeFile(
    new URL('../../.tools/native-session-browser-evidence.json', import.meta.url),
    JSON.stringify(result, null, 2),
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
