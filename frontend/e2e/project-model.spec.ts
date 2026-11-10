import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ModelSection } from '../src/projectModel'
async function admin(page: Page, path: string, data: unknown) {
  const csrf = await (await page.request.get('/api/auth/csrf')).json()
  const r = await page.request.post('/api' + path, {
    headers: { [csrf.headerName]: csrf.token },
    data,
  })
  expect(r.ok(), await r.text()).toBe(true)
  return r.json()
}
for (const width of [1440, 390])
  test(`three dimensional project model, height and frozen phases ${width}`, async ({
    page,
    browser,
  }) => {
    test.skip(
      !process.env.MCM_SCENE_RUNNER,
      'Requires the pinned scene runtime; see scene/README.md',
    )
    test.setTimeout(180000)
    await page.goto('/')
    await page.getByLabel('密码', { exact: true }).fill('e2e-admin-password-2026')
    await page.getByRole('button', { name: '进入工作台' }).click()
    await expect(page.getByRole('heading', { name: '今天的方块世界', exact: true })).toBeVisible()
    const server = await admin(page, '/servers', {
      name: `三维预览验收 ${width}`,
      description: 'Isolated browser QA',
      startDate: '2020-01-01',
    })
    const credential = await admin(page, `/servers/${server.id}/collector-credential`, {}),
      bootId = randomUUID(),
      at = new Date().toISOString()
    let r = await page.request.post('/api/ingest/v1/batches', {
      headers: { Authorization: 'Bearer ' + credential.token },
      data: {
        protocolVersion: 1,
        batchId: randomUUID(),
        reportedAt: at,
        collector: {
          version: 'ui-qa',
          bdsVersion: 'qa',
          leviLaminaVersion: 'qa',
          bootId,
          pendingEvents: 0,
        },
        capabilities: [],
        events: [],
      },
    })
    expect(r.ok(), await r.text()).toBe(true)
    const project = await admin(page, `/servers/${server.id}/projects`, {
      requestId: randomUUID(),
      action: 'CREATE',
      name: '林间三维小屋',
      dimension: 'minecraft:overworld',
      x1: 0,
      z1: 0,
      x2: 7,
      z2: 7,
    })
    const fixture: ModelSection[] = process.env.MCM_MODEL_QA_FIXTURE
      ? JSON.parse(readFileSync(process.env.MCM_MODEL_QA_FIXTURE, 'utf8'))
      : [
          {
            x: 0,
            y: 96,
            z: 0,
            palette: [
              { name: 'minecraft:air', states: '' },
              { name: 'minecraft:oak_planks', states: '' },
            ],
            runs: [0, 192, 1, 64, 0, 256],
          },
        ]
    for (const section of fixture) {
      r = await page.request.post('/api/ingest/v1/project-models/capture', {
        headers: { Authorization: 'Bearer ' + credential.token },
        data: {
          bootId,
          projectId: project.projectId,
          revision: 1,
          observedAt: new Date().toISOString(),
          section,
        },
      })
      expect(r.ok(), await r.text()).toBe(true)
    }
    const context = await browser.newContext({ viewport: { width, height: 960 } }),
      viewer = await context.newPage(),
      errors: string[] = []
    viewer.on('pageerror', (e) => errors.push(e.message))
    await viewer.goto(`http://127.0.0.1:5174/projects/${project.projectId}#model`)
    await expect(viewer.getByRole('img', { name: '可旋转的建筑场景' })).toBeVisible()
    await expect(viewer.locator('.project-model')).toContainText(/已显示 [1-9]/, {
      timeout: 120000,
    })
    await expect(viewer.getByRole('button', { name: '查看这一层' })).toBeEnabled()
    expect(
      await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true)
    await viewer.screenshot({ path: `test-results/project-model-${width}.png`, fullPage: true })
    const canvas = viewer.locator('.model-canvas canvas')
    await canvas.scrollIntoViewIfNeeded()
    const box = (await canvas.boundingBox())!
    const before = await canvas.screenshot({
      path: `test-results/project-model-canvas-${width}.png`,
    })
    await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await viewer.mouse.down()
    await viewer.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 20, { steps: 8 })
    await viewer.mouse.up()
    expect((await canvas.screenshot()).equals(before)).toBe(false)
    await viewer.getByRole('button', { name: '全屏查看', exact: true }).click()
    const fullscreen = viewer.getByRole('dialog', { name: '三维建筑全屏预览' })
    await expect(fullscreen).toBeVisible()
    const fullscreenBox = (await fullscreen.boundingBox())!
    expect(Math.abs(fullscreenBox.width - width)).toBeLessThan(2)
    expect(Math.abs(fullscreenBox.height - 960)).toBeLessThan(2)
    if (width === 390) await expect(fullscreen.locator('.model-controls')).not.toBeVisible()
    await fullscreen.getByRole('button', { name: '退出全屏' }).click()
    await expect(fullscreen).toHaveCount(0)
    await viewer.getByLabel('最低显示高度 Y').fill('300')
    await viewer.getByLabel('最高显示高度 Y').fill('310')
    await viewer.getByRole('button', { name: '查看这一层' }).click()
    await viewer.reload()
    await expect(viewer.getByLabel('最高显示高度 Y')).toHaveValue('310')
    await viewer.getByRole('button', { name: '全部高度', exact: true }).click()
    await expect(viewer.locator('.project-model')).toContainText(/已显示 [1-9]/, {
      timeout: 120000,
    })
    await admin(page, `/servers/${server.id}/projects`, {
      requestId: randomUUID(),
      action: 'COMPLETE',
      projectId: project.projectId,
    })
    await viewer.reload()
    await expect(viewer.locator('.project-banner')).toContainText('已封存')
    await admin(page, `/servers/${server.id}/projects`, {
      requestId: randomUUID(),
      action: 'RESUME',
      projectId: project.projectId,
    })
    await viewer.reload()
    await expect(viewer.locator('.project-model')).toContainText('等待游戏加载工程区域')
    await viewer.getByLabel('查看阶段').selectOption('1')
    await expect(viewer.locator('.project-model')).toContainText(/已显示 [1-9]/, {
      timeout: 120000,
    })
    expect(errors).toEqual([])
    await context.close()
  })
