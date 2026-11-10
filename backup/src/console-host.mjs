#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { readHostConfig, acquireHostLock } from "./host-config.mjs";
import { assertServerStopped } from "./processes.mjs";
import { HostApi } from "./host-api.mjs";
import { ConsoleSession } from "./console-session.mjs";
import { check } from "./paths.mjs";
import { hostErrorMessage } from './host-errors.mjs';

let session,
  lock,
  closing = false,
  operation;
let stage = '读取执行端配置';
const wake = new AbortController();
process.on("SIGINT", () => {
  closing = true;
  wake.abort();
});
process.on("SIGTERM", () => {
  closing = true;
  wake.abort();
});
try {
  const args = process.argv.slice(2);
  check(
    args[0] === "--config" &&
      (args.length === 2 || (args.length === 3 && args[2] === "--start")),
    "Use --config <host.json> [--start]",
  );
  const config = await readHostConfig(args[1]);
  stage = '获取执行端控制通道';
  lock = await acquireHostLock(config.root);
  stage = '检查游戏进程';
  await assertServerStopped(config.root);
  stage = '连接平台并管理游戏';
  const api = new HostApi(config);
  session = new ConsoleSession(config, args[1]);
  session.onLine = (line) => process.stdout.write(line + "\n");
  let first = true,
    disconnected = false;
  session.log("网页控制台执行端已启动，等待平台连接。");
  if (args.includes("--start")) session.state = "STARTING";
  while (!closing) {
    const payload = session.payload();
    try {
      const response = await api.post("/console/sync", payload);
      check(
        response.serverId === config.serverId &&
          response.hostId === config.hostId &&
          response.runId === session.runId,
        "Console binding mismatch",
      );
      session.acknowledge(payload);
      if (disconnected) {
        session.log("平台连接已恢复。");
        disconnected = false;
      }
      if (first) {
        first = false;
        if (args.includes("--start"))
          operation = session
            .start()
            .catch(error => session.log('游戏启动失败：' + hostErrorMessage(error)))
            .finally(() => (operation = null));
      }
      if (response.command) {
        check(!operation, "Overlapping console operation");
        operation = session
          .execute(response.command)
          .catch(() => {
            closing = true;
          })
          .finally(() => (operation = null));
      }
    } catch (error) {
      if (!disconnected) {
        console.error('平台连接中断：' + hostErrorMessage(error));
        disconnected = true;
      }
      if ([401, 403, 409].includes(error.status)) {
        closing = true;
        break;
      }
    }
    await delay(1000, undefined, { signal: wake.signal }).catch(() => {});
  }
  await operation;
  await session.stop();
  session.state = "DISCONNECTED";
  await api.post("/console/sync", session.payload()).catch(() => {});
} catch (error) {
  console.error('执行端未完成【' + stage + '】：' + hostErrorMessage(error, stage));
  process.exitCode = 1;
} finally {
  await operation?.catch(() => {});
  await session?.stop().catch(() => {});
  await lock?.close();
}
