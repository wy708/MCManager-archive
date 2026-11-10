import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

// These are actual backend state transitions, not evidence of a running game.
async function mutate(page: Page, endpoint: string, data?: unknown, method = 'POST') {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const response = await page.request.fetch('/api' + endpoint, {
    method,
    headers: { [csrf.headerName]: csrf.token },
    data,
  })
  expect(response.ok(), await response.text()).toBe(true)
  return response.status() === 204 ? undefined : response.json()
}
async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.getByRole('heading', { name: '今天的方块世界', exact: true })).toBeVisible()
}
async function server(page: Page, name: string) {
  return mutate(page, '/servers', {
    name,
    description: 'Browser protocol QA, not gameplay',
    startDate: '2020-01-01',
  })
}
async function navigate(page: Page, id: string) {
  await page.getByLabel('统计范围').selectOption(id)
  const menu = page.getByRole('button', { name: '切换导航' })
  if (await menu.isVisible()) await menu.click()
  await page.locator('.sidebar').getByRole('button', { name: '备份中心', exact: true }).click()
  await page
    .getByRole('navigation', { name: '服务器备份功能' })
    .getByRole('button', { name: '备份任务', exact: true })
    .click()
  await expect(
    page
      .getByRole('region', { name: '游戏主机与备份任务' })
      .getByRole('button', { name: '刷新任务', exact: true }),
  ).toBeEnabled()
}
function region(page: Page) {
  return page.getByRole('region', { name: '游戏主机与备份任务' })
}
function dialog(page: Page) {
  return page.getByRole('dialog')
}
async function refresh(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().includes('/api/backup-jobs?') && r.status() === 200,
  )
  await region(page).getByRole('button', { name: '刷新任务', exact: true }).click()
  await response
}
async function createTask(page: Page, note: string, kind = 'MANUAL') {
  await region(page).getByRole('button', { name: '新建备份任务', exact: true }).click()
  await dialog(page).getByLabel('任务备注', { exact: true }).fill(note)
  await dialog(page).getByLabel('备份用途').selectOption(kind)
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/servers\/[^/]+\/backup-jobs$/.test(r.url()),
  )
  await dialog(page).getByRole('button', { name: '创建任务', exact: true }).click()
  const result = await response
  expect(result.status()).toBe(201)
  await expect(dialog(page)).not.toBeVisible()
  return result.json()
}
async function machine(page: Page, token: string, endpoint: string, data: unknown) {
  const response = await page.request.post('/api/host/v1' + endpoint, {
    headers: { Authorization: 'Bearer ' + token },
    data,
  })
  expect(response.ok(), await response.text()).toBe(true)
  return response.status() === 204 ? undefined : response.json()
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 360, height: 440 },
]) {
  test(`remote host config, task states and credential lifecycle ${viewport.width}`, async ({
    page,
  }, info) => {
    test.setTimeout(90000)
    await page.setViewportSize(viewport)
    if (viewport.width === 360)
      await page.addInitScript(() =>
        Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined }),
      )
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await login(page)
    const own = await server(page, '远程任务验收 ' + viewport.width),
      other = await server(page, '独立任务范围 ' + viewport.width)
    await page.reload()
    if (new URL(page.url()).pathname === '/backups')
      await page
        .getByRole('navigation', { name: '服务器备份功能' })
        .getByRole('button', { name: '备份任务', exact: true })
        .click()
    await navigate(page, own.id)
    await expect(region(page).getByRole('button', { name: '新建备份任务' })).toBeDisabled()
    await region(page).getByRole('button', { name: '连接备份程序', exact: true }).click()
    await expect(dialog(page).getByLabel('关联服务器')).toBeFocused()
    await dialog(page)
      .getByLabel('备份程序名称', { exact: true })
      .fill('一期游戏主机 ' + viewport.width)
    await dialog(page).getByRole('button', { name: '连接备份程序', exact: true }).click()
    const secret = dialog(page).getByLabel('备份程序连接密钥', { exact: true })
    await expect(secret).toBeVisible()
    const firstToken = await secret.inputValue()
    expect(firstToken).toMatch(/^mcmhost\./)
    await expect(dialog(page).getByRole('button', { name: '下载主机配置' })).toBeDisabled()
    await dialog(page).getByLabel('游戏目录', { exact: true }).fill('D:\\Minecraft\\一期')
    await dialog(page).getByLabel('备份保存目录', { exact: true }).fill('D:\\Archives')
    await dialog(page)
      .getByLabel('中央服务地址', { exact: true })
      .fill('http://192.0.2.10:8080/api')
    await expect(dialog(page).getByRole('button', { name: '下载主机配置' })).toBeDisabled()
    await dialog(page)
      .getByLabel('中央服务地址', { exact: true })
      .fill('http://192.0.2.10:8080')
    await expect(dialog(page).getByRole('button', { name: '下载主机配置' })).toBeDisabled()
    await dialog(page).getByLabel('确认使用可信局域网 HTTP').check()
    const downloadEvent = page.waitForEvent('download')
    await dialog(page).getByRole('button', { name: '下载主机配置' }).click()
    const download = await downloadEvent
    const config = JSON.parse(await readFile((await download.path())!, 'utf8'))
    expect(config).toEqual({
      apiUrl: 'http://192.0.2.10:8080',
      token: firstToken,
      root: 'D:\\Minecraft\\一期',
      outputDirectory: 'D:\\Archives',
      serverId: own.id,
      allowHttp: true,
    })
    await dialog(page)
      .getByLabel('恢复父目录（可选）', { exact: true })
      .fill('D:\\MinecraftRestores')
    const restoreConfigDownload = page.waitForEvent('download')
    await dialog(page).getByRole('button', { name: '下载主机配置' }).click()
    const restoreConfig = JSON.parse(
      await readFile((await (await restoreConfigDownload).path())!, 'utf8'),
    )
    expect(restoreConfig).toEqual({ ...config, restoreDirectory: 'D:\\MinecraftRestores' })
    await dialog(page).getByRole('button', { name: '已保存，关闭' }).click()
    await expect(page.getByLabel('备份程序连接密钥', { exact: true })).toHaveCount(0)
    const host = region(page).locator('[data-backup-host]')
    await expect(host).toContainText('尚未连接')
    await expect(
      region(page).getByRole('button', { name: '连接备份程序', exact: true }),
    ).toBeDisabled()
    const queued = await createTask(page, '封存任务 <script>保持文本</script>', 'FINAL')
    expect(queued.permanent).toBe(true)
    const queuedCard = region(page).locator(`[data-backup-job="${queued.id}"]`)
    await expect(queuedCard).toContainText('等待执行')
    await queuedCard.getByText('查看任务记录').click()
    await expect(queuedCard).toContainText('永久保留')
    await queuedCard.getByRole('button', { name: '取消任务', exact: true }).click()
    await dialog(page).getByRole('button', { name: '确认取消', exact: true }).click()
    await expect(queuedCard).toContainText('已取消')
    const runId = randomUUID()
    await machine(page, firstToken, '/heartbeat', { runId, state: 'RUNNING', version: '0.3.0' })
    await refresh(page)
    await expect(host).toContainText('游戏运行中')
    const running = await createTask(page, '等待主机确认取消')
    const claim = await machine(page, firstToken, '/jobs/claim', { runId, requestId: randomUUID() })
    expect(claim.job.id).toBe(running.id)
    await refresh(page)
    const card = region(page).locator(`[data-backup-job="${running.id}"]`)
    await expect(card).toContainText('已领取')
    const lease = { runId, attemptId: claim.attemptId }
    await machine(page, firstToken, `/jobs/${running.id}/start`, lease)
    await refresh(page)
    await expect(card).toContainText('正在制作')
    await card.getByRole('button', { name: '请求取消', exact: true }).click()
    await dialog(page).getByRole('button', { name: '确认取消', exact: true }).click()
    await expect(card).toContainText('正在请求取消')
    const state = await (await page.request.get('/api/backup-jobs/' + running.id)).json()
    expect(state.status).toBe('RUNNING')
    expect(state.cancelRequested).toBe(true)
    await machine(page, firstToken, `/jobs/${running.id}/report`, {
      ...lease,
      outcome: 'UNCERTAIN',
      code: 'EXECUTION_INTERRUPTED',
    })
    await refresh(page)
    await card.getByRole('button', { name: '处理结果', exact: true }).click()
    await dialog(page)
      .getByLabel('处理说明', { exact: true })
      .fill('已核对主机，没有完整归档；保留诊断。')
    await dialog(page).getByRole('button', { name: '保存处理结果', exact: true }).click()
    await expect(card).toContainText('已失败')
    await expect(card).toContainText('已核对主机，没有完整归档；保留诊断。')
    await page.getByLabel('统计范围').selectOption(other.id)
    await page
      .getByRole('navigation', { name: '服务器备份功能' })
      .getByRole('button', { name: '备份任务', exact: true })
      .click()
    await expect(region(page).locator('[data-backup-host]')).toHaveCount(0)
    await expect(region(page).locator('[data-backup-job]')).toHaveCount(0)
    await page.getByLabel('统计范围').selectOption(own.id)
    await page
      .getByRole('navigation', { name: '服务器备份功能' })
      .getByRole('button', { name: '备份任务', exact: true })
      .click()
    await expect(host).toBeVisible()
    await host.getByRole('button', { name: '更换连接密钥' }).click()
    await dialog(page).getByRole('button', { name: '生成新连接密钥' }).click()
    await expect(secret).toBeVisible()
    const secondToken = await secret.inputValue()
    expect(secondToken).not.toBe(firstToken)
    await dialog(page).getByRole('button', { name: '已保存，关闭' }).click()
    const heartbeat = (token: string) =>
      page.request.post('/api/host/v1/heartbeat', {
        headers: { Authorization: 'Bearer ' + token },
        data: { runId: randomUUID(), state: 'STOPPED', version: '0.3.0' },
      })
    expect((await heartbeat(firstToken)).status()).toBe(401)
    expect((await heartbeat(secondToken)).status()).toBe(200)
    await host.getByRole('button', { name: '停用备份程序', exact: true }).click()
    await dialog(page).getByRole('button', { name: '停用备份程序', exact: true }).click()
    await expect(host).toContainText('连接密钥已停用')
    expect((await heartbeat(secondToken)).status()).toBe(401)
    await host.getByRole('button', { name: '重新启用' }).click()
    await dialog(page).getByRole('button', { name: '生成新连接密钥' }).click()
    await expect(secret).toBeVisible()
    const thirdToken = await secret.inputValue()
    await dialog(page).getByRole('button', { name: '已保存，关闭' }).click()
    expect((await heartbeat(thirdToken)).status()).toBe(200)
    await refresh(page)
    await expect(host).toContainText('执行程序已停止')
    await host.getByRole('button', { name: '更换连接密钥' }).click()
    await page.keyboard.press('Escape')
    await expect(host.getByRole('button', { name: '更换连接密钥' })).toBeFocused()
    await expect(page.getByLabel('备份程序连接密钥', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: info.outputPath(`remote-tasks-${viewport.width}.png`),
      fullPage: true,
    })
    await mutate(page, '/backup-hosts/' + queued.hostId, undefined, 'DELETE')
    expect(failures).toEqual([])
  })
}

