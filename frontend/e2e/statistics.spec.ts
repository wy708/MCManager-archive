import { test, expect, type Page } from '@playwright/test'

async function expandStatistics(page: Page) {
  const details = page.locator('.overview-detail-controls')
  await expect(details).toBeVisible()
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
    await details.locator('summary').click()
}
async function login(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '进入工作台' })).toBeEnabled()
  await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.getByRole('heading', { name: '今天的方块世界' })).toBeVisible()
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"]')).toBeVisible()
}
async function navigate(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: '切换导航' })
  if (await toggle.isVisible()) await toggle.click()
  await page
    .locator('.sidebar')
    .getByRole('button', { name, exact: name !== '服务器档案' })
    .click()
  await expect(
    page.getByRole('heading', { name: name === '数据总览' ? '今天的方块世界' : name, exact: true }),
  ).toBeVisible()
}
async function mutate(page: Page, endpoint: string, body: unknown, method = 'POST') {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const response = await page.request.fetch('/api' + endpoint, {
    method,
    headers: { [csrf.headerName]: csrf.token },
    data: body,
  })
  expect(response.ok()).toBe(true)
  return response.status() === 204 ? undefined : response.json()
}
async function createServer(page: Page, name: string) {
  return mutate(page, '/servers', {
    name,
    description: '真实 HTTP 协议验收，不是游戏数据',
    startDate: '2020-01-01',
  })
}
async function uiCredential(page: Page, serverId: string) {
  await page.getByLabel('统计范围').selectOption(serverId)
  await navigate(page, '平台设置')
  await expect(page.locator('.collector-card')).toHaveCount(1)
  await page.getByRole('button', { name: '创建连接密钥', exact: true }).click()
  const modal = page.getByRole('dialog')
  await modal.getByRole('button', { name: '生成连接密钥' }).click()
  await expect(modal.getByLabel('插件连接密钥', { exact: true })).toBeVisible()
  const token = await modal.getByLabel('插件连接密钥', { exact: true }).inputValue()
  await modal.getByRole('button', { name: '已保存，关闭' }).click()
  await expect(modal).not.toBeVisible()
  await expect(page.getByLabel('插件连接密钥', { exact: true })).toHaveCount(0)
  return token
}
function packet(identity: string, name: string, count: number, offset = 0) {
  const start = Date.now() - 30_000,
    session = crypto.randomUUID()
  const player = { identityType: 'XUID', identity, name }
  const at = (millis: number) => new Date(start + millis).toISOString()
  const dimension = offset ? 'minecraft:nether' : 'minecraft:overworld'
  const counter = (metric: string, value: number, subject?: string) => ({
    eventId: crypto.randomUUID(),
    kind: 'COUNTER',
    at: at(offset),
    player,
    dimension,
    metric,
    value,
    ...(subject ? { subject } : {}),
  })
  const checkpoint = (sequence: number, onlineMillis: number, ended: boolean) => ({
    eventId: crypto.randomUUID(),
    kind: 'SESSION',
    at: at(onlineMillis),
    player,
    dimension,
    sessionId: session,
    startedAt: at(0),
    sequence,
    onlineMillis,
    ended,
  })
  const events: object[] = [
    counter('blocks.mined', count, offset ? 'minecraft:diamond_ore' : 'minecraft:oak_log'),
    counter('experience.gained', 23),
    counter('level.max', offset ? 11 : 42),
  ]
  if (!offset)
    events.push(checkpoint(0, 0, false), checkpoint(1, 10000, true), {
      eventId: crypto.randomUUID(),
      kind: 'DEATH',
      at: at(1000),
      player,
      dimension,
      cause: 'fall',
    })
  return {
    protocolVersion: 1,
    batchId: crypto.randomUUID(),
    reportedAt: new Date().toISOString(),
    collector: {
      version: 'browser-contract-qa',
      bdsVersion: 'not-a-game',
      leviLaminaVersion: 'not-a-plugin',
      bootId: crypto.randomUUID(),
      pendingEvents: 0,
    },
    capabilities: ['online.millis', 'blocks.mined', 'experience.gained', 'level.max', 'deaths'].map(
      (metric) => ({
        metric,
        state: 'ACTIVE',
        quality: metric === 'level.max' ? 'OBSERVED' : 'EXACT',
        algorithmVersion: 'e2e-v1',
        dimensionAware: true,
      }),
    ),
    events,
  }
}
async function upload(page: Page, token: string, payload: object) {
  const response = await page.request.post('/api/ingest/v1/batches', {
    headers: { Authorization: 'Bearer ' + token },
    data: payload,
  })
  expect(response.status()).toBe(200)
  return response.json()
}
async function seed(page: Page, suffix: string) {
  const server = await createServer(page, '统计验收 · ' + suffix)
  const issued = await mutate(page, `/servers/${server.id}/collector-credential`, {})
  const identity = String(BigInt(Date.now()) * 10000n + BigInt(Math.floor(Math.random() * 10000)))
  await upload(page, issued.token, packet(identity, '探险家-' + suffix, 7))
  await page.reload()
  await page.getByLabel('统计范围').selectOption(server.id)
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText('7')
  return { server, token: issued.token, identity }
}

