import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { formatValue, dimensions } from '../src/statistics.ts'
const root = fileURLToPath(new URL('../../', import.meta.url)),
  base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088',
  key = 'breeding.offspring',
  algorithm = 'native-breeding-result-v1'
assert.equal(new URL(base).hostname, '127.0.0.1')
const game = JSON.parse(
  await readFile(path.join(root, '.tools/native-breeding-evidence.json'), 'utf8'),
)
assert.equal(game.realGameplay, true)
assert.equal(game.cleanGameStop, true)
assert.equal(game.breeding.probeOnly, undefined)
assert.equal(game.breeding.increments[key], 7)
assert.equal(game.breeding.ambiguousPlayersNotDuplicated, true)
assert.equal(game.breeding.offlineFeedingIdentityRetained, true)
assert.equal(game.breeding.netherChildDimensionVerified, true)
const cache = path.join(
    root,
    '.tools/game-qa-26.51.8/plugins/archive-collector/data/outbox/acknowledged',
  ),
  batches = await Promise.all(
    (await readdir(cache))
      .filter((name) => name.endsWith('.pending'))
      .map(async (name) =>
        JSON.parse(JSON.parse(await readFile(path.join(cache, name), 'utf8')).body),
      ),
  ),
  boot = batches.find((batch) => batch.events.some((event) => event.eventId === game.messageId))
    ?.collector.bootId
assert.ok(boot)
const own = batches.filter((batch) => batch.collector.bootId === boot),
  native = own.flatMap((batch) => batch.events).filter((event) => event.metric === key)
assert.equal(native.length, 7)
assert.equal(new Set(native.map((event) => event.eventId)).size, 7)
assert.equal(native.filter((event) => event.dimension === 'minecraft:nether').length, 1)
for (const batch of own) {
  assert.equal(batch.collector.version, game.nativeCollectorVersion ?? '0.16.0')
  assert.ok(
    batch.capabilities.some(
      (cap) =>
        cap.metric === key &&
        cap.state === 'ACTIVE' &&
        cap.quality === 'EXACT' &&
        cap.algorithmVersion === algorithm,
    ),
  )
}
const subjects = Object.fromEntries(
  [...new Set(native.map((event) => event.subject))].map((subject) => [
    subject,
    native
      .filter((event) => event.subject === subject)
      .reduce((sum, event) => sum + Number(event.value), 0),
  ]),
)
assert.deepEqual(subjects, game.breeding.originalNativeSubjects[key])
const environment = Object.fromEntries(
    (await readFile(path.join(root, '.env'), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.startsWith('MCM_') && line.includes('='))
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      }),
  ),
  browser = await chromium.launch(),
  checks = []
try {
  for (const width of [1440, 390, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }),
      errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base)
    await page.getByLabel('用户名', { exact: true }).fill(environment.MCM_ADMIN_USERNAME ?? 'admin')
    await page.getByLabel('密码', { exact: true }).fill(environment.MCM_ADMIN_PASSWORD)
    await page.getByRole('button', { name: '进入工作台' }).click()
    await page.getByLabel('统计范围', { exact: true }).selectOption(game.serverId)
    const parameters = { serverId: game.serverId, playerKey: game.playerKey },
      summary = await (
        await page.request.get(base + '/api/statistics/summary?' + new URLSearchParams(parameters))
      ).json(),
      metric = summary.metrics.find((metric) => metric.key === key)
    assert.equal(metric.value, game.breeding.totals[key])
    assert.ok(
      metric.measurements.some(
        (item) => item.quality === 'EXACT' && item.algorithmVersion === algorithm,
      ),
    )
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
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return (
        url.pathname === '/api/statistics/breakdown' &&
        url.searchParams.get('metric') === key &&
        response.status() === 200
      )
    })
    await page.locator('.player-profile .behavior-options select').first().selectOption(key)
    await response
    await expect(
      page.locator('.player-profile .data-note').filter({ hasText: '双亲须归属同一玩家' }),
    ).toBeVisible()
    await expect(
      page.locator('.player-profile .data-note').filter({ hasText: '仅怀孕或产卵不计' }),
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
      for (const [rowIndex, item] of breakdown.items.entries()) {
        assert.equal(item.quality, 'EXACT')
        assert.equal(item.algorithmVersion, algorithm)
        const row = rows.nth(rowIndex)
        await expect(row.locator('td').first().locator('[data-game-id]')).toHaveAttribute('data-game-id', item.subject)
        await expect(row.locator('td').nth(1)).toHaveText(
          dimensions[item.dimension] ?? item.dimension,
        )
        await expect(row.locator('td.numeric')).toHaveText(formatValue(item.value, metric.unit))
        await expect(row).toContainText(algorithm)
        total += BigInt(item.value)
        seen++
      }
      if (index === 1 && width === 1440)
        await page.screenshot({
          path: path.join(root, 'docs/design/native-breeding-player-live.png'),
          fullPage: true,
        })
      if (seen === breakdown.total) break
      assert.ok(seen < breakdown.total)
      index++
      const next = page.waitForResponse((response) => {
        const url = new URL(response.url())
        return (
          url.pathname === '/api/statistics/breakdown' &&
          url.searchParams.get('metric') === key &&
          url.searchParams.get('page') === String(index) &&
          response.status() === 200
        )
      })
      await page
        .locator('.player-profile .data-panel')
        .getByRole('button', { name: '下一页' })
        .click()
      await next
    }
    assert.equal(total.toString(), game.breeding.totals[key])
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    )
    assert.deepEqual(errors, [])
    checks.push({
      width,
      nativeBirthSubjectsVerified: true,
      actualCumulativeTotalsMatch: true,
      allBreakdownPagesMatch: true,
      attributionAndBirthDefinitionsVisible: true,
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
    originalNativeSubjects: game.breeding.originalNativeSubjects,
    domainDataWritesPerformed: false,
    checks,
  }
  await writeFile(
    path.join(root, '.tools/native-breeding-browser-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  )
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser.close()
}
