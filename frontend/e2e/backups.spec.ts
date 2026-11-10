import { test, expect, type Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import path from 'node:path'

async function createServer(page: Page, name: string) {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const result = await page.request.post('/api/servers', {
    headers: { [csrf.headerName]: csrf.token },
    data: {
      name,
      description: 'Synthetic upload fixture, not game evidence',
      startDate: '2020-01-01',
    },
  })
  expect(result.ok()).toBe(true)
  return result.json()
}
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 360, height: 440 },
]) {
  test(`backup upload verification protection download and deletion ${viewport.width}`, async ({
    page,
  }, info) => {
    test.setTimeout(90000)
    await page.setViewportSize(viewport)
    if (viewport.width === 360) {
      await page.addInitScript(() =>
        Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined }),
      )
    }
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
    await page.getByRole('button', { name: '进入工作台' }).click()
    await expect(page.getByRole('heading', { name: '今天的方块世界', exact: true })).toBeVisible()
    const server = await createServer(page, `备份验收服 ${viewport.width}`)
    const other = await createServer(page, `独立备份范围 ${viewport.width}`)
    const folder = info.outputPath('fixture')
    await mkdir(folder)
    const archive = path.join(folder, 'fixture.tar.gz')
    await promisify(execFile)(process.execPath, [
      path.resolve('../backup/qa/create-upload-fixture.mjs'),
      folder,
      server.id,
      archive,
    ])
    const original = await readFile(archive),
      hash = createHash('sha256').update(original).digest('hex')
    await page.reload()
    await page.getByLabel('统计范围').selectOption(server.id)
    const menu = page.getByRole('button', { name: '切换导航' })
    if (await menu.isVisible()) await menu.click()
    await page.locator('.sidebar').getByRole('button', { name: '备份中心', exact: true }).click()
    await page.getByRole('button', { name: '上传备份', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: '上传并校验', exact: true })).toBeDisabled()
    await expect(dialog.getByLabel('所属服务器')).toHaveValue(server.id)
    await dialog.getByLabel('备份归档文件').setInputFiles(archive)
    await dialog.getByLabel('备份备注').fill('冒险纪念 <script>不会执行</script>')
    await dialog.getByRole('button', { name: '上传并校验', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    const card = page.locator('.backup-card')
    await expect(card).toHaveCount(1)
    await card.getByText('详情与管理', { exact: true }).click()
    await expect(card).toContainText('可下载')
    await expect(card).toContainText('未记录实际游玩确认')
    await expect(card).toContainText('冒险纪念 <script>不会执行</script>')
    await card.getByText('查看完整性与统计衔接说明').click()
    await expect(card).toContainText(hash)
    const contentUrl = await card.getByRole('link', { name: '下载存档' }).getAttribute('href')
    const response = await page.request.get(contentUrl!)
    expect(response.status(), (await response.body()).toString().slice(0, 120)).toBe(200)
    expect(response.headers()['content-disposition']).toContain('.tar.gz')
    expect(
      createHash('sha256')
        .update(await response.body())
        .digest('hex'),
    ).toBe(hash)
    const pending = page.waitForEvent('download')
    await card.getByRole('link', { name: '下载存档' }).click()
    const download = await pending,
      downloaded = await download.path()
    expect(
      createHash('sha256')
        .update(await readFile(downloaded!))
        .digest('hex'),
    ).toBe(hash)
    if (
      !(await card.locator('.backup-management').evaluate((el) => (el as HTMLDetailsElement).open))
    )
      await card.getByText('详情与管理', { exact: true }).click()
    await card.getByRole('button', { name: '编辑备注与保留' }).click()
    await dialog.getByLabel('永久保留，免于自动清理旧备份').check()
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(
      card.getByRole('button', { name: '删除备份', exact: true, includeHidden: true }),
    ).toBeDisabled()
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(
      card.getByRole('button', { name: '删除备份', exact: true, includeHidden: true }),
    ).toBeDisabled()
    await page.getByLabel('统计范围').selectOption(other.id)
    await expect(page.getByRole('heading', { name: '这个服务器还没有备份' })).toBeVisible()
    await page.getByRole('button', { name: '上传备份', exact: true }).click()
    await dialog.getByLabel('备份归档文件').setInputFiles(archive)
    await dialog.getByRole('button', { name: '上传并校验', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('备份属于另一服务器')
    await expect(dialog.getByLabel('所属服务器')).toBeEnabled()
    await dialog.getByLabel('所属服务器').selectOption(server.id)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(card).toContainText('未完成')
    await expect(card.getByRole('link', { name: '下载存档' })).toHaveCount(0)
    await page.getByLabel('统计范围').selectOption(server.id)
    if (
      !(await card.locator('.backup-management').evaluate((el) => (el as HTMLDetailsElement).open))
    )
      await card.getByText('详情与管理', { exact: true }).click()
    await card.getByRole('button', { name: '编辑备注与保留' }).click()
    await dialog.getByLabel('永久保留，免于自动清理旧备份').uncheck()
    await dialog.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    if (
      !(await card.locator('.backup-management').evaluate((el) => (el as HTMLDetailsElement).open))
    )
      await card.getByText('详情与管理', { exact: true }).click()
    await card.getByRole('button', { name: '删除备份', exact: true }).click()
    await expect(dialog).toContainText('玩家统计历史继续保留')
    await dialog.getByRole('button', { name: '确认删除文件', exact: true }).click()
    await expect(page.getByRole('heading', { name: '这个服务器还没有备份' })).toBeVisible()
    await page.getByRole('button', { name: '上传备份', exact: true }).click()
    await dialog.getByLabel('备份用途').selectOption('FINAL')
    await dialog.getByLabel('备份归档文件').setInputFiles(archive)
    await dialog.getByRole('button', { name: '上传并校验', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(card).toContainText('最终封存')
    await expect(card).toContainText('永久保留')
    if (
      !(await card.locator('.backup-management').evaluate((el) => (el as HTMLDetailsElement).open))
    )
      await card.getByText('详情与管理', { exact: true }).click()
    await expect(
      card.getByRole('button', { name: '删除备份', exact: true, includeHidden: true }),
    ).toBeDisabled()
    await expect(page.locator('body')).toHaveJSProperty(
      'scrollWidth',
      await page.locator('body').evaluate((element) => element.clientWidth),
    )
    await page.screenshot({
      path: info.outputPath(`backups-${viewport.width}.png`),
      fullPage: true,
    })
    expect(errors).toEqual([])
  })
}
