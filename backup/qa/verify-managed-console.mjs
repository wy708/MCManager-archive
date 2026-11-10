import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspectBackup } from "../src/archive.mjs";
import { assertServerStopped } from "../src/processes.mjs";
const root = path.resolve(".tools/game-qa-26.51.8"),
  owner = randomUUID(),
  directory = path.resolve(".tools/managed-cli-qa-" + owner);
assert.equal(
  JSON.parse(await readFile(path.join(root, "qa-provenance.json"))).owner,
  "MCManager-archive-isolated-qa",
);
await assertServerStopped(root);
await mkdir(directory);
await writeFile(path.join(directory, ".qa-owner"), owner);
const serverId = JSON.parse(
  await readFile(path.join(root, "live-chat-fixture.json")),
).serverId;
const config = path.join(root, "plugins/archive-collector/config/config.json"),
  original = await readFile(config);
await writeFile(
  config,
  JSON.stringify({ ...JSON.parse(original), enabled: false }),
);
let child,
  closed = false,
  code,
  output = "",
  result;
async function until(check) {
  for (let i = 0; i < 1800; i++) {
    if (closed) throw new Error("CLI exited early " + code);
    if (await check()) return;
    await delay(100);
  }
  throw new Error("CLI QA timeout");
}
try {
  child = spawn(
    process.execPath,
    [
      "backup/src/serve.mjs",
      "--root",
      root,
      "--output-directory",
      directory,
      "--server-id",
      serverId,
    ],
    {
      cwd: path.resolve("."),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exit = new Promise((resolve) =>
    child.once("exit", (value) => {
      closed = true;
      code = value;
      resolve(value);
    }),
  );
  child.stderr.on("data", (chunk) => {
    output += chunk;
    appendFile(path.join(directory, "game.log"), chunk).catch(() => {});
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const value = JSON.parse(line);
        if (value.snapshotMode === "BDS_SAVE_QUERY") result = value;
      } catch {}
    }
  });
  await until(() => output.includes('"phase":"IDLE"'));
  child.stdin.write("backup 本地入口实服验收\n");
  await until(() => result);
  const proof = await inspectBackup(result.path);
  assert.equal(proof.manifest.coordination.nativeWriteCacheFlushed, true);
  assert.equal(proof.sha256, result.sha256);
  child.stdin.write("stop\n");
  assert.equal(
    await Promise.race([
      exit,
      delay(45000, undefined, { ref: false }).then(() => {
        throw new Error("CLI stop timeout");
      }),
    ]),
    0,
  );
  console.log(
    JSON.stringify({
      managedConsoleCliVerified: true,
      realGame: true,
      backupId: result.backupId,
      archiveBytes: result.archiveBytes,
      cleanStop: true,
      directory,
    }),
  );
} finally {
  if (child && !closed) {
    child.stdin.write("stop\n");
    for (let i = 0; i < 450 && !closed; i++) await delay(100);
  }
  await writeFile(config, original);
}
