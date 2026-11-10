import { chromium } from "../frontend/node_modules/playwright/index.mjs";
import { expect } from "../frontend/node_modules/@playwright/test/index.mjs";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL(".env", root), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("MCM_"))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const fixture = JSON.parse(
  readFileSync(new URL(".tools/telemetry-http-evidence.json", root), "utf8"),
);
const browser = await chromium.launch({ channel: "chromium" });
const errors = [],
  csp = [];
try {
  const page = await browser.newPage({
    baseURL: process.env.MCM_QA_BASE_URL ?? fixture.base,
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      /Content Security|Refused to (execute|apply|load)/i.test(message.text())
    )
      csp.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "进入工作台" })).toBeEnabled();
  await page.getByLabel("用户名", { exact: true }).fill(env.MCM_ADMIN_USERNAME);
  await page.getByLabel("密码", { exact: true }).fill(env.MCM_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.locator('[data-metric="blocks.mined"]')).toBeVisible();
  const totalResponse = await page.request.get("/api/statistics/summary");
  expect(totalResponse.ok()).toBe(true);
  const total = await totalResponse.json();
  const expected = total.metrics.find(
    (metric) => metric.key === "blocks.mined",
  ).value;
  await expect(page.locator('[data-metric="blocks.mined"] strong')).toHaveText(
    BigInt(expected).toLocaleString("zh-CN"),
  );
  mkdirSync(new URL(".tools/", root), { recursive: true });
  await page.screenshot({
    path: fileURLToPath(new URL(".tools/production-statistics.png", root)),
    fullPage: true,
  });
  const profileResponse = await page.request.get(
    "/api/players/" + encodeURIComponent(fixture.playerKey),
  );
  expect(profileResponse.ok()).toBe(true);
  const profile = await profileResponse.json();
  await page.getByRole("button", { name: "玩家统计", exact: true }).click();
  await page.getByLabel("搜索玩家当前或历史名字").fill(profile.player.name);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const playerButtons = page
    .getByRole("row")
    .filter({ hasText: fixture.playerKey })
    .getByRole("button", { name: "查看玩家", exact: false });
  await playerButtons.click();
  await expect(page.getByRole("heading", { name: "历史名字" })).toBeVisible();
  await expect(
    page.locator('.player-profile [data-metric="blocks.mined"] strong'),
  ).toHaveText(BigInt(fixture.minedBlocks).toLocaleString("zh-CN"));
  await page.getByRole("button", { name: "返回玩家列表" }).click();
  await expect(playerButtons).toBeVisible();
  await page.getByRole("button", { name: "平台设置", exact: true }).click();
  for (const id of fixture.servers)
    await expect(page.locator(`[data-collector-server="${id}"]`)).toBeVisible();
  await page.getByRole("button", { name: "Agent 接入", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agent 与 MCP 接入", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建 Agent", exact: true })).toBeEnabled();
  if (errors.length || csp.length)
    throw new Error(JSON.stringify({ errors, csp }));
  const evidence = {
    verifiedAt: new Date().toISOString(),
    productionUi: true,
    minedBlocks: fixture.minedBlocks,
    playerProfile: true,
    agentManagement: true,
    expectedCollectorCards: fixture.servers.length,
    pageErrors: 0,
    cspErrors: 0,
    realGameplay: false,
  };
  writeFileSync(
    new URL(".tools/production-ui-evidence.json", root),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