test('a lost enqueue response survives reload, revocation and another scope without creating a duplicate', async ({
  page,
}) => {
  await login(page)
  const own = await server(page, '任务回执丢失'),
    other = await server(page, '回执重试另一范围')
  const issued = await mutate(page, '/backup-hosts', { serverId: own.id, name: '回执验收主机' })
  await page.reload()
  if (new URL(page.url()).pathname === '/backups')
    await page
      .getByRole('navigation', { name: '服务器备份功能' })
      .getByRole('button', { name: '备份任务', exact: true })
      .click()
  await navigate(page, own.id)
  let body: unknown, task: { id: string }
  await page.route(
    `**/api/servers/${own.id}/backup-jobs`,
    async (route) => {
      body = route.request().postDataJSON()
      const response = await route.fetch()
      expect(response.status()).toBe(201)
      task = await response.json()
      await route.abort('failed')
    },
    { times: 1 },
  )
  await region(page).getByRole('button', { name: '新建备份任务' }).click()
  await dialog(page).getByLabel('任务备注').fill('只制作一次')
  await dialog(page).getByRole('button', { name: '创建任务', exact: true }).click()
  await expect(dialog(page)).toContainText('提交结果尚未确认')
  await expect(dialog(page).getByLabel('任务备注')).toBeDisabled()
  const saved = await page.evaluate(() =>
    sessionStorage.getItem('mcmanager.pending-backup-task.v1'),
  )
  expect(JSON.parse(saved!)).toEqual({ ...(body as object), serverId: own.id })
  await mutate(page, '/backup-hosts/' + issued.host.id, undefined, 'DELETE')
  await page.reload()
  if (new URL(page.url()).pathname === '/backups')
    await page
      .getByRole('navigation', { name: '服务器备份功能' })
      .getByRole('button', { name: '备份任务', exact: true })
      .click()
  await navigate(page, other.id)
  await region(page).getByRole('button', { name: '核实上次提交' }).click()
  await expect(dialog(page).getByLabel('备份服务器')).toHaveValue(own.id)
  await expect(dialog(page).getByLabel('备份服务器')).toBeDisabled()
  const submitted = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/servers/${own.id}/backup-jobs`),
  )
  await dialog(page).getByRole('button', { name: '重试并核实任务' }).click()
  expect((await submitted).postDataJSON()).toEqual(body)
  await expect(dialog(page)).not.toBeVisible()
  await expect(region(page).getByRole('button', { name: '核实上次提交' })).toHaveCount(0)
  const jobs = await (await page.request.get(`/api/backup-jobs?serverId=${own.id}`)).json()
  expect(jobs.total).toBe(1)
  expect(jobs.items[0].id).toBe(task!.id)
  expect(jobs.items[0].status).toBe('CANCELLED')
  expect(
    await page.evaluate(() => sessionStorage.getItem('mcmanager.pending-backup-task.v1')),
  ).toBeNull()
  await mutate(page, '/backup-hosts/' + issued.host.id, undefined, 'DELETE')
})

test('task polling rejects stale scopes, recovers from network failures and expires the session', async ({
  page,
}) => {
  await login(page)
  const slow = await server(page, '慢任务范围'),
    fast = await server(page, '快任务范围')
  const issued = await mutate(page, '/backup-hosts', { serverId: slow.id, name: '慢响应执行端' })
  await page.reload()
  if (new URL(page.url()).pathname === '/backups')
    await page
      .getByRole('navigation', { name: '服务器备份功能' })
      .getByRole('button', { name: '备份任务', exact: true })
      .click()
  await navigate(page, fast.id)
  let release!: () => void, seen!: () => void
  const hold = new Promise<void>((resolve) => {
      release = resolve
    }),
    observed = new Promise<void>((resolve) => {
      seen = resolve
    })
  await page.route('**/api/backup-hosts?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('serverId') !== slow.id)
      return route.continue()
    const response = await route.fetch()
    seen()
    await hold
    try {
      await route.fulfill({ response })
    } catch {
      /* Cancelled real response. */
    }
  })
  await page.getByLabel('统计范围').selectOption(slow.id)
  await page
    .getByRole('navigation', { name: '服务器备份功能' })
    .getByRole('button', { name: '备份任务', exact: true })
    .click()
  await observed
  await page.getByLabel('统计范围').selectOption(fast.id)
  await page
    .getByRole('navigation', { name: '服务器备份功能' })
    .getByRole('button', { name: '备份任务', exact: true })
    .click()
  await expect(
    region(page).getByRole('button', { name: '连接备份程序', exact: true }),
  ).toBeEnabled()
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await expect(region(page).locator('[data-backup-host]')).toHaveCount(0)
  await page.context().setOffline(true)
  await region(page).getByRole('button', { name: '刷新任务' }).click()
  await expect(region(page).getByRole('alert')).toContainText('无法连接服务器')
  await page.context().setOffline(false)
  await region(page).getByRole('button', { name: '重试任务列表' }).click()
  await expect(region(page).getByRole('alert')).toHaveCount(0)
  await mutate(page, '/backup-hosts/' + issued.host.id, undefined, 'DELETE')
  await mutate(page, '/auth/logout')
  await region(page).getByRole('button', { name: '刷新任务' }).click()
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
})
