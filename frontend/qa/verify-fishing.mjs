import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { formatValue, dimensions } from '../src/statistics.ts'
const root = fileURLToPath(new URL('../../', import.meta.url)),
  base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088',
  algorithm = 'native-fishing-result-v1',
  keys = [
    'fishing.retrievals',
    'fishing.item_pull_events',
    'fishing.items_pulled',
    'fishing.catch_events',
    'fishing.catches',
  ]
assert.equal(new URL(base).hostname, '127.0.0.1')
const game = JSON.parse(
  await readFile(path.join(root, '.tools/native-fishing-evidence.json'), 'utf8'),
)
assert.equal(game.realGameplay, true)
assert.equal(game.cleanGameStop, true)
assert.equal(game.fishing.probeOnly, undefined)
assert.equal(game.fishing.naturalBiteVerified, true)
assert.equal(game.fishing.oldFishingItemExcluded, true)
assert.equal(game.fishing.naturallyCreatedItemRehooked, true)
assert.equal(game.fishing.quantityFixtureVerified, true)
assert.equal(game.fishing.cancellationsVerified, true)
assert.equal(game.fishing.netherDimensionVerified, true)
assert.equal(game.fishing.cases.length, 21)
const nativeLog = await readFile(
  path.join(root, '.tools/native-fishing-game-native-final.log'),
  'utf8',
)
const diagnostic = nativeLog.match(
  /Fishing diagnostics: (\d+) admitted, 0 pending, 0 lost; retrievals=(\d+) itemPulls=(\d+) catches=(\d+) capacityGaps=0/,
)
assert.ok(diagnostic)
assert.equal(Number(diagnostic[1]), game.fishing.nativeEventCount)
assert.equal(Number(diagnostic[2]), game.fishing.increments['fishing.retrievals'])
assert.equal(Number(diagnostic[3]), game.fishing.increments['fishing.item_pull_events'])
assert.equal(Number(diagnostic[4]), game.fishing.increments['fishing.catch_events'])
assert.match(nativeLog, /Quit correctly/)
assert.ok(game.fishing.increments['fishing.retrievals'] > 0)
assert.ok(
  game.fishing.increments['fishing.catches'] > game.fishing.increments['fishing.catch_events'],
)
const cache = path.join(
    root,
    '.tools/game-qa-26.51.8/plugins/archive-collector/data/outbox/acknowledged',
  ),
  batches = await Promise.all(
    (await readdir(cache))
      .filter((n) => n.endsWith('.pending'))
      .map(async (n) => JSON.parse(JSON.parse(await readFile(path.join(cache, n), 'utf8')).body)),
  ),
  boot = batches.find((b) => b.events.some((e) => e.eventId === game.messageId))?.collector.bootId
assert.ok(boot)
const own = batches.filter((b) => b.collector.bootId === boot),
  native = own.flatMap((b) => b.events).filter((e) => keys.includes(e.metric))
assert.equal(new Set(native.map((e) => e.eventId)).size, native.length)
for (const key of keys) {
  assert.equal(
    native.filter((e) => e.metric === key).reduce((s, e) => s + Number(e.value), 0),
    game.fishing.increments[key],
  )
  for (const b of own) {
    assert.equal(b.collector.version, game.nativeCollectorVersion)
    assert.ok(
      b.capabilities.some(
        (c) =>
          c.metric === key &&
          c.state === 'ACTIVE' &&
          c.quality === 'EXACT' &&
          c.algorithmVersion === algorithm,
      ),
    )
  }
}
const subjects = Object.fromEntries(
  keys.map((key) => [
    key,
    Object.fromEntries(
      [...new Set(native.filter((e) => e.metric === key).map((e) => e.subject))].map((subject) => [
        subject,
        native
          .filter((e) => e.metric === key && e.subject === subject)
          .reduce((s, e) => s + Number(e.value), 0),
      ]),
    ),
  ]),
)
assert.deepEqual(subjects, game.fishing.originalNativeSubjects)
const env = Object.fromEntries(
    (await readFile(path.join(root, '.env'), 'utf8'))
      .split(/\r?\n/)
      .filter((l) => l.startsWith('MCM_') && l.includes('='))
      .map((l) => {
        const at = l.indexOf('=')
        return [l.slice(0, at), l.slice(at + 1)]
      }),
  ),
  browser = await chromium.launch(),
  checks = []
