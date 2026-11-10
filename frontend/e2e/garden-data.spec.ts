import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test.use({ reducedMotion: 'reduce', locale: 'zh-CN' })

async function create(page: Page, path: string, data: unknown) {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const response = await page.request.post('/api' + path, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}

test('populated dashboard, deferred charts, grouped stories and chat discovery', async ({
  page,
}, info) => {
  test.setTimeout(90000)
  const errors: string[] = []
  const requests: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => requests.push(request.url()))
  await page.setViewportSize({ width: 1586, height: 992 })
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.locator('main h1')).toHaveText('今天的方块世界')
  const server = await create(page, '/servers', {
    name: '晨光生存世界 · 验收',
    description: '隔离协议测试数据，不是真实玩家记录',
    startDate: '2020-01-01',
  })
  for (const name of ['林间小屋', '河畔钟楼'])
    await create(page, `/servers/${server.id}/projects`, {
      requestId: randomUUID(),
      action: 'CREATE',
      name,
      dimension: 'minecraft:overworld',
      x1: 0,
      z1: 0,
      x2: 16,
      z2: 16,
    })
  const credential = await create(page, `/servers/${server.id}/collector-credential`, {})
  const events: object[] = []
  for (let d = 6; d >= 0; d--)
    for (let p = 0; p < 3; p++) {
      const time = Date.now() - d * 86400000 - 7200000
      const player = {
        identityType: 'XUID',
        identity: String(923456780 + p),
        name: ['小树', '星河', '木匠'][p],
      }
      const dimension = p === 2 ? 'minecraft:nether' : 'minecraft:overworld'
      const sessionId = randomUUID(),
        startedAt = new Date(time).toISOString()
      for (const [sequence, onlineMillis, ended] of [
        [0, 0, false],
        [1, 1800000 + ((d * 3 + p * 2) % 7) * 600000, true],
      ] as const)
        events.push({
          eventId: randomUUID(),
          kind: 'SESSION',
          at: new Date(time + onlineMillis).toISOString(),
          player,
          dimension,
          sessionId,
          startedAt,
          sequence,
          onlineMillis,
          ended,
        })
      for (const metric of ['blocks.placed', 'blocks.mined', 'travel.walk_millimeters'])
        events.push({
          eventId: randomUUID(),
          kind: 'COUNTER',
          at: startedAt,
          player,
          dimension,
          metric,
          value: metric.startsWith('travel') ? 22000000 : 120 + d * 48 + p * 30,
          subject: metric.startsWith('blocks') ? 'minecraft:stone' : undefined,
        })
    }
  // Current-position events are retained as actual project contributions after project creation.
  for (let p = 0; p < 3; p++)
    events.push({
      eventId: randomUUID(),
      kind: 'COUNTER',
      at: new Date().toISOString(),
      player: {
        identityType: 'XUID',
        identity: String(923456780 + p),
        name: ['小树', '星河', '木匠'][p],
      },
      dimension: 'minecraft:overworld',
      metric: 'blocks.placed',
      value: 1,
      subject: ['minecraft:oak_log', 'minecraft:stone', 'minecraft:glass'][p],
      position: { x: p * 4, y: 64, z: 4 },
    })
  const uploaded = await page.request.post('/api/ingest/v1/batches', {
    headers: { Authorization: 'Bearer ' + credential.token },
    data: {
      protocolVersion: 1,
      batchId: randomUUID(),
      reportedAt: new Date().toISOString(),
      collector: {
        version: 'isolated-design-qa',
        bdsVersion: 'qa',
        leviLaminaVersion: 'qa',
        bootId: randomUUID(),
        pendingEvents: 0,
        runtime: {
          sequence: 1,
          at: new Date().toISOString(),
          windowMillis: 10000,
          uptimeMillis: 100000,
          ticks: 200,
          players: 3,
          lastTickAt: new Date().toISOString(),
          maxTickIntervalMillis: 50,
          cpuPercent: 12,
          workingSetBytes: 1073741824,
          privateBytes: 1073741824,
          hostMemoryTotalBytes: 8589934592,
          hostMemoryAvailableBytes: 4294967296,
          stopped: false,
          hostCpuPercent: 24,
          hostLogicalProcessors: 8,
        },
      },
      capabilities: [
        'blocks.placed',
        'blocks.mined',
        'online.millis',
        'travel.walk_millimeters',
      ].map((metric) => ({
        metric,
        state: 'ACTIVE',
        quality: metric.startsWith('travel') ? 'ESTIMATED' : 'EXACT',
        algorithmVersion: 'qa',
        dimensionAware: true,
      })),
      events,
    },
  })
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy()
  requests.length = 0
  await page.goto('/?server=' + server.id)
  await expect(page.locator('.trend-panel .data-chart svg')).toBeVisible()
  await expect(page.locator('.overview-project-card')).toHaveCount(2)
  await expect(page.locator('.dashboard-runtime')).toContainText('24%')
  expect(requests.some((url) => url.includes('/scene/') || url.includes('/project-models/'))).toBe(
    false,
  )
  await page.screenshot({ path: info.outputPath('dashboard-desktop.png') })
  const insight = page.getByRole('img', { name: '挖掘、放置和作物方块数量' })
  await expect(insight.locator('svg')).toHaveCount(0)
  await insight.scrollIntoViewIfNeeded()
  await expect(insight.locator('svg')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => scrollTo(0, 0))
  await page.screenshot({ path: info.outputPath('dashboard-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  for (const chart of await page.locator('.insights-grid .data-chart').all()) {
    await chart.scrollIntoViewIfNeeded()
    await expect(chart.locator('svg')).toBeVisible()
    expect(await chart.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  }
  await page.getByRole('button', { name: '找功能', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索功能' }).fill('聊天')
  await page.locator('.finder-results button').click()
  await expect(page.getByRole('button', { name: '游玩与聊天', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.goto('/exploration?server=' + server.id)
  const groups = [
    ['伙伴与日常', ['服务器作息', '活动河流', '服务器时钟', '玩家气泡', '玩家雷达']],
    ['建造与协作', ['建筑协作', '贡献流向', '材料拼图', '施工旭日', '建设榜回放', '成长时间轴']],
    ['探索与运行', ['建设热区', '地下施工', '运行分布']],
  ] as const
  for (const [name, tabs] of groups) {
    await page
      .locator('.story-categories')
      .getByRole('button', { name: new RegExp(name) })
      .click()
    for (const tab of tabs) {
      await page
        .getByRole('navigation', { name: '故事图表' })
        .getByRole('button', { name: tab, exact: true })
        .click()
      await expect(page.locator('.explore-chart>h2')).toHaveText(tab)
      await expect(page.locator('.explore-chart [role="alert"]')).toHaveCount(0)
      const chart = page.locator('.explore-chart .data-chart')
      if (await chart.count()) {
        await chart.scrollIntoViewIfNeeded()
        await expect(chart.locator('svg')).toBeVisible()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
      if (tab === '材料拼图' || tab === '贡献流向') {
        await page.setViewportSize({ width: 1586, height: 1100 })
        await page.evaluate(() => scrollTo(0, 0))
        await expect.poll(async () => chart.locator('svg').getAttribute('width')).toBe(String(await chart.evaluate(el => el.clientWidth)))
        await page.screenshot({path:info.outputPath(tab === '材料拼图' ? 'materials-desktop.png' : 'collaboration-desktop.png'),fullPage:true})
        await page.setViewportSize({ width: 390, height: 844 })
      }
    }
  }
  expect(requests.filter((url) => url.includes('/statistics/exploration?'))).toHaveLength(1)
  expect(requests.filter((url) => url.includes('/statistics/exploration/extended?'))).toHaveLength(
    1,
  )
  await page.goto('/reports?server=' + server.id)
  const reportChart = page.getByRole('img', { name: '七天放置与挖掘趋势' })
  await reportChart.scrollIntoViewIfNeeded()
  await expect(reportChart.locator('svg')).toBeVisible()
  await page.screenshot({ path: info.outputPath('report-mobile.png'), fullPage: true })
  expect(errors).toEqual([])
})
