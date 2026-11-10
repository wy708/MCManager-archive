import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { ManagedGame } from "./managed-game.mjs";
import { RemoteSupervisor } from "./remote-supervisor.mjs";
import { check, isUuid } from "./paths.mjs";
import { readHostConfig } from "./host-config.mjs";

export function validateConsoleCommand(text) {
  check(
    typeof text === "string" &&
      text.length > 0 &&
      text.length <= 1000 &&
      text === text.trim() &&
      !/[\x00-\x1f\x7f-\x9f]/.test(text),
    "Invalid single-line game command",
  );
  check(
    !/(?:^\/?|\brun\s+)(?:minecraft:)?(?:stop|save|archivebackup)(?:\s|$)/i.test(
      text,
    ),
    "Use lifecycle controls; backup commands are reserved",
  );
  return text;
}
export function redactConsoleLine(line) {
  if (line.includes("MCM_ARCHIVE_BACKUP ")) return null;
  return line
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/mcm(?:agent|host|collector)\.[A-Za-z0-9_.-]+/g, "[凭据已隐藏]")
    .replace(/\/upload\/[a-f\d]{64}/gi, "/upload/[已隐藏]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .slice(0, 2000);
}
export class ConsoleSession {
  runId = randomUUID();
  state = "STOPPED";
  lines = [];
  sequence = 0;
  receipt = null;
  active = null;
  game = null;
  remote = null;
  constructor(
    config,
    file,
    {
      startGame = (root, options) => ManagedGame.start(root, options),
      createRemote = (game) => new RemoteSupervisor(game, file, config),
      validateBinding = async () => {
        const actual = await readHostConfig(file);
        check(
          actual.root === config.root &&
            actual.serverId === config.serverId &&
            actual.hostId === config.hostId &&
            actual.token === config.token,
          "Host binding changed; restart the console host",
        );
      },
    } = {},
  ) {
    this.config = config;
    this.startGame = startGame;
    this.createRemote = createRemote;
    this.validateBinding = validateBinding;
  }
  log(text) {
    const line = redactConsoleLine(text);
    if (line === null) return;
    this.onLine?.(line);
    this.lines.push({
      sequence: ++this.sequence,
      observedAt: new Date().toISOString(),
      line,
    });
    if (this.lines.length > 2000)
      this.lines.splice(0, this.lines.length - 2000);
  }
  async start() {
    check(!this.game, "Game already owned");
    this.state = "STARTING";
    this.log("正在启动游戏服务器…");
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const output = (chunk) => {
      buffer += decoder.write(chunk);
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        this.log(buffer.slice(0, i).replace(/\r$/, ""));
        buffer = buffer.slice(i + 1);
      }
      if (buffer.length > 8000) {
        this.log(buffer);
        buffer = "";
      }
    };
    let game;
    try {
      await this.validateBinding();
      game = await this.startGame(this.config.root, {
        output,
        guardSupervisor: true,
      });
      this.game = game;
      game.exit.then((code) => {
        if (this.game === game) {
          this.game = null;
          this.state = code === 0 ? "STOPPED" : "ERROR";
          this.log("游戏进程已退出，退出码：" + code);
          const remote = this.remote;
          this.remote = null;
          void remote?.stop().catch(() => this.log("备份执行端退出未确认"));
        }
      });
      check(this.game === game, "Game exited during startup");
      this.remote = this.createRemote(game);
      this.remote.on("status", (event) => {
        if (
          ["HOST_WORKER_EXITED", "HOST_RESTART_REQUIRES_REVIEW"].includes(
            event.event,
          )
        )
          this.log("备份执行端：" + event.event);
      });
      await this.remote.start();
      check(this.game === game, "Game exited during startup");
      this.state = "RUNNING";
    } catch (error) {
      this.state = "ERROR";
      await this.remote?.stop().catch(() => {});
      this.remote = null;
      if (game) {
        await game.stop().catch(() => {});
        if (this.game === game && game.child?.exitCode != null)
          this.game = null;
      }
      throw error;
    }
  }
  async stop() {
    const game = this.game;
    if (!game) {
      this.state = "STOPPED";
      return;
    }
    this.state = "STOPPING";
    this.log("正在结束备份任务并正常保存世界，请稍候…");
    await this.remote?.stop();
    this.remote = null;
    await game.stop();
    if (this.game === game) this.game = null;
    this.state = "STOPPED";
  }
  async execute(job) {
    check(
      !this.active && !this.receipt,
      "An operation is already awaiting completion",
    );
    check(
      job &&
        isUuid(job.id) &&
        job.hostId === this.config.hostId &&
        job.runId === this.runId &&
        ["COMMAND", "START", "STOP", "RESTART"].includes(job.action),
      "Command belongs to another host or session",
    );
    this.active = job.id;
    try {
      if (job.action === "COMMAND") {
        const command = validateConsoleCommand(job.command);
        check(
          this.state === "RUNNING" && this.game?.child?.stdin?.writable,
          "Game is not running",
        );
        this.log("> " + command);
        await new Promise((resolve, reject) =>
          this.game.child.stdin.write(command + "\n", (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        this.receipt = {
          id: job.id,
          status: "SUBMITTED",
          message: "已写入游戏控制台，执行结果请查看日志",
        };
      } else {
        check(job.command === "", "Lifecycle action cannot carry command text");
        if (job.action === "START") {
          check(
            ["STOPPED", "ERROR"].includes(this.state),
            "Game is not stopped",
          );
          await this.start();
        } else {
          check(this.state === "RUNNING", "Game is not running");
          await this.stop();
          if (job.action === "RESTART") await this.start();
        }
        this.receipt = {
          id: job.id,
          status: "SUCCEEDED",
          message: job.action === "STOP" ? "游戏已正常停止" : "游戏已启动",
        };
      }
    } catch {
      if (["STARTING", "STOPPING"].includes(this.state)) this.state = "ERROR";
      this.log("控制台操作未能确认完成，请检查运行状态和本机日志。");
      this.receipt = {
        id: job.id,
        status: "UNCERTAIN",
        message: "执行未确认，请检查日志；不会自动重试",
      };
    } finally {
      this.active = null;
    }
  }
  payload() {
    return {
      runId: this.runId,
      state: this.state,
      pid: this.game?.child?.pid ?? null,
      lines: this.lines.slice(0, 100),
      receipt: this.receipt,
    };
  }
  acknowledge(payload) {
    if (payload.lines.length)
      this.lines = this.lines.filter(
        (l) => l.sequence > payload.lines.at(-1).sequence,
      );
    if (payload.receipt === this.receipt) this.receipt = null;
  }
}
