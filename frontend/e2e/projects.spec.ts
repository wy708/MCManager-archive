import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
async function mutate(page: Page, path: string, data: unknown) {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const r = await page.request.post('/api' + path, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  })
  expect(r.ok(), await r.text()).toBe(true)
  return r.json()
}
for (const width of [1440, 390])
  test(`construction public view, range history and reports ${width}`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width, height: 960 })
    await page.goto('/')
    await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
    await page.getByRole('button', { name: '进入工作台' }).click()
    await expect(page.getByRole('heading', { name: '今天的方块世界', exact: true })).toBeVisible()
    const server = await mutate(page, '/servers', {
      name: `隔离网页验收 ${width}`,
      description: 'Isolated browser QA only',
      startDate: '2020-01-01',
    })
    await page.goto('/projects?server=' + server.id)
    await page.getByRole('button', { name: '新建工程' }).click()
    await page.getByLabel('工程名称').fill('林间小屋')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.project-card')).toContainText('林间小屋')
    const projects = await (await page.request.get(`/api/servers/${server.id}/projects`)).json()
    const id = projects[0].id
    const credential = await mutate(page, `/servers/${server.id}/collector-credential`, {})
    const at = new Date().toISOString()
    const ingested = await page.request.post('/api/ingest/v1/batches', {
      headers: { Authorization: 'Bearer ' + credential.token },
      data: {
        protocolVersion: 1,
        batchId: randomUUID(),
        reportedAt: at,
        collector: {
          version: 'isolated-ui-qa',
          bdsVersion: 'qa',
          leviLaminaVersion: 'qa',
          bootId: randomUUID(),
          pendingEvents: 0,
        },
        capabilities: [
          {
            metric: 'blocks.placed',
            state: 'ACTIVE',
            quality: 'EXACT',
            algorithmVersion: 'qa-v1',
            dimensionAware: true,
          },
        ],
        events: [
          {
            eventId: randomUUID(),
            kind: 'COUNTER',
            at,
            player: { identityType: 'XUID', identity: '123456789', name: '小筑' },
            dimension: 'minecraft:overworld',
            metric: 'blocks.placed',
            value: 1,
            subject: 'minecraft:stone',
            position: { x: 5, y: 64, z: 5 },
          },
        ],
      },
    })
    expect(ingested.ok(), await ingested.text()).toBe(true)
    const context = await browser.newContext({ viewport: { width, height: 960 } })
    const publicPage = await context.newPage()
    const errors: string[] = []
    publicPage.on('pageerror', (e) => errors.push(e.message))
    await publicPage.goto('http://127.0.0.1:5174/projects/' + id)
    await expect(publicPage.getByRole('heading', { name: '林间小屋', exact: true })).toBeVisible()
    await expect(publicPage.locator('.project-legend')).toContainText('石头')
    await expect(publicPage.locator('.project-legend img')).toHaveJSProperty('naturalWidth', 16)
    await expect(publicPage.getByRole('img', { name: '施工玩家贡献' })).toBeVisible()
    expect(
      await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true)
    await publicPage.screenshot({
      path: `test-results/project-public-${width}.png`,
      fullPage: true,
    })
    await page.getByRole('button', { name: '修改范围' }).click()
    await page.getByLabel('X2', { exact: true }).fill('32')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.project-card')).toContainText('第 2 阶段')
    await publicPage.reload()
    await expect(publicPage.locator('.project-toolbar')).toContainText('32')
    await publicPage.getByLabel('查看阶段').selectOption('1')
    await expect(publicPage.locator('.project-toolbar')).toContainText('16')
    await expect(publicPage.locator('.project-banner')).toContainText('已封存')
    await page.getByRole('button', { name: '完成封存' }).click()
    await expect(page.locator('.project-card')).toContainText('已封存')
    await page.getByRole('button', { name: '继续施工' }).click()
    await expect(page.locator('.project-card')).toContainText('第 3 阶段')
    await page.goto('/reports?server=' + server.id)
    await page
      .getByLabel('日报日期')
      .fill(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Hong_Kong' }).format(new Date()))
    await expect(page.locator('.report-totals')).toContainText('放置方块')
    await expect(page.getByRole('img', { name: '七天放置与挖掘趋势' })).toBeVisible()
    await page.screenshot({ path: `test-results/project-report-${width}.png`, fullPage: true })
    await page.reload()
    await expect(page.getByRole('heading', { name: '服务器日报', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    await page.goto('/projects?server=' + server.id)
    await page.getByRole('button', { name: '删除工程', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('林间小屋')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('.project-card')).toContainText('林间小屋')
    await page.getByRole('button', { name: '删除工程', exact: true }).click()
    await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.locator('.project-card')).toHaveCount(0)
    expect(
      (await publicPage.request.get('http://127.0.0.1:5174/api/public/projects/' + id)).status(),
    ).toBe(404)
    await publicPage.reload()
    await expect(publicPage.getByRole('heading', { name: '林间小屋', exact: true })).toHaveCount(0)
    await context.close()
  })
