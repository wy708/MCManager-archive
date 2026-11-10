import { test, expect, type Page } from '@playwright/test'

async function mutate(page: Page, path: string, data: unknown) {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const response = await page.request.post('/api' + path, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  })
  expect(response.ok()).toBe(true)
  return response.json()
}
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 360, height: 440 },
]) {
  test(`Agent permissions, once-only token, rotation and revocation ${viewport.width}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    const failures: string[] = []
    page.on('pageerror', (error) => failures.push(error.message))
    await page.goto('/')
    await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
    await page.getByRole('button', { name: '进入工作台' }).click()
    await expect(page.getByRole('heading', { name: '今天的方块世界', exact: true })).toBeVisible()
    const name = `Agent 验收服 ${viewport.width}`
    const server = await mutate(page, '/servers', {
      name,
      description: 'Browser protocol QA, not gameplay',
      startDate: '2020-01-01',
    })
    const other = await mutate(page, '/servers', {
      name: `无授权服 ${viewport.width}`,
      description: '',
      startDate: '2020-01-01',
    })
    await page.reload()
    await page.getByLabel('统计范围').selectOption(server.id)
    const menu = page.getByRole('button', { name: '切换导航' })
    if (await menu.isVisible()) await menu.click()
    await page.locator('.sidebar').getByRole('button', { name: 'AI 助手', exact: true }).click()
    await page.getByRole('button', { name: '添加助手', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: '生成助手连接密钥' })).toBeDisabled()
    await dialog.getByLabel('助手名称', { exact: true }).fill(`监控助手 ${viewport.width}`)
    await dialog.getByLabel(`${name}：读取统计`, { exact: true }).check()
    await dialog.getByLabel(`${name}：读取聊天`, { exact: true }).check()
    await dialog.getByLabel(`${name}：管理 QQ 绑定`, { exact: true }).check()
    await dialog.getByLabel(`${name}：查询世界状态`, { exact: true }).check()
    await expect(dialog.getByLabel(`${name}：发送回复`, { exact: true })).not.toBeChecked()
    await dialog.getByRole('button', { name: '生成助手连接密钥' }).click()
    const secret = dialog.getByLabel('助手连接密钥', { exact: true })
    await expect(secret).toBeVisible()
    const firstToken = await secret.inputValue()
    expect(firstToken).toMatch(/^mcmagent\./)
    await dialog.getByText('查看 MCP 配置', { exact: true }).click()
    const config = JSON.parse(await dialog.getByLabel('MCP 配置', { exact: true }).inputValue())
    expect(config.mcpServers['mcmanager-archive'].env.MCM_AGENT_TOKEN).toBe(firstToken)
    await dialog.getByRole('button', { name: '已保存，关闭' }).click()
    await expect(page.getByLabel('助手连接密钥', { exact: true })).toHaveCount(0)
    const card = page.locator('.agent-card').filter({ hasText: `监控助手 ${viewport.width}` })
    await expect(card).toBeVisible()
    await expect(card.locator('.agent-grants')).not.toContainText('发送回复')
    await expect(card.locator('.agent-grants')).toContainText('管理 QQ 绑定')
    await expect(card.locator('.agent-grants')).toContainText('查询世界状态')
    const bearer = { Authorization: 'Bearer ' + firstToken }
    const binding = await page.request.get(`/api/agent/servers/${server.id}/qq-bindings/12345678`, {
      headers: bearer,
    })
    expect(binding.status()).toBe(200)
    expect((await binding.json()).bound).toBe(false)
    const snapshot = await page.request.get(
      `/api/agent/servers/${server.id}/players/xuid:123456789/world-snapshot`,
      { headers: bearer },
    )
    expect(snapshot.status()).toBe(200)
    expect((await snapshot.json()).status).toBe('NO_RECORD')
    expect(
      (
        await page.request.get(`/api/agent/servers/${other.id}/statistics`, { headers: bearer })
      ).status(),
    ).toBe(403)
    expect(
      (
        await page.request.get(`/api/agent/servers/${server.id}/statistics`, { headers: bearer })
      ).status(),
    ).toBe(200)
    await card.getByRole('button', { name: '编辑授权' }).click()
    await dialog.getByLabel(`${name}：发送回复`, { exact: true }).check()
    await dialog.getByRole('button', { name: '保存授权' }).click()
    await expect(card.locator('.agent-grants')).toContainText('发送回复')
    await card.getByRole('button', { name: '编辑授权' }).click()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(card.getByRole('button', { name: '编辑授权' })).toBeFocused()
    await card.getByRole('button', { name: '更换连接密钥' }).click()
    await dialog.getByRole('button', { name: '生成新连接密钥' }).click()
    const secondToken = await secret.inputValue()
    expect(secondToken).not.toBe(firstToken)
    await dialog.getByRole('button', { name: '已保存，关闭' }).click()
    expect((await page.request.get('/api/agent/servers', { headers: bearer })).status()).toBe(401)
    expect(
      (
        await page.request.get('/api/agent/servers', {
          headers: { Authorization: 'Bearer ' + secondToken },
        })
      ).status(),
    ).toBe(200)
    await card.getByRole('button', { name: '停用助手' }).click()
    await dialog.getByRole('button', { name: '确认撤销' }).click()
    await expect(card).toContainText('连接密钥已停用')
    expect(
      (
        await page.request.get('/api/agent/servers', {
          headers: { Authorization: 'Bearer ' + secondToken },
        })
      ).status(),
    ).toBe(401)
    await card.getByRole('button', { name: '重新启用' }).click()
    await dialog.getByRole('button', { name: '生成新连接密钥' }).click()
    const activeToken = await secret.inputValue()
    await dialog.getByRole('button', { name: '已保存，关闭' }).click()
    await expect(card).toContainText('连接密钥已启用')
    expect(
      (
        await page.request.get('/api/agent/servers', {
          headers: { Authorization: 'Bearer ' + activeToken },
        })
      ).status(),
    ).toBe(200)
    await expect(page.getByLabel('助手连接密钥', { exact: true })).toHaveCount(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    expect(failures).toEqual([])
    await page.screenshot({ path: `../.tools/agent-ui-${viewport.width}.png`, fullPage: true })
  })
}
