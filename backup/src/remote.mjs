#!/usr/bin/env node
import { createInterface } from "node:readline";
import { ManagedGame } from "./managed-game.mjs";
import { readHostConfig, acquireHostLock } from "./host-config.mjs";
import { RemoteSupervisor } from "./remote-supervisor.mjs";
import { check } from "./paths.mjs";
import { randomUUID } from 'node:crypto';
import { assertServerStopped } from './processes.mjs';

let game,
  remote,
  lock,
  closing = false,
  closePromise;
function close() {
  return closePromise??=(async()=>{closing=true;await remote?.stop();await game?.stop();await lock?.close();})();
}
try {
  const args = process.argv.slice(2);
  check(
    (args.length === 2 || args.length===3&&args[2]==='--maintenance') && args[0] === "--config",
    "Use --config with a local host JSON file",
  );
  const config = await readHostConfig(args[1],process.env,{maintenance:args.includes('--maintenance')});
  lock = await acquireHostLock(config.root);
  if(config.maintenance)await assertServerStopped(config.root);
  game = config.maintenance?{root:config.root,bootId:randomUUID(),async request(){throw new Error('Game is stopped for maintenance');},async stop(){}}:await ManagedGame.start(config.root, {
    output: (chunk) => process.stderr.write(chunk),
    guardSupervisor: true,
  });
  if(game.child) {
    console.log(JSON.stringify({ event: "GAME_STARTED", pid: game.child.pid, supervisorGuard: game.supervisorGuard }));
    if (!game.supervisorGuard) console.error("Collector upgrade required for automatic game shutdown after supervisor loss");
  }
  else console.log(JSON.stringify({event:'HOST_MAINTENANCE_STARTED'}));
  remote = new RemoteSupervisor(game, args[1], config);
  remote.on("status", (event) => console.log(JSON.stringify(event)));
  await remote.start();
  const input = createInterface({ input: process.stdin, terminal: false });
  const stop = () => {
    input.close();
    close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  input.on("line", (line) => {
    if (closing) return;
    if (line.trim() === "stop") {
      stop();
      return;
    }
    if (line.trim() === "host restart") {
      remote
        .restart()
        .catch(() =>
          console.error("Backup worker restart failed; game remains available"),
        );
      return;
    }
    if(game.child)game.child.stdin.write(line + "\n");
  });
  input.on("close", () => {
    if (!closing)
      close().catch(() => {
        process.exitCode = 1;
      });
  });
  const code = game.exit?await game.exit:await new Promise(resolve=>input.once('close',()=>resolve(0)));
  if (code !== 0) process.exitCode = 1;
  input.close();
  await close();
  process.stdin.destroy();
} catch {
  console.error(
    "Remote backup host could not start or stop; check local paths, host credential and diagnostics",
  );
  process.exitCode = 1;
  await close().catch(() => {});
}
