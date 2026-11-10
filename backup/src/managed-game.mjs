import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalDirectory, check, isUuid } from './paths.mjs';
import { assertServerStopped } from './processes.mjs';
import { SnapshotControl } from './snapshot-control.mjs';

const PREFIX = 'MCM_ARCHIVE_BACKUP ';
const SUPERVISOR_PID = 'MCARCHIVE_MANAGED_PARENT_PID';
async function supportsSupervisorGuard(root) {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'plugins/archive-collector/manifest.json'), 'utf8'));
    const version = /^(\d+)\.(\d+)\.\d+$/.exec(manifest.version);
    return Boolean(version && (Number(version[1]) > 0 || Number(version[2]) >= 24));
  } catch {
    return false;
  }
}

export class ManagedGame extends EventEmitter {
  #pending = new Map();
  #buffer = '';
  #boot;
  #closed = false;
  #snapshots;
  static async start(root, { output = () => {}, guardSupervisor = false } = {}) {
    const actual = await canonicalDirectory(root);
    await assertServerStopped(actual);
    const guarded = guardSupervisor && await supportsSupervisorGuard(actual);
    const game = new ManagedGame(actual, output, guarded);
    try {
      const end = Date.now() + 60000;
      while (Date.now() < end && !game.#closed && !game.ready) await delay(100);
      check(game.ready && !game.#closed, 'The collector backup control did not become ready');
      const hello = await game.request('status', randomUUID(), 0, 'bootstrap');
      game.#boot = hello.bootId; check(isUuid(game.#boot), 'Invalid native backup boot identity');
      game.supervisorGuard = hello.supervisorGuard === true;
      if (guarded)
        check(game.supervisorGuard, 'Native supervisor process guard could not be armed');
      return game;
    } catch (error) { await game.stop().catch(() => {}); throw error; }
  }
  constructor(root, output, guardSupervisor) {
    super(); this.root = root; this.ready = false;
    this.#snapshots = new SnapshotControl(root, (...args) => this.request(...args), () => this.#boot);
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.toUpperCase() === SUPERVISOR_PID) delete env[key];
    if (guardSupervisor) env[SUPERVISOR_PID] = String(process.pid);
    // Windows libuv otherwise terminates the game in the parent job before
    // the collector can request a graceful shutdown. Keep console pipes.
    this.child = spawn(path.join(root, 'bedrock_server_mod.exe'), [], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
      detached: Boolean(guardSupervisor),
    });
    this.child.stdin.on('error', () => this.#fail(new Error('Game control channel closed')));
    this.exit = new Promise(resolve => {
      this.child.once('error', () => { this.#closed = true; this.#fail(new Error('The configured game executable could not start')); resolve(null); });
      this.child.once('exit', code => { this.#closed = true; this.#fail(new Error('The managed game exited')); resolve(code); });
    });
    for (const stream of [this.child.stdout, this.child.stderr]) stream.on('data', chunk => {
      output(chunk); const text = chunk.toString('utf8');
      this.#buffer += text;
      if (this.#buffer.length > 1024 * 1024) { this.#buffer = ''; this.#fail(new Error('Managed game console line exceeds the control limit')); return; }
      let at;
      while ((at = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, at).replace(/\x1b\[[0-9;]*m/g, ''); this.#buffer = this.#buffer.slice(at + 1);
        if (line.includes('Console-only managed backup leases enabled')) this.ready = true;
        this.emit('line', line);
        const start = line.indexOf(PREFIX); if (start < 0) continue;
        let value; try { value = JSON.parse(line.slice(start + PREFIX.length).trim()); } catch { continue; }
        const pending = this.#pending.get(value.requestId);
        if (!pending || value.operationId !== pending.operationId || value.protocol !== 1) continue;
        this.#pending.delete(value.requestId); clearTimeout(pending.timer); pending.resolve(value);
      }
    });
  }
  #fail(error) { this.#snapshots.cancelSnapshot(error); for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.#pending.clear(); }
  async request(action, operationId, offset = 0, boot = this.#boot) {
    check(['status', 'begin', 'query', 'release'].includes(action) && isUuid(operationId) && Number.isSafeInteger(offset) && offset >= 0 && offset <= 16777216, 'Invalid backup control request');
    check(!this.#closed && this.child.stdin.writable, 'The managed game is not running');
    const requestId = randomUUID();
    // The readiness line registers the command before all plugins finish enabling.
    // The first command may stay queued while the game thread completes startup.
    // Only this read-only bootstrap handshake gets the longer allowance; snapshot
    // operations retain their existing timeout and are never automatically retried.
    const timeoutMs = action === 'status' && boot === 'bootstrap' ? 30000 : 5000;
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new Error('Native backup control did not confirm the request')); }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer, operationId });
      this.child.stdin.write(`archivebackup ${action} ${operationId} ${requestId} ${boot} ${offset}\n`, error => { if (error) { this.#pending.delete(requestId); clearTimeout(timer); reject(new Error('Game control channel closed')); } });
    });
    check(await canonicalDirectory(value.root) === this.root, 'Native backup control belongs to a different server directory');
    if (this.#boot) check(value.bootId === this.#boot, 'The collector restarted during the backup');
    return value;
  }
  async status() { return this.request('status', randomUUID()); }
  withSnapshot(action) { return this.#snapshots.withSnapshot(action); }
  cancelSnapshot(reason) { this.#snapshots.cancelSnapshot(reason); }
  get bootId() { return this.#boot; }
  async stop() {
    if (this.#closed) return this.exit;
    this.child.stdin.write('stop\n');
    return Promise.race([this.exit, delay(45000, undefined, { ref: false }).then(() => { throw new Error('Managed game did not stop cleanly'); })]);
  }
}
