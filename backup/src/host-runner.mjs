import { randomUUID } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOnlineBackup, inspectBackup } from "./archive.mjs";
import { HostApi, HostApiError } from "./host-api.mjs";
import { HostStore } from "./host-store.mjs";
import { RestoreRunner } from './restore-runner.mjs';
import { check, isUuid, missing, writeNew } from "./paths.mjs";

const terminal = new Set(["DONE", "FAILED", "CANCELLED", "SUPERSEDED"]);
const finished = new Set(["FAILED", "CANCELLED"]);
export class HostRunner {
  #stopping = false;
  #supervisorLost = false;
  #active;
  #fatal;
  #lastNotice;
  #wake = new AbortController();
  constructor(config, game, notify = () => {}) {
    check(
      isUuid(config.serverId) && isUuid(config.runId),
      "Invalid host server or run identity",
    );
    this.config = config;
    this.game = game;
    this.notify = notify;
    this.api = new HostApi(config);
  }
  #notice(code, record) {
    const key =
      code + ":" + (record?.jobId ?? "") + ":" + (record?.phase ?? "");
    if (this.#lastNotice !== key) {
      this.#lastNotice = key;
      this.notify({
        event: code,
        ...(record ? { jobId: record.jobId, phase: record.phase } : {}),
      });
    }
  }
  #job(job, id) {
    check(
      isUuid(id) &&
        job &&
        job.id === id &&
        job.serverId === this.config.serverId &&
        job.hostId === this.api.hostId &&
        ["MANUAL", "AUTOMATIC", "FINAL"].includes(job.kind) &&
        typeof job.note === "string" &&
        job.note.length <= 1000,
      "Host received a task for a different server",
    );
    return job;
  }
  async #save(record, phase, extra = {}) {
    Object.assign(record, extra, { phase });
    await this.store.save(record);
    this.#notice("JOB_CHECKPOINT", record);
  }
  async #heartbeat() {
    const value = await this.api.post("/heartbeat", {
      runId: this.config.runId,
      state: this.config.maintenance?'STOPPED':'RUNNING',
      version: "0.7.0",
      restoreEnabled:Boolean(this.config.restoreDirectory),
    });
    check(
      value.id === this.api.hostId &&
        value.serverId === this.config.serverId &&
        value.runnerId === this.config.runId,
      "Host registration does not match the local world",
    );
  }
  async #keepalive() {
    while (!this.#stopping) {
      try {
        await this.#heartbeat();
        await this.restore?.renew();
        const record = this.#active;
        if (
          record &&
          !terminal.has(record.phase) &&
          record.runId === this.config.runId
        ) {
          try {
            const job = await this.api.post(`/jobs/${record.jobId}/renew`, {
              runId: record.runId,
              attemptId: record.attemptId,
            });
            if (job.cancelRequested) {
              this.game.cancelSnapshot();
              this.api.cancelUploads();
            }
          } catch (error) {
            if (error.status === 401) throw error;
            this.#notice("LEASE_RECHECK_REQUIRED", record);
          }
        }
      } catch (error) {
        this.#notice("HOST_CONNECTION_INTERRUPTED");
        if (
          !(error instanceof HostApiError) ||
          error.status === 401 ||
          error.status === 409
        ) {
          this.#fatal = error;
          this.restore?.stop();
          this.game.stopSnapshots();
          this.api.cancelUploads();
          break;
        }
      }
      await delay(10000, undefined, { signal: this.#wake.signal }).catch(
        () => {},
      );
    }
  }
  async #settle(record, outcome, code) {
    try {
      await this.api.post(`/jobs/${record.jobId}/report`, {
        runId: this.config.runId,
        attemptId: record.attemptId,
        outcome,
        code,
      });
      await this.#save(record, outcome);
    } catch (error) {
      if (error.status === 401) throw error;
      await this.#save(record, "UNCERTAIN");
    }
  }
  async #cleanDeadLock(record) {
    const file = path.join(this.game.root, ".mcmanager-backup.lock");
    if ((await missing(file)) || record.workerPid === process.pid) return;
    const entry = await lstat(file);
    check(
      entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.nlink === 1 &&
        entry.size < 4096,
      "Invalid interrupted backup lock",
    );
    const bytes = await readFile(file),
      value = JSON.parse(bytes);
    if (
      value.pid !== record.workerPid ||
      value.mode !== "BDS_SAVE_QUERY" ||
      !isUuid(value.operationId)
    )
      return;
    try {
      process.kill(value.pid, 0);
      return;
    } catch (error) {
      if (error.code !== "ESRCH") return;
    }
    const native = await this.game.request("status", randomUUID());
    if (native.phase !== "IDLE" || native.nativeQuerySuccess !== 0) return;
    const saved = path.join(
      this.store.location(record.jobId, record.attemptId),
      "interrupted-lock-" + value.operationId + ".json",
    );
    if (await missing(saved)) await writeNew(saved, bytes);
    const current = await lstat(file);
    check(
      current.ino === entry.ino &&
        current.dev === entry.dev &&
        Buffer.compare(await readFile(file), bytes) === 0,
      "Interrupted lock changed during recovery",
    );
    await unlink(file);
    this.#notice("INTERRUPTED_LOCK_PRESERVED", record);
  }
  async #process(record) {
    let job = this.#job(
      await this.api.request(`/jobs/${record.jobId}`),
      record.jobId,
    );
    if (job.status === "SUCCEEDED") {
      check(
        record.artifact &&
          job.sourceBackupId === record.artifact.sourceBackupId &&
          job.archiveSha256 === record.artifact.sha256 &&
          job.archiveBytes === record.artifact.bytes,
        "Completed remote task does not match the local archive",
      );
      await this.#save(record, "DONE", { backupId: job.backupId });
      return;
    }
    if (finished.has(job.status)) {
      await this.#cleanDeadLock(record);
      await this.#save(record, job.status);
      return;
    }
    if (this.#stopping || this.#fatal) return;
    if (job.status === "QUEUED") {
      check(
        ["CLAIMED", "START_REQUEST", "SUPERSEDED"].includes(record.phase),
        "Started local work unexpectedly became queued",
      );
      await this.#save(record, "SUPERSEDED");
      return;
    }
    if (job.cancelRequested) {
      await this.#settle(record, "CANCELLED", "OPERATOR_CANCELLED");
      return;
    }
    const archive = this.store.archive(record);
    if (["CLAIMED", "START_REQUEST"].includes(record.phase)) {
      if (job.status === "UNCERTAIN") {
        await this.#save(record, "UNCERTAIN");
        this.#notice("LOCAL_RECONCILIATION_REQUIRED", record);
        return;
      }
      check(
        record.runId === this.config.runId,
        "An old claim cannot be executed by a new supervisor",
      );
      await this.#save(record, "START_REQUEST");
      if (this.#stopping || this.#fatal) return;
      job = this.#job(
        await this.api.post(`/jobs/${record.jobId}/start`, {
          runId: record.runId,
          attemptId: record.attemptId,
        }),
        record.jobId,
      );
      check(job.status === "RUNNING", "The task did not confirm execution");
      if (this.#stopping || this.#fatal) return;
      await this.#save(record, "CAPTURING", { workerPid: process.pid });
      if (this.#stopping || this.#fatal) {
        await this.#settle(record, "FAILED", "EXECUTION_INTERRUPTED");
        return;
      }
      try {
        await createOnlineBackup({
          root: this.game.root,
          game: this.game,
          output: archive,
          serverId: this.config.serverId,
          note: job.note,
          scope: this.config.backupScope ?? 'WORLD',
        });
      } catch (error) {
        if (await missing(archive)) {
          const state = await this.game
            .request("status", randomUUID())
            .catch(() => null);
          await this.#settle(
            record,
            state?.nativeQuerySuccess === 0 ? "FAILED" : "UNCERTAIN",
            "CAPTURE_FAILED",
          );
          return;
        }
      }
    }
    if (await missing(archive)) {
      await this.#cleanDeadLock(record);
      if (record.phase !== "UNCERTAIN")
        await this.#settle(record, "UNCERTAIN", "EXECUTION_INTERRUPTED");
      this.#notice("LOCAL_RECONCILIATION_REQUIRED", record);
      return;
    }
    let proof;
    try {
      proof = await inspectBackup(archive);
      check(
        proof.manifest.serverId === this.config.serverId &&
          proof.manifest.snapshotMode === "BDS_SAVE_QUERY",
        "Local archive belongs to a different task",
      );
      const artifact = {
        sourceBackupId: proof.manifest.backupId,
        sha256: proof.sha256,
        bytes: proof.archiveBytes,
      };
      if (record.artifact)
        check(
          Object.keys(artifact).every(
            (key) => artifact[key] === record.artifact[key],
          ),
          "Original archive changed",
        );
      else await this.#save(record, "ARCHIVED", { artifact });
    } catch (error) {
      await this.#settle(record, "UNCERTAIN", "LOCAL_ARCHIVE_INVALID");
      return;
    }
    if (this.#stopping || this.#fatal) return;
    job = this.#job(
      await this.api.request(`/jobs/${record.jobId}`),
      record.jobId,
    );
    if (job.status === "SUCCEEDED") {
      check(
        job.sourceBackupId === record.artifact.sourceBackupId &&
          job.archiveSha256 === record.artifact.sha256,
        "Completed task identity changed",
      );
      await this.#save(record, "DONE", { backupId: job.backupId });
      return;
    }
    if (finished.has(job.status)) {
      await this.#save(record, job.status);
      return;
    }
    if (job.cancelRequested) {
      await this.#settle(record, "CANCELLED", "OPERATOR_CANCELLED");
      return;
    }
    const recovery =
      job.status === "UNCERTAIN" || record.runId !== this.config.runId;
    const upload = await this.api.post(
      `/jobs/${record.jobId}/${recovery ? "recover" : "artifact"}`,
      {
        ...record.artifact,
        runId: this.config.runId,
        attemptId: record.attemptId,
      },
    );
    check(
      upload.serverId === this.config.serverId && isUuid(upload.id),
      "Invalid upload reservation",
    );
    await this.#save(record, "UPLOADING", {
      runId: this.config.runId,
      backupId: upload.id,
    });
    if (this.#stopping || this.#fatal) return;
    await this.api.upload(
      record.jobId,
      record.runId,
      record.attemptId,
      archive,
      proof.archiveBytes,
    );
    const completed = this.#job(
      await this.api.request(`/jobs/${record.jobId}`),
      record.jobId,
    );
    check(
      completed.status === "SUCCEEDED" &&
        completed.backupId === record.backupId &&
        completed.archiveSha256 === record.artifact.sha256,
      "Central backup completion is not confirmed",
    );
    await this.#save(record, "DONE");
  }
  async run() {
    if(this.config.restoreDirectory)this.restore=await new RestoreRunner(this.config,this.api,this.notify).open();
    this.store = await HostStore.open(
      this.config.stateDirectory,
      this.api.hostId,
      this.config.serverId,
    );
    // A new process must authenticate and bind before interpreting old claims.
    while (!this.#stopping) {
      try {
        await this.#heartbeat();
        break;
      } catch (error) {
        if (!(error instanceof HostApiError) || error.status === 401)
          throw error;
        this.#notice("HOST_WAITING_FOR_CONNECTION");
        await delay(2000, undefined, { signal: this.#wake.signal }).catch(
          () => {},
        );
      }
    }
    const keepalive = this.#keepalive();
    try {
      while (!this.#stopping && !this.#fatal) {
        try {
          if(await this.restore?.step()||this.config.maintenance) {
            await delay(2000,undefined,{signal:this.#wake.signal}).catch(()=>{});continue;
          }
          const records = await this.store.records();
          for (const old of records)
            if (terminal.has(old.phase)) await this.#cleanDeadLock(old);
          let record = records.find((value) => !terminal.has(value.phase));
          if (!record) {
            if (
              !(await missing(
                path.join(this.game.root, ".mcmanager-backup.lock"),
              ))
            ) {
              this.#notice("LOCAL_SOURCE_LOCK_REQUIRES_REVIEW");
              await delay(2000, undefined, { signal: this.#wake.signal }).catch(
                () => {},
              );
              continue;
            }
            const requestId = await this.store.claimId(this.config.runId),
              claim = await this.api.post("/jobs/claim", {
                runId: this.config.runId,
                requestId,
              });
            if (claim) {
              this.#job(claim.job, claim.job?.id);
              check(isUuid(claim.attemptId), "Invalid claim identity");
              if (claim.active)
                record = await this.store.create(claim, this.config.runId);
              await this.store.advanceClaim(this.config.runId);
            }
          }
          if (this.#stopping || this.#fatal) break;
          if (record) {
            this.#active = record;
            await this.#process(record);
            this.#active = undefined;
          }
        } catch (error) {
          this.#active = undefined;
          if (!(error instanceof HostApiError)) throw error;
          if ([400, 401, 403, 404].includes(error.status)) throw error;
          this.#notice("REMOTE_TASK_RECHECK_REQUIRED");
        }
        await delay(2000, undefined, { signal: this.#wake.signal }).catch(
          () => {},
        );
      }
      if (this.#fatal) throw this.#fatal;
    } finally {
      this.#stopping = true;
      this.#wake.abort();
      await keepalive;
      try {
        if (!this.#supervisorLost) {
          await this.api.post("/heartbeat", { runId: this.config.runId, state: "STOPPED", version: "0.6.0",restoreEnabled:Boolean(this.config.restoreDirectory) });
        }
      } catch { /* The last confirmed heartbeat will expire if shutdown is offline. */ }
    }
  }
  stop({ supervisorLost = false } = {}) {
    this.#supervisorLost ||= supervisorLost;
    this.#stopping = true;
    this.#wake.abort();
    this.restore?.stop();
    this.game.stopSnapshots();
    this.api.cancelUploads();
  }
}
