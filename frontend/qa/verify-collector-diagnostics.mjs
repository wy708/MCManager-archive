import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { displayTime } from '../src/statistics.ts'

const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'
assert.equal(new URL(base).hostname, '127.0.0.1')
const evidence = JSON.parse(
  await readFile(
    new URL('../../.tools/native-collector-diagnostics-evidence.json', import.meta.url),
    'utf8',
  ),
)
assert.equal(evidence.realGameplay, true)
assert.equal(evidence.cleanGameStop, true)
const { serverId, collectorDiagnostics } = evidence
const env = Object.fromEntries(
  (await readFile(new URL('../../.env', import.meta.url), 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('MCM_') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
)
const browser = await chromium.launch()
const checks = []
try {
  for (const width of [1440, 390, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base)
    await page.getByLabel('用户名', { exact: true }).fill(env.MCM_ADMIN_USERNAME ?? 'admin')
    await page.getByLabel('密码', { exact: true }).fill(env.MCM_ADMIN_PASSWORD)
    await page.getByRole('button', { name: '进入工作台' }).click()
    await page.getByLabel('统计范围', { exact: true }).selectOption(serverId)
    const toggle = page.getByRole('button', { name: '切换导航' })
    if (await toggle.isVisible()) await toggle.click()
    await page.locator('.sidebar').getByRole('button', { name: '平台设置', exact: true }).click()
    const card = page.locator(`[data-collector-server="${serverId}"]`)
    const diagnostic = card.getByRole('region', { name: '采集诊断', exact: true })
    const response = await page.request.get(`${base}/api/collectors?serverId=${serverId}`)
    assert.equal(response.status(), 200)
    const [status] = await response.json()
    assert.equal(status.diagnostics.bootId, collectorDiagnostics.currentBoot)
    assert.equal(status.diagnostics.captureGaps, 0)
    await expect(
      diagnostic.locator('dl div').filter({ hasText: '已知观测缺口' }).locator('dd'),
    ).toHaveText('0')
    const previous = status.previousAnomalies.find(
      (run) => run.bootId === collectorDiagnostics.priorBoot,
    )
    assert.equal(previous.captureGaps, collectorDiagnostics.knownGaps)
    assert.equal(previous.diskFaults, collectorDiagnostics.diskFaults)
    await diagnostic.locator('summary').click()
    const row = diagnostic.getByRole('row').filter({ hasText: displayTime(previous.reportedAt) })
    await expect(row.getByRole('cell').nth(0)).toContainText('停用前报告')
    await expect(row.getByRole('cell').nth(2)).toHaveText(String(previous.captureGaps))
    await expect(row.getByRole('cell').nth(3)).toHaveText(String(previous.diskFaults))
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    )
    assert.deepEqual(errors, [])
    checks.push({ width, currentAndPreviousBootsMatch: true })
    await page.close()
  }
  const result = { verifiedAt: new Date().toISOString(), ...collectorDiagnostics, checks }
  await writeFile(
    new URL('../../.tools/native-collector-diagnostics-browser.json', import.meta.url),
    JSON.stringify(result, null, 2),
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
