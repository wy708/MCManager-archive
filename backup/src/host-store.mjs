import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
  canonicalDirectory,
  canonicalJson,
  check,
  contains,
  isUuid,
  missing,
  writeNew,
} from "./paths.mjs";

const checksum = (value) => createHash("sha256").update(value).digest("hex");
const phases = new Set([
  "CLAIMED",
  "START_REQUEST",
  "CAPTURING",
  "ARCHIVED",
  "UPLOADING",
  "DONE",
  "FAILED",
  "UNCERTAIN",
  "SUPERSEDED",
  "CANCELLED",
]);
const restorePhases = new Set(['CLAIMED','START_REQUEST','DOWNLOADING','DOWNLOADED','RESTORING','RESTORED','DONE','FAILED','UNCERTAIN','SUPERSEDED','CANCELLED']);
export class HostStore {
  constructor(root, hostId, serverId,kind='BACKUP') {
    this.root = root;
    this.hostId = hostId;
    this.serverId = serverId;
    this.kind=kind; this.phases=kind==='RESTORE'?restorePhases:phases;
  }
  static async open(directory, hostId, serverId,kind='BACKUP') {
    check(['BACKUP','RESTORE'].includes(kind),'Invalid host store kind');
    check(isUuid(hostId) && isUuid(serverId), "Invalid local host binding");
    const root = await canonicalDirectory(directory),
      marker = path.join(root, ".mcmanager-host.json");
    if (await missing(marker))
      await writeNew(marker, canonicalJson({ schema: 1, hostId, serverId,...(kind==='RESTORE'?{kind}:{}) }));
    const entry = await lstat(marker);
    check(
      entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.nlink === 1 &&
        entry.size <= 1024,
      "Invalid local host ownership marker",
    );
    const current = JSON.parse(await readFile(marker, "utf8"));
    check(
      current.schema === 1 &&
        current.hostId === hostId &&
        current.serverId === serverId,
      "Local host data belongs to another identity",
    );
    check((current.kind??'BACKUP')===kind,'Local data belongs to another task kind');
    return new HostStore(root, hostId, serverId,kind);
  }
  async #plain(file) {
    const entry = await lstat(file);
    check(
      entry.isFile() &&
        !entry.isSymbolicLink() &&
        entry.nlink === 1 &&
        entry.size <= 1048576,
      "Invalid local host journal file",
    );
    const wrapper = JSON.parse(await readFile(file, "utf8"));
    check(
      wrapper.schema === 1 &&
        typeof wrapper.body === "string" &&
        checksum(wrapper.body) === wrapper.sha256,
      "Local host journal checksum failed",
    );
    const body = JSON.parse(wrapper.body);
    check(
      body.hostId === this.hostId && body.serverId === this.serverId,
      "Local job belongs to another host",
    );
    return body;
  }
  async #atomic(file, data) {
    check(
      contains(this.root, await canonicalDirectory(path.dirname(file))),
      "Local journal escaped its data directory",
    );
    if (!(await missing(file))) {
      const previous = await lstat(file);
      check(
        previous.isFile() && !previous.isSymbolicLink() && previous.nlink === 1,
        "Local journal was replaced",
      );
    }
    const body = canonicalJson({
      ...data,
      schema: 1,
      hostId: this.hostId,
      serverId: this.serverId,
    });
    const temporary = file + "." + randomUUID() + ".writing";
    await writeNew(
      temporary,
      canonicalJson({ schema: 1, body, sha256: checksum(body) }),
    );
    await rename(temporary, file);
  }
  async claimId(runId) {
    const file = path.join(this.root, "claim.json");
    if (!(await missing(file))) {
      const record = await this.#plain(file);
      check(
        isUuid(record.requestId) && isUuid(record.runId),
        "Invalid claim journal",
      );
      if (record.runId === runId) return record.requestId;
    }
    const requestId = randomUUID();
    await this.#atomic(file, { runId, requestId });
    return requestId;
  }
  async advanceClaim(runId) {
    const requestId = randomUUID();
    await this.#atomic(path.join(this.root, "claim.json"), {
      runId,
      requestId,
    });
  }
  location(jobId, attemptId) {
    check(isUuid(jobId) && isUuid(attemptId), "Invalid local job identity");
    return path.join(this.root, jobId + "_" + attemptId);
  }
  async create(claim, runId) {
    const directory = this.location(claim.job.id, claim.attemptId);
    if (!(await missing(directory))) {
      check(
        (await readFile(path.join(directory, ".mcmanager-job"), "utf8")) ===
          claim.job.id + "_" + claim.attemptId,
        "Local job ownership marker failed",
      );
      return this.#plain(path.join(directory, "journal.json"));
    }
    const temporary = path.join(this.root, ".job-" + randomUUID() + ".writing");
    await mkdir(temporary);
    await writeNew(
      path.join(temporary, ".mcmanager-job"),
      claim.job.id + "_" + claim.attemptId,
    );
    const record = {
      jobId: claim.job.id,
      attemptId: claim.attemptId,
      runId,
      workerPid: process.pid,
      phase: "CLAIMED",
    };
    await this.#atomic(path.join(temporary, "journal.json"), record);
    await rename(temporary, directory);
    return record;
  }
  async save(record) {
    check(
      this.phases.has(record.phase) &&
        isUuid(record.runId) &&
        Number.isSafeInteger(record.workerPid) &&
        record.workerPid > 0,
      "Invalid local job checkpoint",
    );
    const directory = this.location(record.jobId, record.attemptId);
    check(
      (await canonicalDirectory(directory)) === directory &&
        (await readFile(path.join(directory, ".mcmanager-job"), "utf8")) ===
          record.jobId + "_" + record.attemptId,
      "Local job directory is not owned",
    );
    await this.#atomic(path.join(directory, "journal.json"), record);
  }
  archive(record) {
    return path.join(
      this.location(record.jobId, record.attemptId),
      "archive.tar.gz",
    );
  }
  async records() {
    const records = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) {
        check(
          entry.name === "claim.json" || entry.name.endsWith(".writing"),
          "Unexpected host data entry",
        );
        continue;
      }
      const parts = entry.name.split("_");
      check(
        parts.length === 2 && parts.every(isUuid),
        "Unexpected job directory",
      );
      const directory = this.location(...parts);
      await canonicalDirectory(directory);
      check(
        (await readFile(path.join(directory, ".mcmanager-job"), "utf8")) ===
          entry.name,
        "Local job ownership marker failed",
      );
      const file = path.join(directory, "journal.json");
      // A crash between mkdir/marker and the first journal cannot have executed
      // start: keep this directory and recover the persisted claim request.
      if (await missing(file)) continue;
      const record = await this.#plain(file);
      check(
        record.jobId === parts[0] &&
          record.attemptId === parts[1] &&
          this.phases.has(record.phase) &&
          isUuid(record.runId),
        "Invalid local job identity",
      );
      records.push(record);
    }
    return records;
  }
}
