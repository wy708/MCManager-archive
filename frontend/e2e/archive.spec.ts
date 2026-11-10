import { expect, test, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '进入工作台' })).toBeEnabled()
  await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.getByRole('heading', { name: '今天的方块世界' })).toBeVisible()
}

test('actual session, CSRF protection, archive lifecycle and scope', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (ex) => errors.push(ex.message))
  await page.goto('/')
  await expect(page.getByRole('button', { name: '进入工作台' })).toBeEnabled()
  await page.getByLabel('密码', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.getByRole('alert')).toContainText('用户名或密码不正确')
  await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.getByRole('heading', { name: '今天的方块世界' })).toBeVisible()
  const noCsrf = await page.request.post('/api/servers', {
    data: { name: 'attack', description: '', startDate: '2026-10-01' },
  })
  expect(noCsrf.status()).toBe(403)

  await page.getByRole('button', { name: '添加服务器', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('服务器名称')).toBeFocused()
  await dialog.getByLabel('服务器名称').fill('浏览器验收世界')
  await dialog.getByLabel('开服日期').fill('2026-10-01')
  await dialog.getByLabel('服务器介绍').fill('<script>alert("unsafe")</script> 秋日记忆')
  await dialog.getByRole('button', { name: '创建档案' }).click()
  await expect(dialog).not.toBeVisible()
  const card = page.locator('.server-card').filter({ hasText: '浏览器验收世界' })
  await expect(card).toBeVisible()
  await expect(card).toContainText('<script>alert("unsafe")</script>')
  await card.getByRole('button', { name: '编辑档案' }).click()
  await dialog.getByLabel('服务器名称').fill('浏览器验收世界 · 已修改')
  await dialog.getByRole('button', { name: '保存修改' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(card).toContainText('浏览器验收世界 · 已修改')

  await card.getByRole('button', { name: '封存 浏览器验收世界 · 已修改' }).click()
  await dialog.getByLabel('结束日期').fill('2026-10-26')
  await dialog.getByRole('button', { name: '确认封存' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(card.locator('.status')).toHaveText('已封存')
  const archives = await (await page.request.get('/api/servers')).json()
  const saved = archives.find((s: { name: string }) => s.name === '浏览器验收世界 · 已修改')
  expect(saved.status).toBe('ARCHIVED')
  await page.getByLabel('统计范围').selectOption(saved.id)
  await expect(page.locator('.server-card')).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole('heading', { name: '服务器档案' })).toBeVisible()
  await expect(page.getByLabel('统计范围')).toHaveValue(saved.id)
  await expect(card.locator('.status')).toHaveText('已封存')
  await page.getByRole('button', { name: '数据总览', exact: true }).click()
  await expect(page.getByRole('heading', { name: '今天的方块世界' })).toBeVisible()
  await expect(
    page.locator('.world-preview').filter({ hasText: '浏览器验收世界 · 已修改' }),
  ).toBeVisible()
  await page.locator('.account-menu summary').click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible()
  expect((await page.request.get('/api/servers')).status()).toBe(401)
  expect(errors).toEqual([])
})

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 360, height: 440 },
]) {
  test(`layout and keyboard dialog at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport)
    await login(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('overview.png'), fullPage: true })
    await page.getByRole('button', { name: '添加服务器', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('服务器名称')).toBeFocused()
    await dialog.getByLabel('服务器名称').fill('键盘检查')
    const position = await dialog.boundingBox()
    expect(position!.x).toBeGreaterThanOrEqual(0)
    expect(position!.y).toBeGreaterThanOrEqual(0)
    expect(position!.width).toBeLessThanOrEqual(viewport.width)
    expect(position!.height).toBeLessThanOrEqual(viewport.height)
    await dialog.getByRole('button', { name: '取消', exact: true }).scrollIntoViewIfNeeded()
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('dialog.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(
      page.getByRole('button', { name: '添加服务器', exact: true }).first(),
    ).toBeFocused()
    if (viewport.width < 680) {
      await page.getByRole('button', { name: '切换导航' }).click()
      await page.getByRole('button', { name: '服务器档案', exact: false }).first().click()
      await expect(page.getByRole('heading', { name: '服务器档案', exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    }
  })
}

test('server outage can be retried without discarding the form', async ({ page }) => {
  await login(page)
  await page.getByRole('button', { name: '添加服务器', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('服务器名称').fill('错误恢复世界')
  await page.context().setOffline(true)
  await dialog.getByRole('button', { name: '创建档案' }).click()
  await expect(dialog.getByRole('alert')).toContainText('无法连接服务器')
  await expect(dialog.getByLabel('服务器名称')).toHaveValue('错误恢复世界')
  await page.context().setOffline(false)
  await dialog.getByRole('button', { name: '创建档案' }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('heading', { name: '错误恢复世界' })).toBeVisible()
})
