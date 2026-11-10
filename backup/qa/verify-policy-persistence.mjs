import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { remoteBrowser } from "./remote-browser.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const base = process.env.MCM_QA_BASE_URL ?? "http://127.0.0.1:18088";
assert.equal(new URL(base).hostname, "127.0.0.1");
assert.equal(
  JSON.parse(
    await readFile(
      path.join(root, ".tools/game-qa-26.51.8/qa-provenance.json"),
      "utf8",
    ),
  ).owner,
  "MCManager-archive-isolated-qa",
);
const serverId = JSON.parse(
  await readFile(
    path.join(root, ".tools/game-qa-26.51.8/live-chat-fixture.json"),
    "utf8",
  ),
).serverId;
const original = JSON.parse(
  await readFile(
    path.join(root, ".tools/automatic-backup-game-evidence.json"),
    "utf8",
  ),
);
assert.equal(original.automaticRotationTested, true);
const environment = Object.fromEntries(
  (await readFile(path.join(root, ".env"), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.startsWith("MCM_") && line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
const cookies = new Map();
async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(900000),
    headers: {
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
      ...options.headers,
    },
  });
  for (const cookie of response.headers.getSetCookie()) {
    const at = cookie.indexOf("=");
    cookies.set(cookie.slice(0, at), cookie.slice(at + 1).split(";")[0]);
  }
  return response;
}
async function json(endpoint) {
  const result = await request(endpoint);
  assert.equal(result.status, 200);
  return result.json();
}
const csrf = await json("/api/auth/csrf");
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
const policy = (await json("/api/backup-policies?serverId=" + serverId))[0];
assert.equal(policy.enabled, false);
assert.equal(policy.retentionEnabled, false);
assert.ok(policy.prunedCount >= 1);
assert.equal(
  (await json("/api/backup-jobs/" + original.jobId)).archiveStatus,
  "DELETED",
);
assert.equal(
  (await json("/api/backups/" + original.catalogId)).status,
  "DELETED",
);
assert.equal(
  (await request("/api/backups/" + original.catalogId + "/content")).status,
  409,
);
assert.match(original.catalogId, /^[0-9a-f-]{36}$/);
const journalRead = await promisify(execFile)(
  "docker",
  [
    "compose",
    "-p",
    "mcmanager-archive-qa",
    "exec",
    "-T",
    "database",
    "psql",
    "-U",
    "mcmanager",
    "-d",
    "mcmanager",
    "-t",
    "-A",
    "-c",
    `SELECT row_to_json(e)::text FROM backup_retention_events e WHERE backup_id='${original.catalogId}'`,
  ],
  { cwd: root, windowsHide: true },
);
const journal = JSON.parse(journalRead.stdout.trim());
assert.equal(journal.state, "DELETED");
assert.equal(String(journal.archive_bytes), original.archiveBytes);
assert.ok(journal.policy_revision > 0);
assert.equal(journal.failure_code, null);
const kept = await json("/api/backup-jobs/" + original.rotation.secondJobId);
assert.equal(kept.status, "SUCCEEDED");
assert.equal(kept.archiveStatus, "READY");
const response = await request("/api/backups/" + kept.backupId + "/content");
assert.equal(response.status, 200);
const hash = createHash("sha256");
let bytes = 0n;
for await (const chunk of response.body) {
  hash.update(chunk);
  bytes += BigInt(chunk.length);
}
assert.equal(hash.digest("hex"), kept.archiveSha256);
assert.equal(bytes.toString(), kept.archiveBytes);
const evidence = {
  verifiedAt: new Date().toISOString(),
  policySettingsPersisted: true,
  deletionStatusAndJournalPersisted: true,
  rotatedCatalogId: original.catalogId,
  remainingCatalogId: kept.backupId,
  remainingArchiveSha256: kept.archiveSha256,
  downloadedBytes: bytes.toString(),
  remainingRealGameArchiveDownloaded: true,
  realGameplay: false,
  realGameArchiveSourceVerifiedAt: original.verifiedAt,
};
await writeFile(
  path.join(root, ".tools/automatic-backup-persistence-evidence.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
const browser = await remoteBrowser({
  base,
  username: environment.MCM_ADMIN_USERNAME ?? "admin",
  password: environment.MCM_ADMIN_PASSWORD,
  serverId,
  directory: path.join(root, ".tools"),
});
try {
  await browser.captureOverview(
    path.join(root, ".tools/automatic-backup-production.png"),
  );
} finally {
  await browser.close();
}
console.log(JSON.stringify(evidence, null, 2));
