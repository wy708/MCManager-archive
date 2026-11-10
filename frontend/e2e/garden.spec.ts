import { test, expect, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '进入工作台' })).toBeEnabled()
  await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '今天的方块世界' })).toBeVisible()
}
async function mutate(page: Page, path: string, data: unknown) {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const res = await page.request.post('/api' + path, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return res.json()
}
async function navigate(page: Page, label: string) {
  const toggle = page.getByRole('button', { name: '切换导航' })
  if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click()
  await page.locator('#navigation').getByRole('button', { name: label, exact: true }).click()
  await expect(page.locator('main h1')).toHaveText(label === '数据总览' ? '今天的方块世界' : label)
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => ({
      width: innerWidth,
      content: document.documentElement.scrollWidth,
    })),
  ).toEqual({ width: page.viewportSize()!.width, content: page.viewportSize()!.width })
}
test('desktop and phone: every page reachable, routes persist, find features, projects and settings', async ({
  page,
}, testInfo) => {
  test.setTimeout(180000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await login(page)
  const server = await mutate(page, '/servers', {
    name: '花园设计验收世界',
    description: '隔离测试数据，用于布局与操作验收',
    startDate: '2026-11-01',
  })
  await mutate(page, `/servers/${server.id}/projects`, {
    action: 'CREATE',
    requestId: crypto.randomUUID(),
    name: '林间小屋',
    dimension: 'minecraft:overworld',
    x1: 0,
    z1: 0,
    x2: 16,
    z2: 16,
  })
  await page.reload()
  await page.getByLabel('统计范围').selectOption(server.id)
  const pages = [
    '数据总览',
    '服务器档案',
    '玩家统计',
    '行为统计',
    '世界地图',
    '施工工程',
    '世界故事馆',
    '服务器日报',
    '运行状况',
    '服务器控制台',
    'AI 助手',
    '备份中心',
    '账号管理',
    '平台设置',
  ]
  for (const viewport of [
    { width: 1586, height: 992 },
    { width: 390, height: 844 },
    { width: 360, height: 740 },
    { width: 768, height: 1024 },
  ]) {
    await page.setViewportSize(viewport)
    for (const label of pages) {
      await navigate(page, label)
      // Wait for the asynchronously loaded page component, then measure layout.
      await expect(page.locator('main#main-content>footer')).toBeVisible()
      await page.waitForTimeout(180)
      await noOverflow(page)
      if (viewport.width === 1586 || viewport.width === 390)
        await page.screenshot({
          path: testInfo.outputPath(`${viewport.width}-${label}.png`),
          fullPage: true,
        })
    }
    await page.getByRole('button', { name: '找功能', exact: true }).click()
    await page.getByRole('searchbox', { name: '搜索功能' }).fill('导出模型')
    await expect(page.locator('.finder-results button')).toHaveCount(1)
    await page.locator('.finder-results button').click()
    await expect(page.locator('main h1')).toHaveText('施工工程')
    await page.getByLabel('查找工程').fill('林间小屋')
    await expect(page.locator('.project-card')).toHaveCount(1)
    await page.getByLabel('查找工程').fill('不存在的工程')
    await expect(page.locator('.project-card')).toHaveCount(0)
    await page.reload()
    await expect(page.locator('main h1')).toHaveText('施工工程')
    await expect(page.getByLabel('统计范围')).toHaveValue(server.id)
    await navigate(page, '平台设置')
    await page.getByRole('button', { name: '数据与存储', exact: true }).click()
    await expect(page.locator('.collector-card')).toHaveCount(0)
    await noOverflow(page)
    await page.getByRole('button', { name: '游戏插件连接', exact: true }).click()
    await expect(page.locator('.collector-card')).toHaveCount(1)
  }
  expect(errors).toEqual([])
})

test('feature finder keyboard and read-only navigation preserve permission boundaries', async ({
  page,
}) => {
  await login(page)
  await page.getByRole('button', { name: '找功能', exact: true }).click()
  await expect(page.getByRole('searchbox', { name: '搜索功能' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByRole('button', { name: '找功能', exact: true })).toBeFocused()
  const name = 'gardenviewer' + Date.now()
  await mutate(page, '/admin/accounts', {
    username: name,
    password: 'garden-viewer-test-2026',
    role: 'VIEWER',
  })
  await page.locator('.account-menu summary').click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await page.getByLabel('用户名', { exact: true }).fill(name)
  await page.getByLabel('密码', { exact: true }).fill('garden-viewer-test-2026')
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.locator('.app-shell')).toBeVisible()
  await page.getByRole('button', { name: '找功能', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索功能' }).fill('控制台')
  await expect(page.locator('.finder-results button')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.goto('/accounts')
  await expect(page.locator('main h1')).toHaveText('今天的方块世界')
})
