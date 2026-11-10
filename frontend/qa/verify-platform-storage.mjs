import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { formatRestoreBytes } from '../src/restores.ts'

const base = 'http://127.0.0.1:18089'
const project = 'mcmanager-archive-storage-qa'
const database = `${project}-database-1`
const label = execFileSync(
  'docker',
  ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', database],
  { encoding: 'utf8' },
).trim()
assert.equal(label, project)
const native = JSON.parse(
  await readFile(
    new URL('../../.tools/storage-qa-identity-evidence.json', import.meta.url),
    'utf8',
  ),
)
assert.equal(native.realGameplay, true)
const { second, sameName, playerKey, otherKey } = native
for (const id of [second.id, second.chatId, sameName.chatId]) assert.match(id, /^[0-9a-f-]{36}$/)
assert.match(playerKey, /^uuid:[0-9a-f-]{36}$/)
assert.match(otherKey, /^uuid:[0-9a-f-]{36}$/)
const file = process.env.MCM_STORAGE_QA_ARCHIVE
assert.ok(file, 'Set MCM_STORAGE_QA_ARCHIVE to the verified isolated BDS backup')
const { size } = await stat(file)
const env = Object.fromEntries(
  (await readFile(new URL('../../.env', import.meta.url), 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('MCM_') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
)
const sql = (statement) =>
  execFileSync(
    'docker',
    [
      'exec',
      database,
      'psql',
      '-X',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'mcmanager',
      '-d',
      'mcmanager',
      '-c',
      statement,
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim()
const whereChat = (id) => `server_id='${second.id}' AND event_id='${id}'`
const rows = (where) => Number(sql(`SELECT COUNT(*) FROM activity_feed WHERE ${where}`))
const xpSummary = async (page) => {
  const response = await page.request.get(
    base + '/api/statistics/summary?' + new URLSearchParams({ serverId: second.id, playerKey }),
  )
  assert.equal(response.status(), 200)
  const result = await response.json()
  return result.metrics.find((row) => row.key === 'experience.gained').value
}
async function login(page) {
  await page.goto(base)
  await page.getByLabel('用户名', { exact: true }).fill(env.MCM_ADMIN_USERNAME ?? 'admin')
  await page.getByLabel('密码', { exact: true }).fill(env.MCM_ADMIN_PASSWORD)
  await page.getByRole('button', { name: '进入工作台' }).click()
  await expect(page.getByLabel('统计范围', { exact: true })).toBeVisible()
}
async function openSettings(page) {
  const toggle = page.getByRole('button', { name: '切换导航' })
  if (await toggle.isVisible()) await toggle.click()
  await page.locator('.sidebar').getByRole('button', { name: '平台设置', exact: true }).click()
  return page.getByRole('region', { name: '存储与保留' })
}
async function getStorage(page) {
  const response = await page.request.get(base + '/api/backups/storage')
  assert.equal(response.status(), 200)
  return response.json()
}

const browser = await chromium.launch()
const evidence = {
  verifiedAt: '',
  actualNativeRows: true,
  realArchiveBytes: size,
  checkedWidths: [],
}
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
  await login(page)
  const csrf = await (await page.request.get(base + '/api/auth/csrf')).json()
  const baseline = await getStorage(page)
  const reservation = await page.request.post(`${base}/api/servers/${second.id}/backups`, {
    headers: { [csrf.headerName]: csrf.token },
    data: {
      requestId: randomUUID(),
      kind: 'MANUAL',
      note: '独立存储实服验收',
      permanent: false,
      expectedBytes: String(size),
    },
  })
  assert.equal(reservation.status(), 201)
  const { id: backupId } = await reservation.json()
  const cookies = await page.context().cookies(base)
  const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join('; ')
  const upload = await fetch(`${base}/api/backups/${backupId}/content`, {
    method: 'PUT',
    duplex: 'half',
    body: createReadStream(file),
    redirect: 'error',
    signal: AbortSignal.timeout(240_000),
    headers: {
      [csrf.headerName]: csrf.token,
      Cookie: cookieHeader,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    },
  })
  assert.equal(upload.status, 200)
  const uploaded = await upload.json()
  assert.equal(uploaded.status, 'READY')
  evidence.backupId = backupId
  console.log(JSON.stringify({ stage: 'native-backup-uploaded-and-verified', bytes: size }))
  const storage = await getStorage(page)
  assert.equal(storage.readyCount, baseline.readyCount + 1)
  assert.equal(BigInt(storage.readyArchiveBytes) - BigInt(baseline.readyArchiveBytes), BigInt(size))
  assert.ok(BigInt(storage.volume.totalBytes) >= BigInt(storage.volume.usableBytes))

  const expired = `server_id='${second.id}' AND (event_id='${second.chatId}' OR (player_key='${playerKey}' AND metric='experience.gained'))`
  assert.equal(rows(expired), 2)
  sql(
    `UPDATE activity_feed SET received_at = CURRENT_TIMESTAMP - INTERVAL '3 days' WHERE ${expired}`,
  )
  assert.equal(await xpSummary(page), '3')
  const panel = await openSettings(page)
  const days = panel.getByLabel('行为与聊天明细保留天数')
  await expect(days).toHaveValue('30')
  await expect(panel).toContainText(formatRestoreBytes(storage.readyArchiveBytes))
  await days.fill('1')
  await panel.getByRole('button', { name: '预览超期明细' }).click()
  await expect(panel).toContainText('现有聊天 1 条，行为 1 条')
  assert.equal(rows(expired), 2)
  await panel.getByRole('button', { name: '取消预览' }).click()
  await expect(panel.getByRole('button', { name: '保存并清理超期明细' })).toHaveCount(0)
  await panel.getByRole('button', { name: '预览超期明细' }).click()
  await panel.getByRole('button', { name: '保存并清理超期明细' }).click()
  await expect(panel).toContainText('已保存 1 天保留期，本次清理 2 条')
  assert.equal(rows(expired), 0)
  assert.equal(await xpSummary(page), '3')
  assert.equal(rows(whereChat(sameName.chatId)), 1)

  // Age one confirmed native row after changing policy. No API mutation or
  // additional ingestion runs while the maintenance worker prunes it.
  sql(
    `UPDATE activity_feed SET received_at = CURRENT_TIMESTAMP - INTERVAL '3 days' WHERE ${whereChat(sameName.chatId)}`,
  )
  await expect
    .poll(() => rows(whereChat(sameName.chatId)), { timeout: 35_000, intervals: [500, 1000] })
    .toBe(0)
  assert.equal(
    rows(`server_id='${second.id}' AND player_key='${otherKey}' AND metric='experience.gained'`),
    1,
  )
  evidence.physicalCleanupWithoutRequest = true
  await days.fill('365')
  await panel.getByRole('button', { name: '预览超期明细' }).click()
  await panel.getByRole('button', { name: '保存并清理超期明细' }).click()
  await expect(panel).toContainText('已保存 365 天保留期')
  assert.equal(rows(expired), 0)
  assert.equal(rows(whereChat(sameName.chatId)), 0)
  const chat = await page.request.get(`${base}/api/activity?serverId=${second.id}&chat=true`)
  assert.equal(chat.status(), 200)
  assert.deepEqual((await chat.json()).items, [])
  assert.equal((await getStorage(page)).readyArchiveBytes, storage.readyArchiveBytes)
  const download = await fetch(`${base}/api/backups/${backupId}/content`, {
    headers: { Cookie: cookieHeader },
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  })
  assert.equal(download.status, 200)
  const hash = createHash('sha256')
  for await (const chunk of download.body) hash.update(chunk)
  assert.equal(hash.digest('hex'), uploaded.sha256)
  await page.close()

  for (const width of [1440, 390, 360]) {
    const check = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    check.on('pageerror', (error) => errors.push(error.message))
    await login(check)
    const section = await openSettings(check)
    await expect(section).toContainText('当前保留 365 天')
    await expect(section).toContainText(formatRestoreBytes(storage.readyArchiveBytes))
    assert.equal(
      await check.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    )
    assert.deepEqual(errors, [])
    evidence.checkedWidths.push(width)
    await check.close()
  }
  evidence.verifiedAt = new Date().toISOString()
  evidence.archivedFilesUnchanged = true
  evidence.longTermStatsUnchanged = true
  evidence.expiredRowsStayedDeletedAfterExtension = true
  await writeFile(
    new URL('../../.tools/storage-qa-browser-evidence.json', import.meta.url),
    JSON.stringify(evidence, null, 2),
  )
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser.close()
}
