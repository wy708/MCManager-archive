import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('story charts fetch only their section and reuse fresh snapshots', async ({ page }) => {
  test.setTimeout(90000)
  const errors: string[] = [], requests: URL[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/statistics/exploration')) requests.push(url)
  })
  await page.goto('/?lang=zh-CN')
  await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.locator('main h1')).toHaveText('今天的方块世界')
  const create = async (path: string, data: unknown) => {
    const csrf = await (await page.request.get('/api/auth/csrf')).json()
    const response = await page.request.post('/api' + path, { data, headers: { [csrf.headerName]: csrf.token } })
    expect(response.ok(), await response.text()).toBeTruthy()
    return response.json()
  }
  const server = await create('/servers', { name: 'Chart loading QA', description: 'Isolated protocol fixture', startDate: '2020-01-01' })
  const credential = await create(`/servers/${server.id}/collector-credential`, {})
  const player = { identityType: 'XUID', identity: '923456780', name: 'Builder' }
  const started = Date.now() - 60000, sessionId = randomUUID()
  const events: object[] = [{ eventId: randomUUID(), kind: 'COUNTER', at: new Date(started).toISOString(), player, dimension: 'minecraft:overworld', metric: 'blocks.placed', value: 1, subject: 'minecraft:stone', position: { x: -1, y: 64, z: -1 } }]
  for (const [sequence, onlineMillis, ended] of [[0, 0, false], [1, 5000, true]] as const)
    events.push({ eventId: randomUUID(), kind: 'SESSION', at: new Date(started + onlineMillis).toISOString(), startedAt: new Date(started).toISOString(), sessionId, sequence, onlineMillis, ended, player, dimension: 'minecraft:overworld' })
  const response = await page.request.post('/api/ingest/v1/batches', {
    headers: { Authorization: 'Bearer ' + credential.token }, data: {
      protocolVersion: 1, batchId: randomUUID(), reportedAt: new Date().toISOString(), events,
      capabilities: ['blocks.placed', 'online.millis'].map(metric => ({ metric, state: 'ACTIVE', quality: 'EXACT', algorithmVersion: 'qa', dimensionAware: true })),
      collector: { version: 'qa', bdsVersion: 'qa', leviLaminaVersion: 'qa', bootId: randomUUID(), pendingEvents: 0 },
    },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  await page.goto('/exploration?server=' + server.id + '&lang=zh-CN')
  const view = page.locator('.exploration')
  await expect(view.locator('.explore-chart > h2')).toHaveText('服务器作息')
  await expect(view.locator('.data-chart svg').first()).toBeVisible()
  expect(requests.map(url => url.searchParams.get('part'))).toEqual(['hours'])
  await view.locator('.explore-tabs').getByRole('button', { name: '服务器时钟', exact: true }).click()
  await expect(view.locator('.data-chart svg').first()).toBeVisible()
  expect(requests).toHaveLength(1)
  await view.locator('.explore-tabs').getByRole('button', { name: '玩家气泡', exact: true }).click()
  await expect(view.locator('.data-chart svg').first()).toBeVisible()
  expect(requests.at(-1)?.searchParams.get('part')).toBe('players')
  expect(requests.filter(url => url.pathname.endsWith('/extended')).map(url => url.searchParams.get('part'))).toEqual(['players'])
  await view.locator('.story-categories button').nth(1).click()
  await expect(view.locator('.explore-chart > h2')).toHaveText('建筑协作')
  expect(requests.at(-1)?.searchParams.get('part')).toBe('contributions')
  await view.locator('.explore-tabs').getByRole('button', { name: '材料拼图', exact: true }).click()
  await expect(view.locator('.explore-chart > h2')).toHaveText('材料拼图')
  const count = requests.length
  await view.locator('.story-categories button').first().click()
  await expect(view.locator('.explore-chart > h2')).toHaveText('服务器作息')
  expect(requests).toHaveLength(count)
  await view.locator('.explore-tabs').getByRole('button', { name: '玩家气泡', exact: true }).click()
  await expect(view.locator('.data-chart svg').first()).toBeVisible()
  expect(requests.filter(url => url.pathname.endsWith('/extended')).map(url => url.searchParams.get('part'))).toEqual(['players'])
  await view.locator('.story-categories button').nth(2).click()
  await expect(view.locator('.explore-coverage')).toBeVisible()
  expect(requests.at(-1)?.searchParams.get('part')).toBe('hotspots')
  await view.locator('.explore-tabs').getByRole('button', { name: '运行分布', exact: true }).click()
  await expect(view.locator('.no-extra-data')).toBeVisible()
  expect(requests.at(-1)?.searchParams.get('part')).toBe('runtime')
  // Expired snapshots must be fetched again, rather than keeping stale counts forever.
  await page.clock.setSystemTime(new Date(Date.now() + 121_000))
  await view.locator('.story-categories button').first().click()
  await expect(view.locator('.explore-chart > h2')).toHaveText('服务器作息')
  await view.locator('.explore-tabs').getByRole('button', { name: '玩家气泡', exact: true }).click()
  await expect(view.locator('.data-chart svg').first()).toBeVisible()
  expect(requests.filter(url => url.pathname.endsWith('/extended') && url.searchParams.get('part') === 'players')).toHaveLength(2)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy()
  expect(requests.some(url => !url.searchParams.get('part') || url.searchParams.get('part') === 'all')).toBeFalsy()
  expect(errors).toEqual([])
})
