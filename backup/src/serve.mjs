#!/usr/bin/env node
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { ManagedGame } from './managed-game.mjs';
import { createOnlineBackup } from './archive.mjs';
import { canonicalDirectory, check, contains, isUuid } from './paths.mjs';

// Local game-console supervisor. It does not listen on a network port and is
// deliberately separate from the Agent/MCP permissions and reply queue.
const options = {};
let game, job, closing = false;
async function close() {
  if (closing) return;
  closing = true; game?.cancelSnapshot(); await job?.catch(() => {}); await game?.stop();
}
try {
  const args = process.argv.slice(2);
  for (let at = 0; at < args.length; at += 2) {
    check(['--root', '--server-id', '--output-directory'].includes(args[at]) && args[at + 1] && !options[args[at]], 'Use --root, --server-id and --output-directory once each');
    options[args[at]] = args[at + 1];
  }
  const root = await canonicalDirectory(options['--root']), destination = await canonicalDirectory(options['--output-directory']), serverId = options['--server-id'];
  check(isUuid(serverId) && !contains(root, destination), 'Choose a valid archive UUID and an output directory outside the game server');
  console.error('Starting the managed game server; enter backup [note] to capture a live backup, or stop to exit. Other input is the local game console.');
  game = await ManagedGame.start(root, { output: chunk => process.stderr.write(chunk) });
  const input = createInterface({ input: process.stdin, terminal: false });
  const stop = () => { input.close(); close().catch(() => { process.exitCode = 1; }); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  input.on('line', line => {
    if (closing) return;
    if (line.trim() === 'stop') { stop(); return; }
    if (line === 'backup' || line.startsWith('backup ')) {
      if (job) { console.error('A backup is already running.'); return; }
      const output = path.join(destination, `mcmanager-${serverId}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.tar.gz`);
      job = createOnlineBackup({ root, game, serverId, output, note: line.slice(6).trim() })
        .then(result => console.log(JSON.stringify(result)))
        .catch(() => { console.error('Online backup did not complete; inspect the retained staging diagnostics and native snapshot state.'); })
        .finally(() => { job = undefined; });
    } else game.child.stdin.write(line + '\n');
  });
  input.on('close', () => { if (!closing) close().catch(() => { process.exitCode = 1; }); });
  const exitCode = await game.exit;
  if (exitCode !== 0) process.exitCode = 1;
  input.close();
  // A Windows pipe can stay referenced after readline closes while its parent
  // keeps stdin open. There is no more input to consume after the game exits.
  process.stdin.destroy();
} catch {
  console.error('Managed backup host could not start or stop safely; check paths, archive identity and game logs.');
  process.exitCode = 1; await close().catch(() => {});
}
