// Private child entry point. The parent owns the live game and exposes only the
// fixed snapshot protocol over IPC; HTTP/task failures never own game lifetime.
import { randomUUID } from "node:crypto";
import { HostRunner } from "./host-runner.mjs";
import { SnapshotControl } from "./snapshot-control.mjs";
import { isUuid } from "./paths.mjs";

if (!process.send)
  throw new Error("Start the backup worker through its local supervisor");
const pending = new Map();
let runner,
  initialized = false;
function send(value) {
  if (process.connected) process.send(value, () => {});
}
process.on("message", (message) => {
  if (message?.type === "native-result") {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error)
      item.reject(new Error("Local native backup control failed"));
    else item.resolve(message.result);
    return;
  }
  if (message?.type === "stop") {
    runner?.stop();
    return;
  }
  if (message?.type !== "init" || initialized) return;
  initialized = true;
  if (!isUuid(message.bootId) || !isUuid(message.config?.runId)) {
    process.exitCode = 2;
    process.disconnect();
    return;
  }
  const request = (action, operationId, offset = 0) =>
    new Promise((resolve, reject) => {
      if (!process.connected) {
        reject(new Error("Local supervisor disconnected"));
        return;
      }
      const id = randomUUID(),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Local game control did not respond"));
        }, 6000);
      pending.set(id, { resolve, reject, timer });
      send({ type: "native-request", id, action, operationId, offset });
    });
  const game = new SnapshotControl(
    message.config.root,
    request,
    () => message.bootId,
  );
  runner = new HostRunner(message.config, game, (value) =>
    send({ type: "event", ...value }),
  );
  runner
    .run()
    .catch((error) => {
      process.exitCode = error.status === 401 ? 3 : 2;
      send({
        type: "event",
        event:
          error.status === 401
            ? "HOST_ACCESS_REJECTED"
            : "HOST_LOCAL_STATE_REQUIRES_REVIEW",
      });
    })
    .finally(() => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Backup worker stopped"));
      }
      pending.clear();
      if (process.connected) process.disconnect();
    });
});
process.on("disconnect", () => {
  runner?.stop({ supervisorLost: true });
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(new Error("Local supervisor disconnected"));
  }
  pending.clear();
});
