import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, request as httpRequest } from "node:http";
import {
  readFileSync,
  appendFileSync,
  createWriteStream,
  createReadStream,
} from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";
import { localGameClient } from "../../collector/qa/http-client.mjs";
import { inputDriver } from "../../collector/qa/input-driver.mjs";
import { ManagedGame } from "../src/managed-game.mjs";
import { restoreBackup, inspectBackup } from "../src/archive.mjs";
import { canonicalJson, missing } from "../src/paths.mjs";
import { HostStore } from "../src/host-store.mjs";
import { assertServerStopped } from "../src/processes.mjs";

const project = fileURLToPath(new URL("../../", import.meta.url)),
  source = path.join(project, ".tools/game-qa-26.51.8");
assert.equal(
  JSON.parse(readFileSync(path.join(source, "qa-provenance.json"))).owner,
  "MCManager-archive-isolated-qa",
);
await assertServerStopped(source);
assert.ok(await missing(path.join(source, ".mcmanager-backup.lock")), "Preserve and reconcile the previous QA lock before starting a new fixture");
const serverId = JSON.parse(
  readFileSync(path.join(source, "live-chat-fixture.json")),
).serverId;
const base = process.env.MCM_QA_BASE_URL ?? "http://127.0.0.1:18088";
assert.equal(new URL(base).hostname, "127.0.0.1");
const environment = Object.fromEntries(
  readFileSync(path.join(project, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("MCM_") && line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
const run = randomUUID(),
  directory = path.join(project, ".tools", "remote-host-qa-" + run),
  offlineIdentity = randomUUID();
await mkdir(directory);
await writeFile(path.join(directory, ".qa-owner"), run);
const configPath = path.join(
    source,
    "plugins/archive-collector/config/config.json",
  ),
  originalConfig = await readFile(configPath);
const cookies = new Map(),
  events = [],
  native = [],
  operations = new Set();
let csrf,
  hostId,
  agentId,
  mcp,
  child,
  remoteExit,
  remoteCode,
  restoredGame,
  bot,
  expectedClose = false,
  failure,
  heldUpload = false,
  holdUploads = true,
  gamePid,
  proxy,
  browser;
const stalled = new Set(),
  interruptCopy = process.argv.includes("--interrupt-copy");
const interruptSupervisor = process.argv.includes("--interrupt-supervisor");
const automatic = process.argv.includes("--automatic");
assert.ok(
  !automatic || process.argv.includes("--browser"),
  "Automatic QA requires the production browser",
);
let rotation,
  protectedBefore = [];
let interruptedCopyVerified = false;
const supervisorRestarts = [];
async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, {
    ...options,
    redirect: "error",
    headers: {
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      ...options.headers,
    },
    signal: AbortSignal.timeout(900000),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const at = cookie.indexOf("=");
    cookies.set(cookie.slice(0, at), cookie.slice(at + 1).split(";")[0]);
  }
  return response;
}
async function admin(endpoint, body, method = "POST") {
  const response = await request(endpoint, {
    method,
    headers: {
      [csrf.headerName]: csrf.token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `Remote host QA admin HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function tool(name, args = {}) {
  const value = await mcp.callTool({ name, arguments: args });
  assert.notEqual(value.isError, true);
  return value.structuredContent.data;
}
async function until(action, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (failure) throw failure;
    if (child && remoteCode !== undefined && remoteCode !== 0)
      throw new Error("Remote host CLI exited " + remoteCode);
    const value = await action();
    if (value) return value;
    await delay(100);
  }
  throw new Error("Remote host QA timed out; inspect its owned logs");
}
async function command(text) {
  const input = restoredGame?.child.stdin ?? child.stdin;
  input.write(text + "\n");
  await delay(200);
}
async function block(state, type) {
  const id = randomUUID();
  await command(`execute if block 2 105 2 ${type} run say ${id}`);
  await until(() => state.texts.some((packet) => packet.message.includes(id)));
}
async function connect() {
  expectedClose = false;
  const state = { texts: [], held: null, spawned: false };
  bot = await localGameClient(
    "http://127.0.0.1:19152",
    "ArchiveQA",
    (error) => {
      if (!expectedClose) failure = error;
    },
    offlineIdentity,
  );
  bot.on("text", (p) => state.texts.push(p));
  bot.on("spawn", () => (state.spawned = true));
  bot.on("inventory_content", (p) => {
    if (["inventory", 0].includes(p.window_id)) state.held = p.input[0];
  });
  bot.on("inventory_slot", (p) => {
    if (["inventory", 0].includes(p.window_id) && p.slot === 0)
      state.held = p.item;
  });
  await until(() => state.spawned);
  inputDriver(bot);
  return state;
}
async function nativeStatus() {
  const operationId = randomUUID(),
    requestId = randomUUID();
  child.stdin.write(
    `archivebackup status ${operationId} ${requestId} bootstrap 0\n`,
  );
  return until(() => native.find((value) => value.requestId === requestId));
}
function processExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}
async function hostState() {
  return (await (await request("/api/backup-hosts?serverId=" + serverId)).json())
    .find((host) => host.id === hostId);
}
async function waitForExit(pid) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (processExited(pid)) return;
    await delay(100);
  }
  throw new Error("Owned process did not exit: " + pid);
}
function launchRemote(hostConfig) {
  remoteCode = undefined;
  gamePid = undefined;
  const remoteProcess = spawn(
    process.execPath,
    [path.join(project, "backup/src/remote.mjs"), "--config", hostConfig],
    { cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  child = remoteProcess;
  remoteExit = new Promise((resolve, reject) => {
    remoteProcess.once("exit", (code) => {
      remoteCode = code;
      resolve(code);
    });
    remoteProcess.once("error", reject);
  });
  let lines = "";
  remoteProcess.stdout.on("data", (chunk) => {
    appendFileSync(path.join(directory, "host-events.log"), chunk);
    lines += chunk;
    let at;
    while ((at = lines.indexOf("\n")) >= 0) {
      const line = lines.slice(0, at);
      lines = lines.slice(at + 1);
      try {
        const value = JSON.parse(line);
        events.push(value);
        if (value.event === "GAME_STARTED") gamePid = value.pid;
      } catch {}
    }
  });
  let consoleLines = "";
  remoteProcess.stderr.on("data", (chunk) => {
    appendFileSync(path.join(directory, "game.log"), chunk);
    consoleLines += chunk;
    let at;
    while ((at = consoleLines.indexOf("\n")) >= 0) {
      const line = consoleLines.slice(0, at);
      consoleLines = consoleLines.slice(at + 1);
      const marker = line.indexOf("MCM_ARCHIVE_BACKUP ");
      if (marker < 0) continue;
      try {
        const value = JSON.parse(line.slice(marker + 19));
        native.push(value);
        if (value.leaseOwned) operations.add(value.operationId);
      } catch {}
    }
  });
}
try {
  csrf = await (await request("/api/auth/csrf")).json();
  assert.equal(
    (
      await request("/api/auth/login", {
        method: "POST",
        headers: { [csrf.headerName]: csrf.token },
        body: new URLSearchParams({
          username: environment.MCM_ADMIN_USERNAME ?? "admin",
          password: environment.MCM_ADMIN_PASSWORD,
        }),
      })
    ).status,
    204,
  );
  csrf = await (await request("/api/auth/csrf")).json();
  const collector = (
    await admin(`/api/servers/${serverId}/collector-credential`)
  ).token;
  await writeFile(
    configPath,
    canonicalJson({
      enabled: true,
      serverId,
      token: collector,
      endpoint: base + "/api/ingest/v1/batches",
    }),
  );
  const existing = await (
    await request("/api/backup-hosts?serverId=" + serverId)
  ).json();
  if (existing.length) assert.equal(existing[0].name, "实服远程备份验收");
  hostId = existing[0]?.id;
  if (process.argv.includes("--browser")) {
    const { remoteBrowser } = await import("./remote-browser.mjs");
    browser = await remoteBrowser({
      base,
      username: environment.MCM_ADMIN_USERNAME ?? "admin",
      password: environment.MCM_ADMIN_PASSWORD,
      serverId,
      directory,
    });
  }
  const issued = browser
    ? await browser.issue(existing[0])
    : existing.length
      ? await admin("/api/backup-hosts/" + existing[0].id + "/rotate")
      : await admin("/api/backup-hosts", {
          serverId,
          name: "实服远程备份验收",
        });
  hostId = issued.host.id;
  const previous = await (
    await request("/api/backup-jobs?serverId=" + serverId + "&size=100")
  ).json();
  for (const job of previous.items)
    if (job.hostId === hostId && job.status === "UNCERTAIN")
      await admin("/api/backup-jobs/" + job.id + "/resolve", {
        outcome: "FAILED",
        note: "前次自有 QA 执行进程已退出，保留原始诊断",
      });
  const agent = await admin("/api/agents", {
    name: "远程备份真实恢复验收",
    grants: [{ serverId, scopes: ["STATS_READ", "CHAT_READ"] }],
  });
  agentId = agent.account.id;
  mcp = new Client({ name: "remote-host-game-verifier", version: "0.5.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(project, "mcp/src/server.mjs")],
      env: { MCM_MCP_API_URL: base, MCM_AGENT_TOKEN: agent.token },
      stderr: "inherit",
    }),
  );
  proxy = createServer((incoming, outgoing) => {
    if (
      holdUploads &&
      incoming.method === "PUT" &&
      incoming.url.endsWith("/content")
    ) {
      heldUpload = true;
      stalled.add(outgoing);
      outgoing.on("close", () => stalled.delete(outgoing));
      incoming.pause();
      return;
    }
    const forwarded = httpRequest(
      new URL(incoming.url, base),
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: new URL(base).host },
      },
      (reply) => {
        outgoing.writeHead(reply.statusCode, reply.headers);
        reply.pipe(outgoing);
      },
    );
    incoming.on("aborted", () => forwarded.destroy());
    outgoing.on("close", () => {
      if (!outgoing.writableEnded) forwarded.destroy();
    });
    forwarded.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(forwarded);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const outputDirectory = path.join(directory, "backups");
  await mkdir(outputDirectory);
  const hostConfig = path.join(directory, "host.json");
  if (browser)
    await browser.saveConfig({
      apiUrl: `http://127.0.0.1:${proxy.address().port}`,
      token: issued.token,
      root: source,
      outputDirectory,
      file: hostConfig,
    });
  else
    await writeFile(
      hostConfig,
      canonicalJson({
        apiUrl: `http://127.0.0.1:${proxy.address().port}`,
        token: issued.token,
        root: source,
        outputDirectory,
        serverId,
      }),
    );
  const chatCursor = (await tool("get_chat_messages", { serverId })).highWatermark;
  const gameStarts = () => events.filter((event) => event.event === "GAME_STARTED");
  const lastWorker = () => events.filter((event) => event.event === "HOST_WORKER_STARTED").at(-1).pid;
  async function restartAfterSupervisorCrash(stage) {
    const before = await hostState();
    assert.equal(before.runtimeState, "RUNNING");
    assert.equal(gameStarts().at(-1).supervisorGuard, true);
    const stopped = { supervisor: child.pid, game: gamePid, worker: lastWorker() };
    const logFile = path.join(source, "logs/latest.log");
    const logOffset = (await readFile(logFile)).length;
    expectedClose = true;
    assert.equal(child.kill("SIGKILL"), true);
    assert.notEqual(await remoteExit, 0);
    await Promise.all([waitForExit(stopped.worker), waitForExit(stopped.game)]);
    bot?.close();
    bot = null;
    const exitLog = (await readFile(logFile)).subarray(logOffset).toString("utf8");
    assert.match(exitLog, /Managed host supervisor unavailable; requesting a normal game shutdown/);
    assert.match(exitLog, /Stopping server/i);
    await writeFile(path.join(directory, stage + "-native-stop.log"), exitLog);
    const pending = await hostState();
    assert.equal(pending.runnerId, before.runnerId);
    assert.equal(pending.runtimeState, "RUNNING", "The disconnected worker reported a false clean stop");
    launchRemote(hostConfig);
    await until(() => gamePid && gamePid !== stopped.game);
    assert.equal(gameStarts().at(-1).supervisorGuard, true);
    const replacement = await until(async () => {
      const host = await hostState();
      return host.online && host.runnerId !== before.runnerId && host.runtimeState === "RUNNING" ? host : null;
    }, 120000);
    supervisorRestarts.push({ stage, stopped, replacementGame: gamePid, oldRun: before.runnerId, newRun: replacement.runnerId });
    console.log(JSON.stringify({ stage: stage + "-supervisor-recovered", gamePid }));
    return connect();
  }
  launchRemote(hostConfig);
  await until(() => gamePid);
  let player = await connect();
  await command("gamemode creative ArchiveQA");
  await command("tp ArchiveQA 0.5 100 0.5");
  await command("setblock 2 105 2 gold_block");
  await block(player, "gold_block");
  await command("replaceitem entity ArchiveQA slot.hotbar 0 diamond 7");
  await until(() => player.held?.count === 7);
  const item = { count: 7, networkId: player.held.network_id };
  const preChat = "远程任务之前 " + run;
  bot.queue("text", {
    category: "authored",
    type: "chat",
    needs_translation: false,
    source_name: "ArchiveQA",
    xuid: "",
    platform_chat_id: "",
    has_filtered_message: false,
    message: preChat,
  });
  const qaChat = await until(async () =>
    (await tool("get_chat_messages", { serverId, after: chatCursor, limit: 200 })).items.find(
      (row) => row.text === preChat,
    ),
  );
  await until(
    async () =>
      (
        await (await request("/api/backup-hosts?serverId=" + serverId)).json()
      )[0].online,
  );
  if (interruptSupervisor) {
    const game = gamePid, worker = lastWorker();
    process.kill(worker);
    await until(() => lastWorker() !== worker);
    assert.equal(gamePid, game);
    assert.equal((await nativeStatus()).supervisorGuard, true);
    await block(player, "gold_block");
  }
  if (interruptCopy) {
    const baseline = native.length,
      fault = browser
        ? await browser.createTask("实服制作中断验收，不能自动重做", false)
        : await admin(`/api/servers/${serverId}/backup-jobs`, {
            requestId: randomUUID(),
            hostId,
            kind: "MANUAL",
            note: "实服制作中断验收，不能自动重做",
            permanent: false,
          });
    await until(() =>
      native
        .slice(baseline)
        .some((row) => row.phase === "READY" && row.leaseOwned),
    );
    if (interruptSupervisor) {
      player = await restartAfterSupervisorCrash("interrupted-copy");
      await until(() => player.held?.count === 7);
      await block(player, "gold_block");
    } else {
      const killed = lastWorker();
      process.kill(killed);
      await until(() => lastWorker() !== killed);
    }
    await until(
      async () =>
        (await (await request("/api/backup-jobs/" + fault.id)).json())
          .status === "UNCERTAIN",
    );
    const store = await HostStore.open(
      path.join(outputDirectory, ".mcmanager-host-" + hostId),
      hostId,
      serverId,
    );
    const record = await until(async () =>
      (await store.records()).find(
        (value) => value.jobId === fault.id && value.phase === "UNCERTAIN",
      ),
    );
    await until(
      async () => await missing(path.join(source, ".mcmanager-backup.lock")),
      30000,
    );
    assert.equal((await nativeStatus()).nativeQuerySuccess, 0);
    const files = await readdir(store.location(record.jobId, record.attemptId));
    assert.ok(files.some((name) => name.startsWith("interrupted-lock-")));
    assert.equal(await missing(store.archive(record)), true);
    assert.equal(operations.size, 1);
    const current = await (
      await request("/api/backup-jobs/" + fault.id)
    ).json();
    assert.equal(current.backupId, null);
    if (browser)
      await browser.resolve(
        fault.id,
        "自有 QA 已确认制作进程退出，原生快照释放，保留未完成文件和诊断",
      );
    else
      await admin("/api/backup-jobs/" + fault.id + "/resolve", {
        outcome: "FAILED",
        note: "自有 QA 已确认制作进程退出，原生快照释放，保留未完成文件和诊断",
      });
    interruptedCopyVerified = true;
    console.log(
      JSON.stringify({
        stage: "interrupted-copy-preserved-without-reexecution",
        jobId: fault.id,
        gamePid,
      }),
    );
  }
  const completedJobBaseline = native.length;
  if (automatic)
    protectedBefore = (
      await (await request(`/api/backups?serverId=${serverId}&size=100`)).json()
    ).items
      .filter((row) => row.status === "READY" && row.kind !== "AUTOMATIC")
      .map((row) => ({ id: row.id, sha256: row.sha256 }));
  const job = automatic
    ? await browser.scheduleTask()
    : browser
      ? await browser.createTask("真实游戏远程任务与上传进程崩溃恢复验收", true)
      : await admin(`/api/servers/${serverId}/backup-jobs`, {
          requestId: randomUUID(),
          hostId,
          kind: "MANUAL",
          note: "真实游戏远程任务与上传进程崩溃恢复验收",
          permanent: true,
        });
  await until(() =>
    native
      .slice(completedJobBaseline)
      .some((row) => row.phase === "READY" && row.leaseOwned),
  );
  await command("setblock 2 105 2 air");
  await command("replaceitem entity ArchiveQA slot.hotbar 0 diamond 11");
  const during = "远程备份期间继续聊天 " + run;
  bot.queue("text", {
    category: "authored",
    type: "chat",
    needs_translation: false,
    source_name: "ArchiveQA",
    xuid: "",
    platform_chat_id: "",
    has_filtered_message: false,
    message: during,
  });
  await until(() => player.texts.some((p) => p.message === during));
  await until(async () =>
    (await tool("get_chat_messages", { serverId, after: chatCursor, limit: 200 })).items.some(
      (row) => row.text === during,
    ),
  );
  assert.ok(
    !native.slice(completedJobBaseline).some((row) => row.phase === "RELEASED"),
  );
  const collectorCheckpoint = native.slice(completedJobBaseline)
    .find((row) => row.phase === "READY" && row.leaseOwned)?.collectorCheckpoint;
  assert.ok(collectorCheckpoint, "The live collector checkpoint was not confirmed");
  await until(async () => {
    if (heldUpload) return true;
    const state = await (await request("/api/backup-jobs/" + job.id)).json();
    assert.ok(!["FAILED", "CANCELLED", "UNCERTAIN"].includes(state.status), "Backup did not reach upload: " + state.errorCode);
  }, 180000);
  const firstWorker = lastWorker();
  assert.ok(firstWorker && firstWorker !== gamePid);
  const beforeKill = await (await request("/api/backup-jobs/" + job.id)).json();
  assert.equal(beforeKill.status, "UPLOADING");
  const originalSourceId = beforeKill.sourceBackupId,
    originalSha = beforeKill.archiveSha256;
  if (interruptSupervisor) {
    player = await restartAfterSupervisorCrash("interrupted-upload");
  } else {
    process.kill(firstWorker);
    await until(() => lastWorker() !== firstWorker);
  }
  holdUploads = false;
  for (const response of stalled) response.destroy();
  console.log(
    JSON.stringify({
      stage: interruptSupervisor ? "supervisor-killed-and-restarted" : "worker-killed-and-restarted",
      firstWorker,
      gamePid,
      sourceBackupId: originalSourceId,
    }),
  );
  const completed = await until(async () => {
    const value = await (await request("/api/backup-jobs/" + job.id)).json();
    return value.status === "SUCCEEDED" ? value : null;
  }, 180000);
  assert.equal(completed.sourceBackupId, originalSourceId);
  assert.equal(completed.archiveSha256, originalSha);
  assert.equal(operations.size, 1 + Number(interruptCopy));
  const completedOperations = operations.size;
  assert.equal((await nativeStatus()).nativeQuerySuccess, 0);
  assert.equal(remoteCode, undefined);
  await block(player, "air");
  await until(() => player.held?.count === 11);
  await until(async () =>
    (await tool("get_chat_messages", { serverId, after: chatCursor, limit: 200 })).items.some(
      (row) => row.text === during,
    ),
  );
  const downloaded = path.join(directory, "downloaded.tar.gz");
  if (automatic) {
    assert.equal(job.kind, "AUTOMATIC");
    assert.equal(completed.permanent, false);
    await browser.download(job.id, completed.backupId, downloaded);
    const second = await until(async () => {
      const jobs = await (
        await request(`/api/backup-jobs?serverId=${serverId}&size=100`)
      ).json();
      return jobs.items.find(
        (row) =>
          row.kind === "AUTOMATIC" &&
          row.id !== job.id &&
          Date.parse(row.createdAt) > Date.parse(job.createdAt) &&
          row.status === "SUCCEEDED",
      );
    }, 300000);
    await until(
      async () =>
        ["DELETING", "DELETED"].includes(
          (await (await request(`/api/backups/${completed.backupId}`)).json())
            .status,
        ),
      60000,
    );
    await browser.disableAutomatic();
    await until(
      async () =>
        (await (await request(`/api/backups/${completed.backupId}`)).json())
          .status === "DELETED",
      60000,
    );
    for (const previous of protectedBefore) {
      const preserved = await (
        await request(`/api/backups/${previous.id}`)
      ).json();
      assert.equal(preserved.status, "READY");
      assert.equal(preserved.sha256, previous.sha256);
    }
    assert.equal(
      (await request(`/api/backups/${completed.backupId}/content`)).status,
      409,
    );
    const files = await promisify(execFile)(
      "docker",
      [
        "compose",
        "-p",
        "mcmanager-archive-qa",
        "exec",
        "-T",
        "backend",
        "find",
        "/app/data/backups/objects",
        "-maxdepth",
        "1",
        "-name",
        `${completed.backupId}-*.tar.gz`,
      ],
      { cwd: project, windowsHide: true },
    );
    assert.equal(files.stdout.trim(), "");
    await browser.assertRotated(job.id);
    rotation = {
      secondJobId: second.id,
      secondCatalogId: second.backupId,
      rotatedCatalogId: completed.backupId,
      deletedFileAbsent: true,
      protectedArchivesPreserved: protectedBefore.length,
      policyDisabledBeforeStop: true,
    };
    console.log(
      JSON.stringify({ stage: "automatic-rotation-verified", ...rotation }),
    );
  }
  expectedClose = true;
  bot.close();
  bot = null;
  child.stdin.write("stop\n");
  assert.equal(
    await Promise.race([
      remoteExit,
      delay(60000, undefined, { ref: false }).then(() => {
        throw new Error("Remote CLI stop timeout");
      }),
    ]),
    0,
  );
  child = null;
  assert.equal(
    (await (await request("/api/backup-hosts?serverId=" + serverId)).json())[0]
      .runtimeState,
    "STOPPED",
  );
  const beforeRestore = await tool("get_player_context", {
    serverId,
    playerKey: qaChat.playerKey,
  });
  if (automatic) {
    /* Downloaded before deliberate rotation. */
  } else if (browser)
    await browser.download(job.id, completed.backupId, downloaded);
  else {
    const response = await request(
      "/api/backups/" + completed.backupId + "/content",
    );
    assert.equal(response.status, 200);
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(downloaded, { flags: "wx" }),
    );
  }
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(downloaded),
    new Transform({
      transform(chunk, _, done) {
        hash.update(chunk);
        done();
      },
    }),
  );
  assert.equal(hash.digest("hex"), originalSha);
  const proof = await inspectBackup(downloaded);
  assert.equal(proof.manifest.backupId, originalSourceId);
  assert.equal(proof.manifest.producer.version, "0.6.0");
  assert.deepEqual(proof.manifest.coordination.collectorCheckpoint, collectorCheckpoint);
  const restored = path.join(directory, "restored");
  await restoreBackup({ file: downloaded, destination: restored });
  restoredGame = await ManagedGame.start(restored, {
    output: (chunk) =>
      appendFileSync(path.join(directory, "restored-game.log"), chunk),
  });
  const restoredPlayer = await connect();
  await until(
    () =>
      restoredPlayer.held?.count === item.count &&
      restoredPlayer.held.network_id === item.networkId,
  );
  await block(restoredPlayer, "gold_block");
  expectedClose = true;
  bot.close();
  bot = null;
  assert.equal(await restoredGame.stop(), 0);
  restoredGame = null;
  const afterRestore = await tool("get_player_context", {
    serverId,
    playerKey: qaChat.playerKey,
  });
  assert.deepEqual(
    afterRestore.statistics.metrics,
    beforeRestore.statistics.metrics,
  );
  const evidence = {
    verifiedAt: new Date().toISOString(),
    jobId: job.id,
    catalogId: completed.backupId,
    backupId: originalSourceId,
    archiveSha256: originalSha,
    archiveBytes: completed.archiveBytes,
    realGameplay: true,
    bdsVersion: "1.26.51.1",
    leviLaminaVersion: "26.51.8",
    hostVersion: "0.6.0",
    publicRemoteCliExecuted: true,
    productionBrowserExecuted: Boolean(browser),
    browserConfigDownloadedAndUsed: Boolean(browser),
    browserTaskCreatedAndArchiveDownloaded: Boolean(browser),
    actualWorkerProcessKilled: !interruptSupervisor,
    workerRestartedWithSameGameProcess: !interruptSupervisor,
    workerOnlyFailurePreservedRunningGame: true,
    supervisorRestarts,
    playerStayedOnlineUntilArchiveWasCreated: true,
    collectorCheckpoint,
    nativeSnapshotsForCompletedJob: completedOperations - Number(interruptCopy),
    interruptedCopyPreservedWithoutReexecution: interruptedCopyVerified,
    interruptedOwnedLockRetainedAndReleased: interruptedCopyVerified,
    originalArchiveUploadedAfterRestart: true,
    chatReceivedDuringSnapshot: true,
    downloadedArchiveWorldAndInventoryRestored: true,
    disabledRestoreDidNotChangeStatistics: true,
    sourceAndRestoredStoppedCleanly: true,
    offMachineNetworkTested: false,
    automaticSchedulingTested: automatic,
    automaticRotationTested: Boolean(rotation),
    rotation,
  };
  await writeFile(
    path.join(directory, "evidence.json"),
    canonicalJson(evidence),
  );
  await writeFile(
    path.join(project, interruptSupervisor ? ".tools/remote-supervisor-evidence.json" : ".tools/remote-host-evidence.json"),
    canonicalJson(evidence),
  );
  if (browser)
    await writeFile(
      path.join(project, ".tools/remote-host-browser-evidence.json"),
      canonicalJson(evidence),
    );
  if (automatic)
    await writeFile(
      path.join(project, ".tools/automatic-backup-game-evidence.json"),
      canonicalJson(evidence),
    );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (automatic && csrf) {
    const current = await (
      await request(`/api/backup-policies?serverId=${serverId}`)
    )
      .json()
      .catch(() => []);
    if (current.length)
      await admin(
        `/api/servers/${serverId}/backup-policy`,
        {
          revision: current[0].revision,
          hostId,
          enabled: false,
          intervalMinutes: 1,
          firstRunAt: null,
          retentionEnabled: false,
          keepCount: 1,
          maxAgeDays: null,
        },
        "PUT",
      ).catch(() => {});
  }
  holdUploads = false;
  for (const response of stalled) response.destroy();
  expectedClose = true;
  bot?.close();
  if (child && remoteCode === undefined) {
    child.stdin.write("stop\n");
    await remoteExit.catch(() => {});
  }
  if (restoredGame) await restoredGame.stop().catch(() => {});
  proxy?.closeAllConnections();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  await mcp?.close();
  await browser?.close();
  if (hostId)
    await admin("/api/backup-hosts/" + hostId, undefined, "DELETE").catch(
      () => {},
    );
  if (agentId)
    await admin("/api/agents/" + agentId, undefined, "DELETE").catch(() => {});
  if (csrf)
    await admin(
      `/api/servers/${serverId}/collector-credential`,
      undefined,
      "DELETE",
    ).catch(() => {});
  await writeFile(configPath, originalConfig);
}
