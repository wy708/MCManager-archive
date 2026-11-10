import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

// Real backend protocol and browser state. This fixture does not run BDS.
async function admin(page: Page, route: string, data?: unknown, method = 'POST') {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const response = await page.request.fetch('/api' + route, {
    method,
    headers: { [csrf.headerName]: csrf.token },
    data,
  })
  expect(response.ok(), await response.text()).toBe(true)
  return response.status() === 204 ? undefined : response.json()
}
async function machine(page: Page, token: string, route: string, data: unknown) {
  const response = await page.request.post('/api/host/v1' + route, {
    headers: { Authorization: 'Bearer ' + token },
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
async function navigate(page: Page, serverId: string) {
  await page.getByLabel('统计范围').selectOption(serverId)
  const menu = page.getByRole('button', { name: '切换导航' })
  if (await menu.isVisible()) await menu.click()
  await page.locator('.sidebar').getByRole('button', { name: '备份中心', exact: true }).click()
  await page
    .getByRole('navigation', { name: '服务器备份功能' })
    .getByRole('button', { name: '恢复记录', exact: true })
    .click()
  await expect(region(page).getByRole('button', { name: '刷新恢复任务' })).toBeEnabled()
}
const region = (page: Page) => page.getByRole('region', { name: '新目录恢复任务', exact: true })
const dialog = (page: Page) => page.getByRole('dialog')
async function refresh(page: Page) {
  await page
    .getByRole('navigation', { name: '服务器备份功能' })
    .getByRole('button', { name: '恢复记录', exact: true })
    .click()
  await region(page).getByRole('button', { name: '刷新恢复任务' }).click()
  await expect(region(page).getByRole('button', { name: '刷新恢复任务' })).toBeEnabled()
}
async function open(page: Page, backupId: string, mode = 'DISABLED', folder = '检查') {
  await page
    .getByRole('navigation', { name: '服务器备份功能' })
    .getByRole('button', { name: '存档记录', exact: true })
    .click()
  const details = page.locator(`[data-backup="${backupId}"] .backup-management`)
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open)))
    await details.locator('summary').first().click()
  await page
    .locator(`[data-backup="${backupId}"]`)
    .getByRole('button', { name: '恢复到新目录' })
    .click()
  await expect(dialog(page).getByLabel('恢复方式', { exact: true })).toBeFocused()
  await dialog(page).getByLabel('恢复方式', { exact: true }).selectOption(mode)
  await dialog(page).getByLabel('新目录名称', { exact: true }).fill(folder)
}
async function review(page: Page) {
  await dialog(page).getByRole('button', { name: '下一步，核对方案' }).click()
  await expect(dialog(page).getByRole('heading', { name: '核对恢复方案' })).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: '创建恢复任务' })).toBeDisabled()
  await dialog(page)
    .getByRole('checkbox', { name: /确认使用新目录/ })
    .check()
}
async function create(page: Page) {
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/backups\/[^/]+\/restores$/.test(r.url()),
  )
  await dialog(page).getByRole('button', { name: '创建恢复任务', exact: true }).click()
  const result = await response
  expect(result.status()).toBe(201)
  await expect(dialog(page)).not.toBeVisible()
  return result.json()
}
for (const width of [1440, 390, 360]) {
  test(`restore wizard identity, ambiguous submit, cancellation and reconciliation ${width}`, async ({
    page,
  }, info) => {
    test.setTimeout(120000)
    await page.setViewportSize({ width, height: width === 360 ? 440 : 1000 })
    if (width === 360)
      await page.addInitScript(() =>
        Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined }),
      )
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await login(page)
    const own = await admin(page, '/servers', {
      name: '恢复网页来源 ' + width,
      description: 'Synthetic browser protocol fixture, not gameplay',
      startDate: '2020-01-01',
    })
    const other = await admin(page, '/servers', {
      name: '恢复网页另一主机 ' + width,
      description: '',
      startDate: '2020-01-01',
    })
    const host = await admin(page, '/backup-hosts', {
        serverId: own.id,
        name: '恢复原主机 ' + width,
      }),
      alternate = await admin(page, '/backup-hosts', {
        serverId: other.id,
        name: '恢复另一主机 ' + width,
      })
    const folder = info.outputPath('fixture')
    await mkdir(folder)
    const archive = path.join(folder, 'fixture.tar.gz')
    await promisify(execFile)(process.execPath, [
      path.resolve('../backup/qa/create-upload-fixture.mjs'),
      folder,
      own.id,
      archive,
    ])
    const bytes = await readFile(archive)
    const reserved = await admin(page, '/servers/' + own.id + '/backups', {
      requestId: randomUUID(),
      kind: 'MANUAL',
      note: '恢复页面协议夹具',
      permanent: false,
      expectedBytes: String(bytes.length),
    })
    const csrf = await (await page.request.get('/api/auth/csrf')).json(),
      uploaded = await page.request.put('/api/backups/' + reserved.id + '/content', {
        headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/octet-stream' },
        data: bytes,
      })
    expect(uploaded.status()).toBe(200)
    const backup = await uploaded.json()
    await page.reload()
    await navigate(page, own.id)
    await open(page, backup.id, 'CONTINUE')
    await expect(dialog(page)).toContainText('尚无可用备份程序')
    await expect(dialog(page).getByRole('button', { name: '下一步，核对方案' })).toBeDisabled()
    await page.keyboard.press('Escape')
    const runId = randomUUID(),
      otherRun = randomUUID()
    await machine(page, host.token, '/heartbeat', {
      runId,
      state: 'STOPPED',
      version: '0.4.0',
      restoreEnabled: true,
    })
    await machine(page, alternate.token, '/heartbeat', {
      runId: otherRun,
      state: 'RUNNING',
      version: '0.4.0',
      restoreEnabled: true,
    })
    await open(page, backup.id, 'DISABLED', '../escape')
    await expect(dialog(page).getByRole('button', { name: '下一步，核对方案' })).toBeDisabled()
    await dialog(page).getByLabel('新目录名称', { exact: true }).fill('CON')
    await expect(dialog(page).getByRole('button', { name: '下一步，核对方案' })).toBeDisabled()
    await dialog(page)
      .getByLabel('新目录名称', { exact: true })
      .fill('独立检查-' + width)
    await review(page)
    await expect(dialog(page)).toContainText(backup.sha256)
    await expect(dialog(page)).toContainText('中央已有历史继续保留')
    const bounds = await dialog(page).boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.width).toBeLessThanOrEqual(width)
    expect(bounds!.height).toBeLessThanOrEqual(width === 360 ? 440 : 1000)
    await page.screenshot({ path: info.outputPath('restore-review.png') })
    const disabled = await create(page)
    await expect(region(page).getByRole('button', { name: '刷新恢复任务' })).toBeFocused()
    expect(disabled.sourceServerId).toBe(own.id)
    expect(disabled.targetServerId).toBe(own.id)
    const pinCsrf = await (await page.request.get('/api/auth/csrf')).json()
    expect(
      (
        await page.request.delete('/api/backups/' + backup.id, {
          headers: { [pinCsrf.headerName]: pinCsrf.token },
        })
      ).status(),
    ).toBe(409)
    const disabledCard = page.locator(`[data-restore="${disabled.id}"]`)
    await disabledCard.getByRole('button', { name: '取消恢复任务' }).click()
    await dialog(page).getByRole('button', { name: '确认取消恢复' }).click()
    await expect(disabledCard).toContainText('已取消')
    await open(page, backup.id, 'DISABLED', '独立检查-' + width)
    await review(page)
    const duplicate = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith('/backups/' + backup.id + '/restores'),
    )
    await dialog(page).getByRole('button', { name: '创建恢复任务', exact: true }).click()
    expect((await duplicate).status()).toBe(409)
    await expect(dialog(page).getByRole('alert')).toContainText('已被使用')
    await expect(dialog(page).getByLabel('新目录名称', { exact: true })).toHaveValue(
      '独立检查-' + width,
    )
    expect(
      await page.evaluate(() => sessionStorage.getItem('mcmanager.pending-restore.v1')),
    ).toBeNull()
    await page.keyboard.press('Escape')
    await open(page, backup.id, 'FORK', '新一期-' + width)
    await dialog(page)
      .getByLabel('新一期名称', { exact: true })
      .fill('唯一新一期 ' + width)
    await dialog(page).getByLabel('新一期开服日期', { exact: true }).fill('2026-10-28')
    await review(page)
    let captured: { id: string; targetServerId: string } | undefined,
      originalBody: unknown,
      retriedBody: unknown,
      drop = true
    await page.route('**/api/backups/' + backup.id + '/restores', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue()
        return
      }
      if (drop) {
        originalBody = route.request().postDataJSON()
        const result = await route.fetch()
        expect(result.status()).toBe(201)
        captured = await result.json()
        drop = false
        await route.abort('failed')
      } else {
        retriedBody = route.request().postDataJSON()
        await route.continue()
      }
    })
    await dialog(page).getByRole('button', { name: '创建恢复任务', exact: true }).click()
    await expect(dialog(page).getByRole('alert')).toContainText('提交结果尚未确认')
    await expect(dialog(page).getByRole('button', { name: '修改方案' })).toHaveCount(0)
    await page.reload()
    await navigate(page, own.id)
    await region(page).getByRole('button', { name: '核实上次提交' }).click()
    await expect(dialog(page)).toContainText('唯一新一期 ' + width)
    await dialog(page)
      .getByRole('checkbox', { name: /确认使用新目录/ })
      .check()
    const retried = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && r.url().endsWith('/backups/' + backup.id + '/restores'),
    )
    await dialog(page).getByRole('button', { name: '重试并核实原任务' }).click()
    const retriedResponse = await retried
    expect(retriedResponse.status()).toBe(201)
    const forked = await retriedResponse.json()
    expect(forked.id).toBe(captured!.id)
    expect(retriedBody).toEqual(originalBody)
    await expect(dialog(page)).not.toBeVisible()
    const archives = await (await page.request.get('/api/servers')).json()
    expect(
      archives.filter((row: { name: string }) => row.name === '唯一新一期 ' + width),
    ).toHaveLength(1)
    const claim = await machine(page, host.token, '/restores/claim', {
      runId,
      requestId: randomUUID(),
    })
    expect(claim.job.id).toBe(forked.id)
    const lease = { runId, attemptId: claim.attemptId }
    await machine(page, host.token, '/restores/' + forked.id + '/start', lease)
    await machine(page, host.token, '/restores/' + forked.id + '/collector', {
      ...lease,
      collectorToken: forked.targetServerId + '.' + 'D'.repeat(43),
    })
    await machine(page, host.token, '/restores/' + forked.id + '/ready', {
      ...lease,
      restorationId: randomUUID(),
      sourceBackupId: forked.sourceBackupId,
      targetServerId: forked.targetServerId,
      mode: forked.mode,
      destinationName: forked.destinationName,
      sha256: forked.archiveSha256,
      fileCount: forked.fileCount,
    })
    await expect(
      page.getByLabel('统计范围').locator(`option[value="${forked.targetServerId}"]`),
    ).toHaveCount(1)
    await page.getByLabel('统计范围').selectOption(forked.targetServerId)
    await refresh(page)
    const forkCard = page.locator(`[data-restore="${forked.id}"]`)
    await expect(forkCard).toContainText('文件准备完成，尚未确认实际游玩')
    await expect(page.locator('.backup-card')).toHaveCount(0)
    await page.getByLabel('统计范围').selectOption(own.id)
    await expect(page.locator(`[data-backup="${backup.id}"]`)).toBeVisible()
    await open(page, backup.id, 'CONTINUE', '继续原期-' + width)
    await expect(
      dialog(page).getByLabel('恢复程序').locator(`option[value="${alternate.host.id}"]`),
    ).toHaveCount(0)
    await review(page)
    const continued = await create(page)
    const nextClaim = await machine(page, host.token, '/restores/claim', {
      runId,
      requestId: randomUUID(),
    })
    expect(nextClaim.job.id).toBe(continued.id)
    const nextLease = { runId, attemptId: nextClaim.attemptId }
    await machine(page, host.token, '/restores/' + continued.id + '/start', nextLease)
    await refresh(page)
    const continuedCard = page.locator(`[data-restore="${continued.id}"]`)
    await continuedCard.getByRole('button', { name: '请求取消恢复' }).click()
    await dialog(page).getByRole('button', { name: '确认取消恢复' }).click()
    await expect(continuedCard).toContainText('已请求取消，等待核实')
    await machine(page, host.token, '/restores/' + continued.id + '/report', {
      ...nextLease,
      outcome: 'UNCERTAIN',
      code: 'EXECUTION_INTERRUPTED',
    })
    await refresh(page)
    await continuedCard.getByRole('button', { name: '核实处理结果' }).click()
    await expect(dialog(page).getByRole('button', { name: '保存核实结果' })).toBeDisabled()
    await dialog(page)
      .getByLabel('核实说明', { exact: true })
      .fill('协议测试没有实际解包，确认结束旧尝试并保留诊断')
    await dialog(page).getByRole('button', { name: '保存核实结果' }).click()
    await expect(continuedCard).toContainText('已失败')
    await open(page, backup.id, 'DISABLED', '异主机检查-' + width)
    await dialog(page).getByLabel('恢复程序', { exact: true }).selectOption(alternate.host.id)
    await expect(dialog(page).getByRole('button', { name: '下一步，核对方案' })).toBeDisabled()
    await dialog(page)
      .getByRole('checkbox', { name: /确认把这份来源归档交给/ })
      .check()
    await review(page)
    const delegated = await create(page)
    expect(delegated.hostId).toBe(alternate.host.id)
    const delegatedCard = page.locator(`[data-restore="${delegated.id}"]`)
    await delegatedCard.getByRole('button', { name: '取消恢复任务' }).click()
    await dialog(page).getByRole('button', { name: '确认取消恢复' }).click()
    await expect(delegatedCard).toContainText('已取消')
    if (width === 360) {
      await open(page, backup.id, 'DISABLED', '存储失败不提交')
      await review(page)
      let attempted = 0
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          request.url().endsWith('/backups/' + backup.id + '/restores')
        )
          attempted++
      })
      await page.evaluate(() => {
        const original = Storage.prototype.setItem
        Storage.prototype.setItem = function (key, value) {
          if (key === 'mcmanager.pending-restore.v1') throw new Error('blocked')
          return original.call(this, key, value)
        }
      })
      await dialog(page).getByRole('button', { name: '创建恢复任务' }).click()
      await expect(dialog(page).getByRole('alert')).toContainText('尚未提交')
      expect(attempted).toBe(0)
      await page.reload()
      await navigate(page, own.id)
      await expect(region(page).getByRole('button', { name: '核实上次提交' })).toHaveCount(0)
    }
    await admin(page, '/servers/' + own.id + '/archive', { endDate: '2026-10-28' })
    await page.reload()
    await navigate(page, own.id)
    await open(page, backup.id)
    await expect(
      dialog(page).getByLabel('恢复方式').locator('option[value="CONTINUE"]'),
    ).toHaveJSProperty('disabled', true)
    await page.keyboard.press('Escape')
    await admin(page, '/backups/' + backup.id, undefined, 'DELETE')
    expect((await page.request.get('/api/backups/' + backup.id + '/content')).status()).toBe(409)
    await admin(page, '/backup-hosts/' + host.host.id, undefined, 'DELETE')
    await admin(page, '/backup-hosts/' + alternate.host.id, undefined, 'DELETE')
    expect(errors).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
