import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { formatValue } from '../src/statistics.ts'

const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'
assert.equal(new URL(base).hostname, '127.0.0.1')
const evidence = JSON.parse(
  await readFile(
    new URL('../../.tools/native-player-identity-evidence.json', import.meta.url),
    'utf8',
  ),
)
assert.equal(evidence.realGameplay, true)
assert.equal(evidence.isolatedWorlds, true)
const { first, second, sameName, firstName, currentName, playerKey, otherKey, total, day } =
  evidence
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
    const scope = page.getByLabel('统计范围', { exact: true })
    await scope.selectOption(first.id)
    await expect(page.locator('[data-overview-metric="players"] strong')).toHaveText('1')
    await scope.selectOption(second.id)
    await expect(page.locator('[data-overview-metric="players"] strong')).toHaveText('2')
    await scope.selectOption('all')
    const globalSearch = page.getByLabel('搜索玩家或服务器', { exact: true })
    await globalSearch.fill(firstName)
    await page.getByRole('button', { name: '搜索工作台' }).click()
    const searchResult = page.locator('.search-result').filter({ hasText: playerKey })
    await expect(searchResult).toContainText(currentName)
    await searchResult.click()
    const profile = page.locator('.player-profile')
    const xp = profile.locator('[data-metric="experience.gained"] strong')
    const online = profile.locator('[data-metric="online.millis"] strong')
    const level = profile
      .locator('.summary-details dl div')
      .filter({ hasText: '已观测最高等级' })
      .locator('dd')
    await expect(profile.locator('.profile-identity code')).toHaveText(playerKey)
    await expect(profile.getByRole('heading', { name: currentName, exact: true })).toBeVisible()
    await expect(profile.locator('.name-history').first()).toContainText(firstName)
    await expect(profile.locator('.name-history').nth(1)).toContainText(first.archiveName)
    await expect(profile.locator('.name-history').nth(1)).toContainText('已封存')
    await expect(xp).toHaveText(String(total.xp))
    await expect(level).toHaveText(String(total.level))
    await expect(online).toHaveText(formatValue(total.online, 'ms'))
    const panel = profile
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: '各服务器贡献' }) })
    await panel.locator('select').selectOption('experience.gained')
    const contribution = (server) =>
      panel.getByRole('row').filter({ hasText: server.archiveName }).getByRole('cell').nth(1)
    await expect(contribution(first)).toHaveText(String(first.xp))
    await expect(contribution(second)).toHaveText(String(second.xp))
    await panel.locator('select').selectOption('level.max')
    await expect(contribution(first)).toHaveText(String(first.level))
    await expect(contribution(second)).toHaveText(String(second.level))
    for (const server of [first, second, first, second]) {
      await scope.selectOption(server.id)
      await expect(profile.locator('.profile-identity code')).toHaveText(playerKey)
      await expect(xp).toHaveText(String(server.xp))
      await expect(level).toHaveText(String(server.level))
    }
    await page.getByLabel('开始日期').fill(day)
    await page.getByLabel('结束日期').fill(day)
    const dimension = page.getByLabel('维度筛选')
    await dimension.fill('minecraft:nether')
    await page.getByRole('button', { name: '应用筛选' }).click()
    await expect(profile.getByText('当前筛选范围内没有这位玩家的记录。')).toBeVisible()
    await expect(xp).toHaveText('未接入')
    await dimension.fill('minecraft:overworld')
    await page.getByRole('button', { name: '应用筛选' }).click()
    await expect(xp).toHaveText(String(second.xp))
    await page.getByRole('button', { name: '累计数据' }).click()
    await page.getByRole('button', { name: '返回玩家列表' }).click()
    await page.getByLabel('搜索玩家当前或历史名字').fill(currentName)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const list = page.getByLabel('玩家列表', { exact: true })
    const names = list.getByRole('row').filter({ hasText: currentName })
    await expect(names).toHaveCount(2)
    await expect(names.filter({ hasText: playerKey })).toHaveCount(1)
    await names
      .filter({ hasText: otherKey })
      .getByRole('button', { name: `查看玩家 ${currentName}` })
      .click()
    await expect(profile.locator('.profile-identity code')).toHaveText(otherKey)
    await expect(xp).toHaveText(String(sameName.xp))
    await expect(level).toHaveText(String(sameName.level))
    await scope.selectOption(first.id)
    await expect(profile.getByText('当前筛选范围内没有这位玩家的记录。')).toBeVisible()
    await expect(profile.locator('.profile-identity code')).toHaveText(otherKey)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    )
    assert.deepEqual(errors, [])
    checks.push({
      width,
      archivedIncluded: true,
      aliasAndSameNameResolved: true,
      scopeKeepsIdentity: true,
      dimensionFilterVerified: true,
    })
    await page.close()
  }
  const result = { verifiedAt: new Date().toISOString(), playerKey, otherKey, checks }
  await writeFile(
    new URL('../../.tools/native-player-identity-browser.json', import.meta.url),
    JSON.stringify(result, null, 2),
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
