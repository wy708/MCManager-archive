import { test, expect, type Page } from '@playwright/test'
async function mutate(page: Page, path: string, data: unknown, method = 'POST') {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const response = await page.request.fetch('/api' + path, {
    method,
    headers: { [csrf.headerName]: csrf.token },
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
  test(`automatic policy settings, scope and conflicting edits ${viewport.width}`, async ({
    page,
  }, info) => {
    test.setTimeout(60000)
    await page.setViewportSize(viewport)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
    await page.getByRole('button', { name: '进入工作台' }).click()
    await expect(page.getByRole('heading', { name: '今天的方块世界', exact: true })).toBeVisible()
    const own = await mutate(page, '/servers', {
      name: '自动策略验收 ' + viewport.width,
      description: 'Protocol UI QA, not gameplay',
      startDate: '2020-01-01',
    })
    const other = await mutate(page, '/servers', {
      name: '独立策略范围 ' + viewport.width,
      description: '',
      startDate: '2020-01-01',
    })
    const host = await mutate(page, '/backup-hosts', { serverId: own.id, name: '自动策略主机' })
    await page.reload()
    await page.getByLabel('统计范围').selectOption(own.id)
    const menu = page.getByRole('button', { name: '切换导航' })
    if (await menu.isVisible()) await menu.click()
    await page.locator('.sidebar').getByRole('button', { name: '备份中心', exact: true }).click()
    await page
      .getByRole('navigation', { name: '服务器备份功能' })
      .getByRole('button', { name: '每日定时' })
      .click()
    const panel = page.getByRole('region', { name: '自动备份与清理' }),
      dialog = page.getByRole('dialog')
    const configure = panel.getByRole('button', { name: '配置自动备份' })
    await expect(configure).toBeEnabled()
    await configure.click()
    await expect(dialog.getByLabel('策略所属服务器')).toBeFocused()
    await expect(dialog.getByLabel('启用每日自动备份')).not.toBeChecked()
    await expect(
      dialog.getByLabel('启用自动清理旧备份，删除超出规则的普通自动备份'),
    ).not.toBeChecked()
    await dialog.getByLabel('启用每日自动备份').check()
    await dialog.getByLabel('每天备份时间（UTC+8）').fill('03:30')
    await dialog.getByLabel('启用自动清理旧备份，删除超出规则的普通自动备份').check()
    await dialog.getByLabel('保留普通自动备份数量').fill('2')
    await dialog.getByLabel('保留天数').fill('14')
    await dialog.getByRole('button', { name: '查看将清理哪些备份' }).click()
    await expect(dialog.getByRole('status')).toContainText('当前符合规则：0 份')
    await dialog.getByRole('button', { name: '保存备份策略' }).click()
    await expect(dialog).not.toBeVisible()
    const card = panel.locator(`[data-backup-policy="${own.id}"]`)
    await expect(card).toContainText('每天 03:30（UTC+8）')
    await expect(card).toContainText('2 份 / 14 天')
    const saved = (
      await (await page.request.get(`/api/backup-policies?serverId=${own.id}`)).json()
    )[0]
    expect(saved.revision).toBe(1)
    expect(saved.nextRunAt).toBeTruthy()
    await configure.click()
    await expect(dialog.getByLabel('保留普通自动备份数量')).toHaveValue('2')
    await expect(dialog.getByLabel('每天备份时间（UTC+8）')).toHaveValue('03:30')
    await mutate(
      page,
      `/servers/${own.id}/backup-policy`,
      {
        revision: 1,
        hostId: host.host.id,
        enabled: true,
        intervalMinutes: 1440,
        dailyTime: '03:30',
        firstRunAt: null,
        retentionEnabled: true,
        keepCount: 3,
        maxAgeDays: 14,
      },
      'PUT',
    )
    await dialog.getByRole('button', { name: '保存备份策略' }).click()
    await expect(dialog.getByRole('alert')).toContainText('策略已变更')
    await dialog.getByRole('button', { name: '重新加载已保存设置' }).click()
    await expect(dialog.getByLabel('保留普通自动备份数量')).toHaveValue('3')
    await dialog.getByLabel('启用每日自动备份').uncheck()
    await dialog.getByLabel('启用自动清理旧备份，删除超出规则的普通自动备份').uncheck()
    await dialog.getByRole('button', { name: '保存备份策略' }).click()
    await expect(dialog).not.toBeVisible()
    await expect(card).toContainText('自动备份已关闭')
    await expect(card).toContainText('自动清理旧备份已关闭')
    const disabled = (
      await (await page.request.get(`/api/backup-policies?serverId=${own.id}`)).json()
    )[0]
    expect(disabled.revision).toBe(3)
    expect(disabled.nextRunAt).toBeNull()
    await configure.click()
    await page.keyboard.press('Escape')
    await expect(configure).toBeFocused()
    await page.getByLabel('统计范围').selectOption(other.id)
    await page
      .getByRole('navigation', { name: '服务器备份功能' })
      .getByRole('button', { name: '每日定时' })
      .click()
    await expect(panel.locator('[data-backup-policy]')).toHaveCount(0)
    await expect(configure).toBeDisabled()
    await page.getByLabel('统计范围').selectOption(own.id)
    await page
      .getByRole('navigation', { name: '服务器备份功能' })
      .getByRole('button', { name: '每日定时' })
      .click()
    await expect(card).toBeVisible()
    await page.context().setOffline(true)
    await panel.getByRole('button', { name: '刷新策略' }).click()
    await expect(panel.getByRole('alert')).toContainText('无法连接服务器')
    await page.context().setOffline(false)
    await panel.getByRole('button', { name: '重试策略列表' }).click()
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(card).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: info.outputPath(`automatic-policy-${viewport.width}.png`),
      fullPage: true,
    })
    await mutate(page, '/backup-hosts/' + host.host.id, undefined, 'DELETE')
    expect(errors).toEqual([])
  })
}