test('workspace paths restore views, player, scope and statistics across refresh and history', async ({
  page,
  browser,
}) => {
  await login(page)
  const { server, identity } = await seed(page, '路径恢复')
  await navigate(page, '行为统计')
  await page.getByLabel('方块分类').selectOption('WOOD')
  await page.getByLabel('维度筛选').fill('minecraft:overworld')
  await page.getByRole('button', { name: '应用筛选', exact: true }).click()
  const activityPath = `/activity?server=${server.id}&dimension=minecraft%3Aoverworld&category=WOOD`
  await expect(page).toHaveURL(new URL(activityPath, page.url()).href)
  await page.reload()
  await expect(page.getByRole('heading', { name: '行为统计', exact: true })).toBeVisible()
  await expect(page.getByLabel('统计范围')).toHaveValue(server.id)
  await expect(page.getByLabel('方块分类')).toHaveValue('WOOD')
  await expect(page.getByLabel('维度筛选')).toHaveValue('主世界')
  await expect(page.getByText('橡树原木', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '死亡记录', exact: true }).click()
  await expect(page).toHaveURL(/tab=deaths/)
  await page.goBack()
  await expect(page).toHaveURL(new URL(activityPath, page.url()).href)
  await expect(page.getByLabel('方块分类')).toHaveValue('WOOD')
  await page.goForward()
  await expect(page.getByRole('button', { name: '死亡记录', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.getByRole('button', { name: '查看全部时间', exact: true }).click()
  await page.getByLabel('搜索玩家或服务器', { exact: true }).fill('探险家-路径恢复')
  await page.getByRole('button', { name: '搜索工作台' }).click()
  await page
    .locator('.search-result')
    .filter({ hasText: `xuid:${identity}` })
    .click()
  await page.getByRole('button', { name: '游玩与聊天', exact: true }).click()
  const playerPath = `/players/xuid%3A${identity}?server=${server.id}&tab=sessions`
  const playerUrl = new URL(playerPath, page.url()).href
  await expect(page).toHaveURL(playerUrl)
  await page.reload()
  await expect(page.getByRole('heading', { name: '探险家-路径恢复', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '查看聊天', exact: true })).toBeVisible()

  const fresh = await browser.newPage()
  try {
    await fresh.goto(playerUrl)
    await expect(fresh.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
    await fresh.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
    await fresh.getByRole('button', { name: '进入工作台' }).click()
    await expect(fresh).toHaveURL(playerUrl)
    await expect(fresh.getByRole('heading', { name: '探险家-路径恢复', exact: true })).toBeVisible()
    await expect(fresh.getByLabel('统计范围')).toHaveValue(server.id)
    await expect(fresh.getByRole('button', { name: '查看聊天', exact: true })).toBeVisible()
  } finally {
    await fresh.close()
  }
})

test('real credential UI, telemetry, renamed player, cross-server totals and history', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await login(page)
  const initial = await (await page.request.get('/api/statistics/summary')).json()
  const mined = initial.metrics.find((metric: { key: string }) => metric.key === 'blocks.mined')
  const allMined = (BigInt(mined?.value ?? '0') + 11n).toLocaleString('zh-CN')
  const first = await createServer(page, '跨服验收 A'),
    second = await createServer(page, '跨服验收 B')
  await page.reload()
  const firstToken = await uiCredential(page, first.id)
  const firstPacket = packet('888000001', '探险家初名', 7)
  expect((await upload(page, firstToken, firstPacket)).acceptedEvents).toBe(6)
  expect((await upload(page, firstToken, firstPacket)).duplicateBatch).toBe(true)
  const secondToken = await uiCredential(page, second.id)
  await upload(page, secondToken, packet('888000001', '探险家新名', 4, 20_000))
  await navigate(page, '数据总览')
  await page.getByLabel('统计范围').selectOption(first.id)
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText('7')
  await page.getByLabel('统计范围').selectOption(second.id)
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText('4')
  await page.getByLabel('统计范围').selectOption('all')
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText(allMined)
  await expect(page.locator('.summary-details')).toContainText('42')
  await expect(
    page.getByRole('img', { name: '每日在线时长趋势', exact: true }).locator('svg'),
  ).toBeVisible()
  await page.getByRole('img', { name: '各世界在线时长占比', exact: true }).scrollIntoViewIfNeeded()
  await expect(
    page.getByRole('img', { name: '各世界在线时长占比', exact: true }).locator('svg'),
  ).toBeVisible()
  await page
    .getByRole('img', { name: '最近记录日前 90 天在线时间日历', exact: true })
    .scrollIntoViewIfNeeded()
  await expect(
    page.getByRole('img', { name: '最近记录日前 90 天在线时间日历', exact: true }).locator('svg'),
  ).toBeVisible()
  await page
    .getByRole('img', { name: '挖掘、放置和作物方块数量', exact: true })
    .scrollIntoViewIfNeeded()
  await expect(
    page.getByRole('img', { name: '挖掘、放置和作物方块数量', exact: true }).locator('svg'),
  ).toBeVisible()
  // ECharts owns the SVG dimensions; legacy chart CSS must not clip its axes.
  const chart = page.getByRole('img', { name: '每日在线时长趋势', exact: true })
  const box = await chart.boundingBox(),
    svgBox = await chart.locator('svg').boundingBox()
  expect(Math.abs(box!.height - svgBox!.height)).toBeLessThan(2)

  await page.getByText('数据从哪里来？').click()
  await expect(page.getByRole('table').filter({ hasText: '当前能力' })).toContainText('跨服验收 A')
  await navigate(page, '玩家统计')
  await page.getByLabel('搜索玩家当前或历史名字').fill('探险家初名')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('button', { name: '查看玩家 探险家新名' }).click()
  await expect(page.getByRole('heading', { name: '探险家新名', exact: true })).toBeFocused()
  await expect(page.locator('.player-profile [data-metric="blocks.mined"] strong')).toHaveText('11')
  await expect(page.locator('.player-profile .name-history').first()).toContainText('探险家初名')
  await page.getByRole('button', { name: '返回玩家列表' }).click()
  await expect(page.getByRole('button', { name: '查看玩家 探险家新名' })).toBeFocused()
  await expect(page.getByLabel('搜索玩家当前或历史名字')).toHaveValue('探险家初名')
  await navigate(page, '行为统计')
  await page.getByLabel('方块分类').selectOption('ORE')
  await expect(page.getByRole('table').getByText('钻石矿石', { exact: true })).toBeVisible()
  await expect(page.getByRole('table')).not.toContainText('minecraft:diamond_ore')
  await page.getByLabel('显示游戏内编号').check()
  await expect(page.getByRole('table')).toContainText('minecraft:diamond_ore')
  await page.getByLabel('显示游戏内编号').uncheck()
  await page.getByRole('button', { name: '死亡记录', exact: true }).click()
  const death = page.getByRole('row').filter({ hasText: '跨服验收 A' })
  await expect(death.getByText('摔落', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '游玩与聊天', exact: true }).click()
  await expect(page.getByRole('table')).toContainText('正常结束')
  await mutate(page, `/servers/${first.id}/archive`, {
    endDate: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Hong_Kong' }),
  })
  await navigate(page, '平台设置')
  await page.getByLabel('统计范围').selectOption(first.id)
  await page.getByRole('button', { name: '停用连接密钥', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '确认撤销' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(
    (
      await page.request.post('/api/ingest/v1/batches', {
        headers: { Authorization: 'Bearer ' + firstToken },
        data: packet('888000001', '探险家新名', 10),
      })
    ).status(),
  ).toBe(401)
  await navigate(page, '数据总览')
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText('7')
  expect(errors).toEqual([])
})

test('behavior categories distinguish block, item, entity and historical names in Chinese', async ({
  page,
}) => {
  await login(page)
  const server = await createServer(page, '行为中文名称验收')
  const { token } = await mutate(page, `/servers/${server.id}/collector-credential`, {})
  const payload = packet('980100001', '中文名称探险家', 2)
  const labels = [
    ['blocks.mined', 'minecraft:oak_log', '橡树原木'],
    ['crops.planted', 'minecraft:wheat', '小麦'],
    ['items.picked_up', 'minecraft:cod', '生鳕鱼'],
    ['kills.mobs', 'minecraft:cod', '鳕鱼'],
    ['breeding.offspring', 'minecraft:cow', '牛'],
    ['fishing.retrievals', 'minecraft:fishing_hook', '鱼钩'],
    ['fishing.catches', 'minecraft:cod', '生鳕鱼'],
    ['villager.items', 'minecraft:emerald', '绿宝石'],
    ['crafting.items', 'minecraft:crafting_table', '工作台'],
    ['travel.vehicle_millimeters', 'minecraft:minecart', '矿车'],
    ['activity.millis', 'archive:active', '活跃时段'],
    ['dimension.visits', 'minecraft:nether', '下界'],
  ]
  const player = { identityType: 'XUID', identity: '980100001', name: '中文名称探险家' }
  const at = new Date(Date.now() - 1000).toISOString()
  for (const [metric, subject] of [...labels, ['blocks.mined', 'modqa:crystal_block']]) {
    if (!payload.capabilities.some((capability) => capability.metric === metric))
      payload.capabilities.push({
        metric,
        state: 'ACTIVE',
        quality:
          metric.startsWith('travel.') || metric === 'activity.millis' ? 'ESTIMATED' : 'EXACT',
        algorithmVersion: 'e2e-v1',
        dimensionAware: true,
      })
    payload.events.push({
      eventId: crypto.randomUUID(),
      kind: 'COUNTER',
      at,
      player,
      dimension: 'minecraft:overworld',
      metric,
      subject,
      value: 1,
    })
  }
  payload.events.push({
    eventId: crypto.randomUUID(),
    kind: 'DEATH',
    at,
    player,
    dimension: 'minecraft:overworld',
    cause: 'entity_attack',
    killerType: 'minecraft:zombie',
  })
  payload.reportedAt = new Date().toISOString()
  await upload(page, token, payload)
  await page.reload()
  await page.getByLabel('统计范围').selectOption(server.id)
  await navigate(page, '行为统计')
  const table = page.getByRole('table', { name: '' }).first()
  for (const [metric, subject, label] of labels) {
    await page.getByRole('combobox', { name: '想看什么', exact: true }).selectOption(metric)
    await expect(table.locator(`td:first-child [data-game-id="${subject}"]`)).toHaveText(label)
    if (metric === 'blocks.mined') {
      const custom = table.locator('[data-game-id="modqa:crystal_block"]')
      await expect(custom).toContainText('未收录的方块')
      await expect(custom).toContainText('modqa:crystal_block')
    }
  }
  await page.getByRole('button', { name: '死亡记录', exact: true }).click()
  await expect(page.getByRole('table').locator('[data-game-id="entity_attack"]')).toHaveText(
    '实体攻击',
  )
  await expect(page.getByRole('table').locator('[data-game-id="minecraft:zombie"]')).toHaveText(
    '僵尸',
  )
})

for (const width of [1440, 390, 360]) {
  test(`read scoped session chat at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await login(page)
    const server = await createServer(page, `会话聊天验收 · ${width}`)
    const { token } = await mutate(page, `/servers/${server.id}/collector-credential`, {})
    const payload = packet(String(980000000 + width), '会话探险家', 2)
    const start = payload.events.find(
      (event): event is { kind: string; sequence: number; at: string; player: object } =>
        'kind' in event && event.kind === 'SESSION' && 'sequence' in event && event.sequence === 0,
    )!
    for (const metric of ['chat.messages', 'chat.contents']) {
      payload.capabilities.push({
        metric,
        state: 'ACTIVE',
        quality: 'EXACT',
        algorithmVersion: 'e2e-v1',
        dimensionAware: true,
      })
    }
    const message = '你好 <b>方块世界</b> ' + '很长的一句聊天'.repeat(20)
    payload.events.push(
      ...[
        [1000, message],
        [12000, '超过最后检查点的聊天'],
      ].map(([offset, text]) => ({
        eventId: crypto.randomUUID(),
        kind: 'CHAT',
        at: new Date(Date.parse(start.at) + Number(offset)).toISOString(),
        player: start.player,
        dimension: 'minecraft:overworld',
        text,
      })),
    )
    await upload(page, token, payload)
    await page.reload()
    await page.getByLabel('统计范围').selectOption(server.id)
    await navigate(page, '行为统计')
    await page.getByRole('button', { name: '游玩与聊天', exact: true }).click()
    const open = page.getByRole('button', { name: '查看聊天', exact: true })
    await open.click()
    const dialog = page.getByRole('dialog', { name: '这次游玩的聊天' })
    await expect(dialog.getByText(message, { exact: true })).toBeVisible()
    await expect(dialog.locator('b')).toHaveCount(0)
    await expect(dialog.getByText('超过最后检查点的聊天')).toHaveCount(0)
    await expect(dialog).toContainText('会话探险家')
    await expect(dialog).toContainText('明细保留期为')
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(open).toBeFocused()
  })
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 360, height: 440 },
]) {
  test(`populated statistics, player profile and credentials at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await login(page)
    await seed(page, String(viewport.width))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('statistics.png'), fullPage: true })
    await navigate(page, '玩家统计')
    await page.getByRole('button', { name: '查看玩家 探险家-' + viewport.width }).click()
    await expect(page.getByRole('heading', { name: '历史名字' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('player.png'), fullPage: true })
    await navigate(page, '平台设置')
    await page.getByRole('button', { name: '更换连接密钥', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: '生成连接密钥' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('credential.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('button', { name: '更换连接密钥', exact: true })).toBeFocused()
  })
}

test('statistics failures can be retried and expired sessions return to login', async ({
  page,
}) => {
  await login(page)
  await seed(page, '恢复')
  await page.context().setOffline(true)
  await page.getByRole('button', { name: '刷新统计', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法连接服务器')
  await page.context().setOffline(false)
  await page.getByRole('button', { name: '重新加载统计' }).click()
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText('7')
  await mutate(page, '/auth/logout', undefined)
  await page.getByRole('button', { name: '刷新统计', exact: true }).click()
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
})

test('rapid scope changes cancel old responses and filters preserve missing versus zero', async ({
  page,
}) => {
  await login(page)
  const first = await seed(page, '慢响应')
  const second = await createServer(page, '快响应范围')
  const credential = await mutate(page, `/servers/${second.id}/collector-credential`, {})
  await upload(page, credential.token, packet('888000009', '快响应玩家', 4))
  await page.reload()
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"]')).toBeVisible()
  await page.getByLabel('统计范围').selectOption('all')
  let release!: () => void, observed!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const seen = new Promise<void>((resolve) => {
    observed = resolve
  })
  let cancelled = false
  page.on('requestfailed', (request) => {
    if (request.url().includes(first.server.id) && request.url().includes('/statistics/summary'))
      cancelled = true
  })
  await page.route('**/api/statistics/summary?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('serverId') !== first.server.id) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    observed()
    await hold
    try {
      await route.fulfill({ response })
    } catch {
      /* The browser cancelled this real forwarded request. */
    }
  })
  await page.getByLabel('统计范围').selectOption(first.server.id)
  await seen
  await page.getByLabel('统计范围').selectOption(second.id)
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText('4')
  await expect.poll(() => cancelled).toBe(true)
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await page.getByLabel('开始日期', { exact: true }).fill('2020-01-01')
  await page.getByLabel('结束日期', { exact: true }).fill('2020-01-02')
  await page.getByRole('button', { name: '应用筛选' }).click()
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText('未接入')
  await page.getByRole('button', { name: '查看全部时间', exact: true }).click()
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText('4')
  await page.getByLabel('维度筛选').fill('minecraft:nether')
  await page.getByRole('button', { name: '应用筛选' }).click()
  await expandStatistics(page)
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText('0')
})

for (const width of [1440, 390, 360]) {
  test(`reference toolbar search opens scoped real player and server records ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 })
    await login(page)
    const own = await seed(page, '顶栏 ' + width)
    const search = page.getByLabel('搜索玩家或服务器', { exact: true })
    await search.fill('探险家-顶栏 ' + width)
    await search.press('Enter')
    const results = page.locator('.search-results')
    await expect(
      results.getByRole('button').filter({ hasText: '探险家-顶栏 ' + width }),
    ).toBeVisible()
    await results
      .getByRole('button')
      .filter({ hasText: '探险家-顶栏 ' + width })
      .click()
    await expect(page.locator('.player-profile')).toBeVisible()
    await expect(page.locator('.player-profile [data-metric="blocks.mined"] strong')).toHaveText(
      '7',
    )
    await search.fill(own.server.name)
    await search.press('Enter')
    await results.getByRole('button').filter({ hasText: own.server.name }).click()
    await expect(page.locator('.server-card')).toHaveCount(1)
    await expect(page.locator('.server-card')).toContainText(own.server.name)
    await page.locator('.account-menu summary').click()
    await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '退出登录' })).not.toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
