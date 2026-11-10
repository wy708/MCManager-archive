// Actual deployed HTTP and file checks; deliberately no game or host restore executor.
import assert from "node:assert/strict";
import { randomUUID, createHash, createHmac } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const base = process.env.MCM_QA_BASE_URL ?? "http://127.0.0.1:18088";
assert.equal(new URL(base).hostname, "127.0.0.1");
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
let csrf, hostId, hostToken, runId;
const created = [];
async function request(route, options = {}, machine = false) {
  const response = await fetch(base + route, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(60000),
    headers: {
      ...(machine
        ? { Authorization: "Bearer " + hostToken }
        : {
            Cookie: [...cookies]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
          }),
      ...options.headers,
    },
  });
  if (!machine)
    for (const cookie of response.headers.getSetCookie()) {
      const at = cookie.indexOf("=");
      cookies.set(cookie.slice(0, at), cookie.slice(at + 1).split(";")[0]);
    }
  return response;
}
async function get(route) {
  const response = await request(route);
  assert.equal(response.status, 200);
  return response.json();
}
async function admin(route, body, method = "POST", expected = undefined) {
  const response = await request(route, {
    method,
    headers: {
      [csrf.headerName]: csrf.token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (expected !== undefined) {
    assert.equal(response.status, expected);
    return null;
  }
  assert.ok(response.ok, "Restore QA admin HTTP " + response.status);
  return response.status === 204 ? null : response.json();
}
async function machine(route, body, expected = 200) {
  const response = await request(
    "/api/host/v1" + route,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    true,
  );
  assert.equal(response.status, expected);
  return response.status === 204 ? null : response.json();
}
csrf = await get("/api/auth/csrf");
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
csrf = await get("/api/auth/csrf");
const evidenceFile = path.join(root, ".tools/restore-protocol-evidence.json");
if (process.argv.includes("--check-persistence")) {
  const old = JSON.parse(await readFile(evidenceFile, "utf8"));
  for (const id of old.restoreJobIds)
    assert.ok(
      ["CANCELLED", "FAILED"].includes(
        (await get("/api/restores/" + id)).status,
      ),
    );
  const response = await request("/api/backups/" + old.backupId + "/content");
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    old.archiveSha256,
  );
  const proof = {
    verifiedAt: new Date().toISOString(),
    restoreMetadataPersisted: true,
    archiveBytesPersisted: true,
    backupId: old.backupId,
    realGameplay: false,
    hostFilesystemRestored: false,
  };
  await writeFile(
    path.join(root, ".tools/restore-protocol-persistence-evidence.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(JSON.stringify(proof));
} else {
  const run = randomUUID(),
    directory = path.join(root, ".tools/restore-protocol-qa-" + run);
  await mkdir(directory);
  await writeFile(path.join(directory, ".qa-owner"), run);
  try {
    const server = await admin("/api/servers", {
      name: "恢复协议 HTTP 验收",
      description:
        "Synthetic protocol fixture; no game or filesystem restoration",
      startDate: "2020-01-01",
    });
    const issued = await admin("/api/backup-hosts", {
      serverId: server.id,
      name: "恢复协议验收执行端",
    });
    hostId = issued.host.id;
    hostToken = issued.token;
    runId = randomUUID();
    await machine("/heartbeat", {
      runId,
      state: "STOPPED",
      version: "0.4.0-protocol-qa",
      restoreEnabled: true,
    });
    const file = path.join(directory, "protocol.tar.gz");
    await promisify(execFile)(
      process.execPath,
      [
        path.join(root, "backup/qa/create-upload-fixture.mjs"),
        directory,
        server.id,
        file,
        "--large",
      ],
      { windowsHide: true },
    );
    const bytes = await readFile(file),
      sha = createHash("sha256").update(bytes).digest("hex");
    const backup = await admin("/api/servers/" + server.id + "/backups", {
      requestId: randomUUID(),
      kind: "MANUAL",
      note: "恢复协议验收，非游戏归档",
      permanent: false,
      expectedBytes: String(bytes.length),
    });
    assert.equal(
      (
        await request("/api/backups/" + backup.id + "/content", {
          method: "PUT",
          headers: {
            [csrf.headerName]: csrf.token,
            "Content-Type": "application/octet-stream",
          },
          body: bytes,
        })
      ).status,
      200,
    );
    const first = await admin("/api/backups/" + backup.id + "/restores", {
      requestId: randomUUID(),
      hostId,
      mode: "DISABLED",
      destinationName: "协议新目录",
      note: "不执行文件恢复",
      forkName: null,
      forkStartDate: null,
    });
    created.push(first.id);
    await admin("/api/backups/" + backup.id, undefined, "DELETE", 409);
    const claim = await machine("/restores/claim", {
        runId,
        requestId: randomUUID(),
      }),
      lease = { runId, attemptId: claim.attemptId };
    assert.equal(claim.job.id, first.id);
    await machine("/restores/" + first.id + "/start", lease);
    const response = await request(
      "/api/host/v1/restores/" + first.id + "/content",
      {
        headers: { "X-Host-Run": runId, "X-Restore-Attempt": claim.attemptId },
      },
      true,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("hex"),
      sha,
    );
    assert.equal(
      (await request("/api/backups/" + backup.id + "/content", {}, true))
        .status,
      401,
    );
    assert.equal(
      (await admin("/api/restores/" + first.id + "/cancel")).status,
      "RUNNING",
    );
    assert.equal(
      (await machine("/restores/" + first.id + "/renew", lease))
        .cancelRequested,
      true,
    );
    await machine("/restores/" + first.id + "/report", {
      ...lease,
      outcome: "CANCELLED",
      code: "OPERATOR_CANCELLED",
    });
    const forkRequest = {
      requestId: randomUUID(),
      hostId,
      mode: "FORK",
      destinationName: "协议新一期",
      note: "故障状态验收，不执行游戏恢复",
      forkName: "恢复协议新一期（未启动）",
      forkStartDate: new Date().toISOString().slice(0, 10),
    };
    const fork = await admin(
      "/api/backups/" + backup.id + "/restores",
      forkRequest,
    );
    created.push(fork.id);
    assert.equal(
      (await admin("/api/backups/" + backup.id + "/restores", forkRequest))
        .targetServerId,
      fork.targetServerId,
    );
    const c = await machine("/restores/claim", {
        runId,
        requestId: randomUUID(),
      }),
      forkLease = { runId, attemptId: c.attemptId };
    await machine("/restores/" + fork.id + "/start", forkLease);
    const secret =
      fork.targetServerId +
      "." +
      createHmac("sha256", hostToken)
        .update("mcmanager-restore:" + fork.id + ":" + fork.targetServerId)
        .digest("base64url");
    await machine("/restores/" + fork.id + "/collector", {
      ...forkLease,
      collectorToken: secret,
    });
    assert.ok(
      !JSON.stringify(
        await get("/api/restores?serverId=" + server.id),
      ).includes(secret),
    );
    await machine("/restores/" + fork.id + "/report", {
      ...forkLease,
      outcome: "FAILED",
      code: "RESTORE_FAILED",
    });
    assert.equal(
      (
        await request("/api/ingest/v1/batches", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + secret,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      401,
    );
    const evidence = {
      verifiedAt: new Date().toISOString(),
      serverId: server.id,
      backupId: backup.id,
      archiveSha256: sha,
      downloadedBytes: String(bytes.length),
      restoreJobIds: created,
      pinPreventedDeletion: true,
      jobScopedDownload: true,
      unrelatedDownloadDenied: true,
      cancellationAwaitedHostReport: true,
      forkCreationIdempotent: true,
      forkCredentialRevokedAfterFailure: true,
      realGameplay: false,
      hostFilesystemRestored: false,
    };
    await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
    await writeFile(
      path.join(directory, "evidence.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (hostId)
      await admin("/api/backup-hosts/" + hostId, undefined, "DELETE").catch(
        () => {},
      );
    for (const id of created) {
      const current = await admin("/api/restores/" + id + "/cancel").catch(
        () => null,
      );
      if (current?.status === "UNCERTAIN")
        await admin("/api/restores/" + id + "/resolve", {
          outcome: "FAILED",
          note: "协议验收未执行游戏文件恢复，保留诊断",
        }).catch(() => {});
    }
  }
}
