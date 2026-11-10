// Synthetic protocol fixture, never a runnable BDS or game-restoration proof.
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { createStoppedBackup, createOnlineBackup } from '../src/archive.mjs';
import { check, isUuid } from '../src/paths.mjs';
const [directory, serverId, output] = process.argv.slice(2);
check(isUuid(serverId), 'Fixture server identity must be a UUID');
const source = path.join(directory, 'synthetic-server'); await mkdir(source);
const files = {
  'bedrock_server_mod.exe': 'Synthetic API/browser fixture; not a game executable',
  'server.properties': 'level-name=上传夹具\n',
  'worlds/上传夹具/level.dat': 'Synthetic world bytes, not a playable world',
  'worlds/上传夹具/db/000001.log': 'Fixture WAL retained',
  'plugins/archive-collector/config/config.json': JSON.stringify({ enabled: true, serverId, token: serverId + '.' + 'A'.repeat(43), endpoint: 'http://127.0.0.1:8080/api/ingest/v1/batches' }),
  'plugins/archive-collector/data/outbox/server-id': serverId,
};
for (const [name, value] of Object.entries(files)) { await mkdir(path.dirname(path.join(source, name)), { recursive: true }); await writeFile(path.join(source, name), value); }
if (process.argv.includes('--large')) await writeFile(path.join(source, 'synthetic-upload-payload.bin'), randomBytes(2 * 1024 * 1024));
const options = { root: source, output, serverId, note: 'Synthetic protocol fixture; not game evidence' };
if (process.argv.includes('--world')) options.scope = 'WORLD';
if (process.argv.includes('--online')) {
  await writeFile(path.join(source, 'worlds/上传夹具/db/CURRENT'), 'MANIFEST-000001\n');
  await writeFile(path.join(source, 'worlds/上传夹具/db/MANIFEST-000001'), 'synthetic manifest');
  const names = ['level.dat', 'db/000001.log', 'db/CURRENT', 'db/MANIFEST-000001'];
  const { stat } = await import('node:fs/promises');
  const native = [];
  for (const name of names) native.push(`上传夹具/${name}:${(await stat(path.join(source, 'worlds/上传夹具', name))).size}`);
  const game = { root: await realpath(source), async withSnapshot(action) {
    return action({ operationId: randomUUID(), bootId: randomUUID(), nativeWriteCacheFlushed: true,
      snapshotStartedAt: new Date().toISOString(), preparedAt: new Date().toISOString(),
      messages: [{ id: 'commands.save-all.success', params: [] }, { id: '%%s', params: [native.join(', ')] }],
      signal: new AbortController().signal, assertActive() {} });
  } };
  console.log(JSON.stringify(await createOnlineBackup({ ...options, game })));
} else console.log(JSON.stringify(await createStoppedBackup(options)));
