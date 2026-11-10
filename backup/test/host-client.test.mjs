import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
  link,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HostApi, HostApiError } from "../src/host-api.mjs";
import { HostStore } from "../src/host-store.mjs";
import { acquireHostLock } from "../src/host-config.mjs";
import { SnapshotControl } from "../src/snapshot-control.mjs";

test('restore download authenticates its attempt, verifies bytes and never replaces an existing archive',()=>sandbox(async parent=>{
  const body=Buffer.from('actual streamed archive bytes'),job={id:randomUUID(),archiveBytes:String(body.length),archiveSha256:createHash('sha256').update(body).digest('hex')},runId=randomUUID(),attemptId=randomUUID();
  await http((req,res)=>{
    assert.equal(req.url,`/api/host/v1/restores/${job.id}/content`);assert.equal(req.headers.authorization,'Bearer '+token);
    assert.equal(req.headers['x-host-run'],runId);assert.equal(req.headers['x-restore-attempt'],attemptId);
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':body.length,'X-Archive-SHA256':job.archiveSha256});res.end(body);
  },async apiUrl=>{
    const api=new HostApi({apiUrl,token}),file=path.join(parent,'archive.tar.gz');
    await api.downloadRestore(job,runId,attemptId,file);assert.deepEqual(await readFile(file),body);
    await writeFile(file,'precious-original');await assert.rejects(api.downloadRestore(job,runId,attemptId,file),HostApiError);
    assert.equal(await readFile(file,'utf8'),'precious-original');
  });
}));

test('redirects, truncated streams and incorrect restore checksums never publish a usable archive',()=>sandbox(async parent=>{
  const body=Buffer.from('expected bytes'),job={id:randomUUID(),archiveBytes:String(body.length),archiveSha256:createHash('sha256').update(body).digest('hex')};let targetCalls=0;
  await http((req,res)=>{targetCalls++;res.end();},async target=>{
    for(const failure of ['redirect','truncated','checksum','html'])await http((req,res)=>{
      if(failure==='redirect'){res.writeHead(302,{Location:target});res.end();return;}
      res.writeHead(200,{'Content-Type':failure==='html'?'text/html':'application/octet-stream','Content-Length':body.length,'X-Archive-SHA256':job.archiveSha256});
      if(failure==='truncated'){res.write(body.subarray(0,3));res.destroy();return;}
      res.end(failure==='checksum'?Buffer.alloc(body.length,120):body);
    },async apiUrl=>{
      const file=path.join(parent,failure+'.tar.gz');await assert.rejects(new HostApi({apiUrl,token}).downloadRestore(job,randomUUID(),randomUUID(),file),HostApiError);
      assert.equal((await readdir(parent)).includes(failure+'.tar.gz'),false);
    });
  });assert.equal(targetCalls,0);
}));

const hostId = randomUUID(),
  serverId = randomUUID(),
  token = `mcmhost.${hostId}.${"A".repeat(43)}`;
async function sandbox(action) {
  const directory = await mkdtemp(
      path.join(os.tmpdir(), "mcmanager-host-test-"),
    ),
    owner = randomUUID();
  await writeFile(path.join(directory, ".owner"), owner);
  try {
    await action(await realpath(directory));
  } finally {
    const actual = await realpath(directory);
    assert.equal(path.dirname(actual), await realpath(os.tmpdir()));
    assert.equal(await readFile(path.join(actual, ".owner"), "utf8"), owner);
    await rm(actual, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  }
}
async function http(handler, action) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await action(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
test("host client permits only explicit origins and an independent host credential", () => {
  for (const apiUrl of [
    "http://example.com",
    "https://example.com/path",
    "https://u:p@example.com",
    "https://example.com/?token=x",
    "https://example.com/#x",
    "file:///tmp",
  ])
    assert.throws(() => new HostApi({ apiUrl, token }));
  assert.doesNotThrow(
    () =>
      new HostApi({
        apiUrl: "http://192.0.2.10:8088",
        token,
        allowHttp: true,
      }),
  );
  for (const wrong of [
    "admin-password",
    `mcmagent.${hostId}.${"A".repeat(43)}`,
    `${serverId}.${"A".repeat(43)}`,
  ])
    assert.throws(
      () => new HostApi({ apiUrl: "https://example.com", token: wrong }),
    );
});
test("host HTTP preserves large values, refuses redirects and redacts response errors", async () => {
  let redirectTargetCalls = 0;
  await http(
    (req, res) => {
      redirectTargetCalls++;
      res.end();
    },
    async (target) => {
      await http(
        (req, res) => {
          assert.equal(req.headers.authorization, "Bearer " + token);
          if (req.url.endsWith("/start")) {
            res.writeHead(302, { Location: target });
            res.end();
            return;
          }
          if (req.url.endsWith("/renew")) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end('{"secret":"DO_NOT_LEAK"}');
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"archiveBytes":"9007199254740993"}');
        },
        async (apiUrl) => {
          const api = new HostApi({ apiUrl, token });
          assert.equal(
            (await api.request("/heartbeat")).archiveBytes,
            "9007199254740993",
          );
          await assert.rejects(
            api.post(`/jobs/${randomUUID()}/start`, {}),
            (error) => error instanceof HostApiError && error.status === 302,
          );
          await assert.rejects(
            api.post(`/jobs/${randomUUID()}/renew`, {}),
            (error) =>
              error.status === 500 && !error.message.includes("DO_NOT_LEAK"),
          );
        },
      );
    },
  );
  assert.equal(redirectTargetCalls, 0);
});
test("invalid or excessive host responses and stalled requests fail with bounded diagnostics", async () => {
  for (const body of [
    "<html>private</html>",
    "{",
    '{"data":"' + "x".repeat(1048576) + '"}',
  ])
    await http(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      },
      async (apiUrl) => {
        await assert.rejects(
          new HostApi({ apiUrl, token }).request("/heartbeat"),
          HostApiError,
        );
      },
    );
  await http(
    () => {},
    async (apiUrl) => {
      await assert.rejects(
        new HostApi({ apiUrl, token }, { timeoutMs: 20 }).request("/heartbeat"),
        HostApiError,
      );
    },
  );
});
test("local host journals survive reopening and reject rebinding or corruption without overwriting", () =>
  sandbox(async (parent) => {
    const directory = path.join(parent, "state");
    await mkdir(directory);
    const runId = randomUUID(),
      first = await HostStore.open(directory, hostId, serverId);
    const requestId = await first.claimId(runId),
      reopened = await HostStore.open(directory, hostId, serverId);
    assert.equal(await reopened.claimId(runId), requestId);
    const claim = { job: { id: randomUUID() }, attemptId: randomUUID() },
      record = await first.create(claim, runId);
    record.phase = "CAPTURING";
    await first.save(record);
    assert.equal((await reopened.records())[0].phase, "CAPTURING");
    assert.equal((await reopened.create(claim, runId)).phase, "CAPTURING");
    await assert.rejects(HostStore.open(directory, randomUUID(), serverId));
    assert.throws(() => first.archive({ ...record, jobId: "../escape" }));
    const file = path.join(
      first.location(record.jobId, record.attemptId),
      "journal.json",
    );
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("CAPTURING", "CORRUPTED"));
    const broken = await readFile(file, "utf8");
    await assert.rejects(reopened.records());
    assert.equal(await readFile(file, "utf8"), broken);
  }));