try {
  for (const width of [1440, 390, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }),
      errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(base)
    await page.getByLabel('用户名', { exact: true }).fill(env.MCM_ADMIN_USERNAME ?? 'admin')
    await page.getByLabel('密码', { exact: true }).fill(env.MCM_ADMIN_PASSWORD)
    await page.getByRole('button', { name: '进入工作台' }).click()
    await page.getByLabel('统计范围', { exact: true }).selectOption(game.serverId)
    const parameters = { serverId: game.serverId, playerKey: game.playerKey },
      summary = await (
        await page.request.get(base + '/api/statistics/summary?' + new URLSearchParams(parameters))
      ).json()
    assert.equal(
      (
        await (
          await page.request.get(base + `/api/servers/${game.serverId}/collector-credential`)
        ).json()
      ).configured,
      false,
    )
    await page.getByLabel('搜索玩家或服务器', { exact: true }).fill('ArchiveQA')
    await page.getByRole('button', { name: '搜索工作台' }).click()
    await page.locator('.search-result').filter({ hasText: game.playerKey }).click()
    for (const key of keys) {
      const metric = summary.metrics.find((m) => m.key === key)
      assert.equal(metric.value, game.fishing.totals[key])
      assert.ok(
        metric.measurements.some((m) => m.quality === 'EXACT' && m.algorithmVersion === algorithm),
      )
      const response = page.waitForResponse((r) => {
        const u = new URL(r.url())
        return (
          u.pathname === '/api/statistics/breakdown' &&
          u.searchParams.get('metric') === key &&
          r.status() === 200
        )
      })
      await page.locator('.player-profile .behavior-options select').first().selectOption(key)
      await response
      await expect(
        page.locator('.player-profile .data-note').filter({ hasText: '收竿按服务器实际完成' }),
      ).toBeVisible()
      await expect(
        page
          .locator('.player-profile .data-note')
          .filter({ hasText: '操作次数与物品数量分别累计' }),
      ).toBeVisible()
      let index = 1,
        total = 0n,
        seen = 0
      while (true) {
        const breakdown = await (
            await page.request.get(
              base +
                '/api/statistics/breakdown?' +
                new URLSearchParams({ ...parameters, metric: key, page: String(index) }),
            )
          ).json(),
          rows = page.locator('.player-profile [aria-label="行为分类明细"] tbody tr')
        await expect(rows).toHaveCount(breakdown.items.length)
        for (const [i, item] of breakdown.items.entries()) {
          assert.equal(item.quality, 'EXACT')
          assert.equal(item.algorithmVersion, algorithm)
          const row = rows.nth(i)
          await expect(row.locator('td').first().locator('[data-game-id]')).toHaveAttribute('data-game-id', item.subject)
          await expect(row.locator('td').nth(1)).toHaveText(
            dimensions[item.dimension] ?? item.dimension,
          )
          await expect(row.locator('td.numeric')).toHaveText(formatValue(item.value, metric.unit))
          await expect(row).toContainText(algorithm)
          total += BigInt(item.value)
          seen++
        }
        if (index === 1 && width === 1440 && key === 'fishing.catches')
          await page.screenshot({
            path: path.join(root, 'docs/design/native-fishing-player-live.png'),
            fullPage: true,
          })
        if (seen === breakdown.total) break
        assert.ok(seen < breakdown.total)
        index++
        const next = page.waitForResponse((r) => {
          const u = new URL(r.url())
          return (
            u.pathname === '/api/statistics/breakdown' &&
            u.searchParams.get('metric') === key &&
            u.searchParams.get('page') === String(index) &&
            r.status() === 200
          )
        })
        await page
          .locator('.player-profile .data-panel')
          .getByRole('button', { name: '下一页' })
          .click()
        await next
      }
      assert.equal(total.toString(), game.fishing.totals[key])
    }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    )
    assert.deepEqual(errors, [])
    checks.push({
      width,
      actualNativeFishingVerified: true,
      fishingOperationsAndItemsSeparated: true,
      allBreakdownPagesMatch: true,
      commitDefinitionsVisible: true,
      collectorCredentialRevoked: true,
      noHorizontalOverflow: true,
      noPageErrors: true,
    })
    await page.close()
  }
  const evidence = {
    verifiedAt: new Date().toISOString(),
    base,
    gameEvidenceAt: game.verifiedAt,
    nativeBootId: boot,
    originalNativeSubjects: subjects,
    domainDataWritesPerformed: false,
    checks,
  }
  await writeFile(
    path.join(root, '.tools/native-fishing-browser-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  )
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser.close()
}
