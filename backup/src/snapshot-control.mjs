import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { check } from "./paths.mjs";

// Shared lease coordinator for the local console and the private worker IPC.
export class SnapshotControl {
  #snapshot = false;
  #activeAbort;
  #stopped = false;
  constructor(root, request, bootId) {
    this.root = root;
    this.request = request;
    this.bootId = bootId;
  }
  async withSnapshot(action) {
    check(!this.#stopped, "Native snapshot coordinator has stopped");
    check(!this.#snapshot, "Another snapshot is already running");
    this.#snapshot = true;
    const operationId = randomUUID(),
      controller = new AbortController();
    let renewing = false,
      heartbeat,
      mayOwn = true;
    this.#activeAbort = controller;
    const assertActive = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    try {
      let response = await this.request("begin", operationId);
      mayOwn = response.leaseOwned !== false;
      const end = Date.now() + 120000;
      while (response.phase === "PREPARING" && Date.now() < end) {
        assertActive();
        await delay(100);
        response = await this.request("query", operationId);
      }
      check(
        response.phase === "READY",
        "The native world snapshot could not be prepared: " + response.phase,
      );
      check(
        response.nativeWriteCacheFlushed === true,
        "The native snapshot did not confirm its storage write barrier",
      );
      const snapshotStartedAt = response.snapshotStartedAt,
        collectorCheckpoint = response.collectorCheckpoint,
        chunks = [],
        expected = response.payloadBytes;
      let offset = 0;
      check(
        Number.isSafeInteger(expected) && expected > 0 && expected <= 16777216,
        "Invalid native snapshot metadata length",
      );
      while (true) {
        check(
          response.phase === "READY" &&
            response.payloadBytes === expected &&
            typeof response.payloadChunk === "string",
          "Native snapshot metadata changed",
        );
        const next = offset + Buffer.byteLength(response.payloadChunk);
        check(
          next > offset &&
            next <= expected &&
            (response.nextOffset === null
              ? next === expected
              : response.nextOffset === next),
          "Invalid native snapshot metadata offset",
        );
        chunks.push(response.payloadChunk);
        if (response.nextOffset === null) break;
        offset = next;
        response = await this.request("query", operationId, offset);
      }
      const payload = chunks.join("");
      check(
        Buffer.byteLength(payload) === expected && expected <= 16777216,
        "Incomplete native file list",
      );
      renewing = true;
      heartbeat = (async () => {
        while (renewing) {
          await delay(1000);
          if (!renewing) break;
          try {
            const current = await this.request("query", operationId);
            check(
              current.phase === "READY",
              "Native snapshot lease ended: " + current.phase,
            );
          } catch (error) {
            controller.abort(error);
            break;
          }
        }
      })();
      const result = await action({
        operationId,
        bootId: this.bootId(),
        snapshotStartedAt,
        nativeWriteCacheFlushed: true,
        preparedAt: new Date().toISOString(),
        messages: JSON.parse(payload),
        collectorCheckpoint,
        signal: controller.signal,
        assertActive,
      });
      assertActive();
      return result;
    } finally {
      renewing = false;
      await heartbeat;
      let released;
      try {
        for (let attempt = 0; mayOwn && attempt < 25; attempt++) {
          released = await this.request("release", operationId);
          if (released.phase !== "RELEASING") break;
          await delay(200);
        }
        if (mayOwn)
          check(
            released?.phase === "RELEASED",
            "The world snapshot release was not confirmed: " + released?.phase,
          );
      } finally {
        this.#snapshot = false;
        this.#activeAbort = undefined;
      }
    }
  }
  cancelSnapshot(
    reason = new Error("Online snapshot cancelled by the local operator"),
  ) {
    this.#activeAbort?.abort(reason);
  }
  stopSnapshots() {
    this.#stopped = true;
    this.cancelSnapshot();
  }
}