test("host ownership marker cannot be a hard link", () =>
  sandbox(async (parent) => {
    const directory = path.join(parent, "state");
    await mkdir(directory);
    const external = path.join(parent, "external");
    await writeFile(external, JSON.stringify({ schema: 1, hostId, serverId }));
    await link(external, path.join(directory, ".mcmanager-host.json"));
    await assert.rejects(HostStore.open(directory, hostId, serverId));
  }));
test("native snapshot pages must be contiguous and explicitly flushed before capture", async () => {
  const payload = JSON.stringify([
      { id: "synthetic-protocol-page", params: ["x".repeat(5000)] },
    ]),
    offsets = [];
  let releases = 0;
  const control = new SnapshotControl(
    "synthetic-root",
    async (action, id, offset = 0) => {
      if (action === "release") {
        releases++;
        return { phase: "RELEASED" };
      }
      offsets.push(offset);
      const end = Math.min(payload.length, offset + 2048);
      return {
        phase: "READY",
        leaseOwned: true,
        nativeWriteCacheFlushed: true,
        snapshotStartedAt: new Date().toISOString(),
        payloadBytes: payload.length,
        payloadChunk: payload.slice(offset, end),
        nextOffset: end === payload.length ? null : end,
      };
    },
    () => randomUUID(),
  );
  await control.withSnapshot(async (snapshot) => {
    assert.equal(snapshot.messages[0].params[0].length, 5000);
  });
  assert.deepEqual(offsets, [0, 2048, 4096]);
  assert.equal(releases, 1);
  for (const variant of ["unflushed", "bad-offset"]) {
    let released = false;
    const invalid = new SnapshotControl(
      "synthetic-root",
      async (action) =>
        action === "release"
          ? ((released = true), { phase: "RELEASED" })
          : {
              phase: "READY",
              leaseOwned: true,
              nativeWriteCacheFlushed: variant !== "unflushed",
              payloadBytes: 10,
              payloadChunk: "12345",
              nextOffset: 8,
            },
      () => randomUUID(),
    );
    await assert.rejects(
      invalid.withSnapshot(() =>
        assert.fail("Invalid native snapshot cannot capture files"),
      ),
    );
    assert.ok(released);
  }
});
test(
  "Windows host mutex excludes another supervisor and releases after closing",
  { skip: process.platform !== "win32" },
  () =>
    sandbox(async (root) => {
      const lock = await acquireHostLock(root);
      try {
        await assert.rejects(acquireHostLock(root));
      } finally {
        await lock.close();
      }
      const next = await acquireHostLock(root);
      await next.close();
    }),
);
test("stopping a worker coordinator forbids a later capture even if preflight was awaiting IO", async () => {
  let requests = 0;
  const control = new SnapshotControl(
    "synthetic-root",
    async () => {
      requests++;
    },
    () => randomUUID(),
  );
  control.stopSnapshots();
  await assert.rejects(
    control.withSnapshot(() => assert.fail("Stopped worker cannot begin")),
  );
  assert.equal(requests, 0);
});
