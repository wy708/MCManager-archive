import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  expect,
} from "../../frontend/node_modules/@playwright/test/index.mjs";

// Optional real production UI driver. It forwards no fabricated task states.
export async function remoteBrowser({
  base,
  username,
  password,
  serverId,
  directory,
}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    baseURL: base,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const region = page.getByRole("region", { name: "游戏主机与备份任务" });
  const dialog = page.getByRole("dialog");
  async function refresh() {
    await expect(
      region.getByRole("button", { name: "刷新任务", exact: true }),
    ).toBeEnabled();
    const response = page.waitForResponse(
      (r) => r.url().includes("/api/backup-jobs?") && r.status() === 200,
    );
    await region.getByRole("button", { name: "刷新任务", exact: true }).click();
    await response;
  }
  try {
    await page.goto(base);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByLabel("用户名", { exact: true }).fill(username);
    await page.getByRole("button", { name: "进入工作台" }).click();
    await expect(
      page.getByRole("heading", { name: "数据总览", exact: true }),
    ).toBeVisible();
    await page.getByLabel("统计范围").selectOption(serverId);
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "备份中心", exact: true })
      .click();
    await expect(
      region.getByRole("button", { name: "刷新任务" }),
    ).toBeEnabled();
  } catch (error) {
    await browser.close();
    throw error;
  }
  return {
    async issue(existing) {
      if (existing) {
        const card = region.locator(`[data-backup-host="${existing.id}"]`);
        await card
          .getByRole("button", {
            name: existing.revoked ? "重新启用" : "轮换凭据",
            exact: true,
          })
          .click();
        await dialog.getByRole("button", { name: "生成新凭据" }).click();
      } else {
        await region
          .getByRole("button", { name: "添加执行端", exact: true })
          .click();
        await dialog
          .getByLabel("执行端名称", { exact: true })
          .fill("实服远程备份验收");
        await dialog
          .getByRole("button", { name: "添加执行端", exact: true })
          .click();
      }
      const secret = dialog.getByLabel("执行端凭据", { exact: true });
      await expect(secret).toBeVisible();
      const token = await secret.inputValue();
      assert.match(token, /^mcmhost\./);
      const hosts = await (
        await page.request.get(`/api/backup-hosts?serverId=${serverId}`)
      ).json();
      assert.equal(hosts.length, 1);
      return { host: hosts[0], token };
    },
    async saveConfig({ apiUrl, root, outputDirectory, file, token }) {
      await dialog.getByLabel("中央服务地址", { exact: true }).fill(apiUrl);
      await dialog.getByLabel("游戏目录", { exact: true }).fill(root);
      await dialog
        .getByLabel("备份保存目录", { exact: true })
        .fill(outputDirectory);
      const pending = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "下载主机配置" }).click();
      const download = await pending;
      await download.saveAs(file);
      const config = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(config, {
        apiUrl,
        root,
        outputDirectory,
        serverId,
        token,
      });
      await dialog.getByRole("button", { name: "已保存，关闭" }).click();
      await expect(page.getByLabel("执行端凭据", { exact: true })).toHaveCount(
        0,
      );
    },
    async createTask(note, permanent) {
      await region
        .getByRole("button", { name: "新建备份任务", exact: true })
        .click();
      await dialog.getByLabel("任务备注", { exact: true }).fill(note);
      if (permanent) await dialog.getByLabel("永久保留这份备份").check();
      const response = page.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().endsWith(`/servers/${serverId}/backup-jobs`),
      );
      await dialog
        .getByRole("button", { name: "创建任务", exact: true })
        .click();
      const result = await response;
      assert.equal(result.status(), 201);
      await expect(dialog).not.toBeVisible();
      return result.json();
    },
    async resolve(jobId, note) {
      await refresh();
      const card = region.locator(`[data-backup-job="${jobId}"]`);
      await card.getByRole("button", { name: "处理结果", exact: true }).click();
      await dialog.getByLabel("处理说明", { exact: true }).fill(note);
      await dialog
        .getByRole("button", { name: "保存处理结果", exact: true })
        .click();
      await expect(card).toContainText("已失败");
      await expect(card).toContainText(note);
    },
    async scheduleTask() {
      const panel = page.getByRole("region", { name: "自动备份与轮换" });
      await panel.getByRole("button", { name: "配置自动备份" }).click();
      await dialog.getByLabel("启用定期制作").check();
      await dialog.getByLabel("备份间隔（分钟）").fill("1");
      const nextMinute = Math.ceil((Date.now() + 5000) / 60000) * 60000;
      const local = await page.evaluate(
        (time) =>
          new Date(time - new Date(time).getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16),
        nextMinute,
      );
      await dialog.getByLabel("首次或重新安排时间").fill(local);
      await dialog
        .getByLabel("启用自动轮换，删除超出规则的普通自动备份")
        .check();
      await dialog.getByLabel("保留普通自动备份数量").fill("1");
      await dialog.getByLabel("保留天数").fill("");
      await dialog.getByRole("button", { name: "保存备份策略" }).click();
      await expect(dialog).not.toBeVisible();
      const started = Date.now();
      while (Date.now() - started < 180000) {
        const jobs = await (
          await page.request.get(
            `/api/backup-jobs?serverId=${serverId}&size=100`,
          )
        ).json();
        const job = jobs.items.find(
          (row) =>
            row.kind === "AUTOMATIC" &&
            Date.parse(row.createdAt) >= started - 5000,
        );
        if (job) return job;
        await delay(500);
      }
      throw new Error(
        "Production policy worker did not enqueue the configured slot",
      );
    },
    async disableAutomatic() {
      const panel = page.getByRole("region", { name: "自动备份与轮换" });
      await panel.getByRole("button", { name: "刷新策略" }).click();
      await expect(
        panel.getByRole("button", { name: "配置自动备份" }),
      ).toBeEnabled();
      await panel.getByRole("button", { name: "配置自动备份" }).click();
      await dialog.getByLabel("启用定期制作").uncheck();
      await dialog
        .getByLabel("启用自动轮换，删除超出规则的普通自动备份")
        .uncheck();
      await dialog.getByRole("button", { name: "保存备份策略" }).click();
      await expect(dialog).not.toBeVisible();
      await expect(
        panel.locator(`[data-backup-policy="${serverId}"]`),
      ).toContainText("自动轮换已关闭");
    },
    async assertRotated(jobId) {
      await refresh();
      const card = region.locator(`[data-backup-job="${jobId}"]`);
      await expect(card).toContainText("归档已轮换或不可用");
      await expect(
        card.getByRole("link", { name: "下载任务归档" }),
      ).toHaveCount(0);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({
        path: `${directory}/production-automatic-rotation.png`,
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    },
    async download(jobId, catalogId, file) {
      await refresh();
      const card = region.locator(`[data-backup-job="${jobId}"]`);
      await expect(card).toContainText("归档已保存");
      const pending = page.waitForEvent("download", { timeout: 60000 });
      await card.getByRole("link", { name: "下载任务归档" }).click();
      const download = await pending;
      await download.saveAs(file);
      assert.equal(await download.failure(), null);
      await expect(page.locator(`[data-backup="${catalogId}"]`)).toContainText(
        "文件已校验",
      );
      for (const width of [1440, 390, 360]) {
        await page.setViewportSize({
          width,
          height: width === 360 ? 440 : 1000,
        });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
        );
        await page.screenshot({
          path: `${directory}/production-remote-tasks-${width}.png`,
          fullPage: true,
        });
      }
      assert.deepEqual(errors, []);
    },
    async captureOverview(file) {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: file, fullPage: false });
      assert.deepEqual(errors, []);
    },
    close: () => browser.close(),
  };
}
