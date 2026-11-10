import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  ConsoleSession,
  validateConsoleCommand,
  redactConsoleLine,
} from "../src/console-session.mjs";
test("console rejects multiple lines and snapshot/lifecycle bypass", () => {
  for (const input of [
    "list\nstop",
    "list\rstop",
    "\x1blist",
    "stop",
    "/Stop",
    "save hold",
    "archivebackup status",
    " list",
  ])
    assert.throws(() => validateConsoleCommand(input));
  assert.equal(validateConsoleCommand("say 大家好"), "say 大家好");
  assert.equal(
    redactConsoleLine('MCM_ARCHIVE_BACKUP {"root":"private"}'),
    null,
  );
  assert.ok(
    !redactConsoleLine("mcmhost.abc.secret /upload/" + "a".repeat(64)).includes(
      "secret",
    ),
  );
});
test("lifecycle owns exactly one process and stops backup worker before game", async () => {
  const events = [],
    config = { root: "fixture", hostId: randomUUID() };
  let exit,
    received = "";
  const session = new ConsoleSession(config, "fixture", {
    validateBinding: async () => {},
    startGame: async () => {
      events.push("start");
      return {
        child: {
          pid: 123,
          stdin: {
            writable: true,
            write(text, done) {
              received += text;
              done();
            },
          },
        },
        exit: new Promise((r) => (exit = r)),
        async stop() {
          events.push("gameStop");
          exit(0);
        },
      };
    },
    createRemote: () =>
      Object.assign(new EventEmitter(), {
        async start() {
          events.push("backupStart");
        },
        async stop() {
          events.push("backupStop");
        },
      }),
  });
  const job = (action, command = "") => ({
    id: randomUUID(),
    hostId: config.hostId,
    runId: session.runId,
    action,
    command,
  });
  await session.execute(job("START"));
  assert.equal(session.state, "RUNNING");
  session.acknowledge(session.payload());
  await session.execute(job("COMMAND", "list"));
  assert.equal(received, "list\n");
  assert.equal(session.receipt.status, "SUBMITTED");
  await assert.rejects(() => session.execute(job("COMMAND", "list")));
  session.acknowledge(session.payload());
  await session.execute(job("STOP"));
  assert.deepEqual(events, ["start", "backupStart", "backupStop", "gameStop"]);
  assert.equal(session.state, "STOPPED");
  session.acknowledge(session.payload());
  await assert.rejects(() =>
    session.execute({ ...job("START"), hostId: randomUUID() }),
  );
});
test("log buffering remains bounded while offline and acknowledgement preserves new output", () => {
  const session = new ConsoleSession({}, "fixture");
  for (let i = 0; i < 2100; i++) session.log("line " + i);
  assert.equal(session.lines.length, 2000);
  const payload = session.payload();
  session.log("new");
  session.acknowledge(payload);
  assert.equal(session.lines.at(-1).line, "new");
  assert.ok(
    session.lines.every((l) => l.sequence > payload.lines.at(-1).sequence),
  );
});
