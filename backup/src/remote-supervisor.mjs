import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { check, isUuid } from "./paths.mjs";
import { readHostConfig } from "./host-config.mjs";

export class RemoteSupervisor extends EventEmitter {
  #stopping = false;
  #timer;
  #worker;
  #exit;
  #runId = randomUUID();
  #config;
  constructor(game, file, config) {
    super();
    this.game = game;
    this.file = file;
    this.#config = config;
  }
  get worker() {
    return this.#worker;
  }
  async start() {
    check(
      !this.#worker && !this.#stopping,
      "Backup worker is already running or stopping",
    );
    const config = await readHostConfig(this.file,process.env,{maintenance:Boolean(this.#config.maintenance)});
    check(
      config.root === this.game.root &&
        config.serverId === this.#config.serverId &&
        config.hostId === this.#config.hostId,
      "Host configuration changed its game binding",
    );
    const environment = {};
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "PATH",
      "Path",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
      "NODE_EXTRA_CA_CERTS",
    ])
      if (process.env[key]) environment[key] = process.env[key];
    const child = fork(
      fileURLToPath(new URL("./host-worker.mjs", import.meta.url)),
      [],
      {
        windowsHide: true,
        execArgv: [],
        env: environment,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    this.#worker = child;
    let outstanding = 0;
    child.stderr.on("data", () =>
      this.emit("status", { event: "HOST_WORKER_DIAGNOSTIC" }),
    );
    child.on("error", () =>
      this.emit("status", { event: "HOST_WORKER_START_FAILED" }),
    );
    this.#exit = new Promise((resolve) => {
      let ended = false;
      const finish = (code) => {
        if (ended) return;
        ended = true;
        if (this.#worker === child) this.#worker = undefined;
        this.emit("status", {
          event: "HOST_WORKER_EXITED",
          pid: child.pid,
          code,
        });
        resolve(code);
        if (!this.#stopping && ![2, 3].includes(code))
          this.#timer = setTimeout(
            () =>
              this.start().catch(() =>
                this.emit("status", { event: "HOST_RESTART_REQUIRES_REVIEW" }),
              ),
            2000,
          );
      };
      child.once("exit", finish);
      child.once("error", () => finish(2));
    });
    child.on("message", async (message) => {
      if (message?.type === "event") {
        const { type, ...event } = message;
        this.emit("status", event);
        return;
      }
      if (
        message?.type !== "native-request" ||
        !isUuid(message.id) ||
        outstanding >= 8
      )
        return;
      outstanding++;
      try {
        const result = await this.game.request(
          message.action,
          message.operationId,
          message.offset,
        );
        if (child.connected)
          child.send(
            { type: "native-result", id: message.id, result },
            () => {},
          );
      } catch {
        if (child.connected)
          child.send(
            { type: "native-result", id: message.id, error: true },
            () => {},
          );
      } finally {
        outstanding--;
      }
    });
    child.send({
      type: "init",
      config: { ...config, runId: this.#runId },
      bootId: this.game.bootId,
    });
    this.emit("status", { event: "HOST_WORKER_STARTED", pid: child.pid });
  }
  async stop() {
    this.#stopping = true;
    clearTimeout(this.#timer);
    const child = this.#worker;
    if (child?.connected) child.send({ type: "stop" }, () => {});
    if (child) await this.#exit;
  }
  async restart() {
    await this.stop();
    this.#stopping = false;
    await this.start();
  }
}
