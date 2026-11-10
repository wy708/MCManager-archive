import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { dimensions, formatValue } from '../src/statistics.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'
assert.equal(new URL(base).hostname, '127.0.0.1')
const read = async (name) => JSON.parse(await readFile(path.join(root, '.tools', name), 'utf8'))
const game = await read('native-movement-evidence.json')
const configured = await read('native-movement-threshold-evidence.json')
const keys = [
  'travel.walk_millimeters',
  'travel.swim_millimeters',
  'travel.fly_millimeters',
  'travel.glide_millimeters',
  'travel.vehicle_millimeters',
  'activity.millis',
]
for (const [run, seconds] of [
  [game, 300],
  [configured, 30],
]) {
  assert.equal(run.realGameplay, true)
  assert.equal(run.cleanGameStop, true)
  assert.equal(run.movement.probeOnly, undefined)
  assert.equal(run.movement.idleSeconds, seconds)
  assert.equal(
    run.movement.cutoff.configuredDeadline - Date.parse(run.movement.cutoff.chatAt),
    seconds * 1000,
  )
  assert.equal(run.movement.originalNativeSumsMatchMcp, true)
  assert.equal(run.movement.nativeBatchReplayDeduplicated, true)
  assert.equal(run.movement.coordinateFreeEvents, true)
  assert.equal(run.movement.cutoff.onlineContinued, true)
  assert.equal(run.movement.cutoff.cancelledUseIgnored, true)
  assert.equal(run.movement.cutoff.miningResumedActivity, true)
}
assert.equal(game.movement.cases.length, 10)
assert.equal(configured.movement.thresholdOnly, true)
for (const key of keys) assert.ok(BigInt(game.movement.increments[key]) > 0n)
assert.ok(game.movement.cases.some((item) => item.mode === 'walk' && item.before.dimension === 1))

const env = Object.fromEntries(
  (await readFile(path.join(root, '.env'), 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('MCM_') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
)
const browser = await chromium.launch()
const checks = []
try {
  for (const width of [1440, 390, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base)
    await page.getByLabel('用户名', { exact: true }).fill(env.MCM_ADMIN_USERNAME ?? 'admin')
    await page.getByLabel('密码', { exact: true }).fill(env.MCM_ADMIN_PASSWORD)
    await page.getByRole('button', { name: '进入工作台' }).click()
    await page.getByLabel('统计范围', { exact: true }).selectOption(game.serverId)
    const params = { serverId: game.serverId, playerKey: game.playerKey }
    const request = async (endpoint, query) => {
      const response = await page.request.get(base + endpoint + '?' + new URLSearchParams(query))
      assert.equal(response.status(), 200)
      return response.json()
    }
    const summary = await request('/api/statistics/summary', params)
    await page.getByLabel('搜索玩家或服务器', { exact: true }).fill('ArchiveQA')
    await page.getByRole('button', { name: '搜索工作台' }).click()
    await page.locator('.search-result').filter({ hasText: game.playerKey }).click()

    for (const key of keys) {
      const metric = summary.metrics.find((item) => item.key === key)
      assert.equal(metric.value, game.movement.totals[key])
      assert.ok(
        metric.measurements.some(
          (item) =>
            item.quality === 'ESTIMATED' && item.algorithmVersion === game.movement.versions[key],
        ),
      )
      const waitForBreakdown = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return (
          url.pathname === '/api/statistics/breakdown' &&
          url.searchParams.get('metric') === key &&
          response.ok()
        )
      })
      await page.locator('.player-profile .behavior-options select').first().selectOption(key)
      await waitForBreakdown
      const note = page.locator('.player-profile .data-note').filter({
        hasText: key === 'activity.millis' ? '所选记录采用的挂机阈值' : '服务端相邻位置的估算值',
      })
      await expect(note).toBeVisible()
      if (key === 'activity.millis') {
        assert.ok(
          metric.measurements.some(
            (item) => item.algorithmVersion === 'native-activity-idle-30s-v1',
          ),
        )
        await expect(note).toContainText('5 分钟')
        await expect(note).toContainText('30 秒')
      }
      const breakdown = await request('/api/statistics/breakdown', { ...params, metric: key })
      assert.equal(breakdown.total, breakdown.items.length)
      assert.equal(
        breakdown.items.reduce((sum, item) => sum + BigInt(item.value), 0n),
        BigInt(metric.value),
      )
      const rows = page.locator('.player-profile [aria-label="行为分类明细"] tbody tr')
      await expect(rows).toHaveCount(breakdown.items.length)
      for (const [index, item] of breakdown.items.entries()) {
        assert.equal(item.quality, 'ESTIMATED')
        const row = rows.nth(index)
        await expect(row.locator('td').first().locator('[data-game-id]')).toHaveAttribute('data-game-id', item.subject)
        await expect(row.locator('td').nth(1)).toHaveText(
          dimensions[item.dimension] ?? item.dimension,
        )
        await expect(row.locator('td.numeric')).toHaveText(formatValue(item.value, metric.unit))
        await expect(row.locator('[data-algorithm]')).toHaveAttribute('data-algorithm', item.algorithmVersion)
      }
      if (key === 'travel.walk_millimeters') {
        assert.ok(
          breakdown.items.some(
            (item) => item.dimension === 'minecraft:nether' && BigInt(item.value) > 0n,
          ),
        )
      }
    }
    await page.locator('.coverage-panel summary').click()
    await page.locator('.coverage-content select').selectOption('activity.millis')
    await expect(page.locator('.coverage-content tbody')).toContainText('挂机阈值 5 分钟')
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    )
    assert.deepEqual(errors, [])
    checks.push({
      width,
      sixEstimatedMetrics: true,
      bothThresholdsVisible: true,
      currentThresholdVisible: true,
      nativeDimensionRowsMatch: true,
    })
    await page.close()
  }
  const evidence = {
    verifiedAt: new Date().toISOString(),
    gameBoot: game.movement.bootId,
    configuredBoot: configured.movement.bootId,
    base,
    checks,
  }
  await writeFile(
    path.join(root, '.tools/native-movement-browser-evidence.json'),
    JSON.stringify(evidence, null, 2),
  )
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser.close()
}
