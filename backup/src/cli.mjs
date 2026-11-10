#!/usr/bin/env node
import { createStoppedBackup, inspectBackup, restoreBackup } from './archive.mjs';

const [operation, ...argumentsList] = process.argv.slice(2), options = {};
try {
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index], value = argumentsList[index + 1];
    if (!/^--[a-z-]+$/.test(key) || value === undefined || options[key] !== undefined) throw new Error('Expected unique --option value pairs');
    options[key] = value;
  }
  const allowed = operation === 'create' ? ['--root', '--output', '--server-id', '--note', '--scope'] : operation === 'verify' ? ['--file']
    : operation === 'restore' ? ['--file', '--destination', '--mode', '--target-server-id'] : [];
  if (!allowed.length || Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Use create, verify or restore with supported options');
  let result;
  if (operation === 'create') result = await createStoppedBackup({ root: options['--root'], output: options['--output'], serverId: options['--server-id'], note: options['--note'] ?? '', scope: options['--scope'] ?? 'WORLD' });
  else if (operation === 'verify') {
    const proof = await inspectBackup(options['--file']); result = { backupId: proof.manifest.backupId, serverId: proof.manifest.serverId,
      sha256: proof.sha256, archiveBytes: proof.archiveBytes, fileCount: proof.manifest.files.length, sourceBytes: proof.manifest.totalBytes,
      snapshotMode: proof.manifest.snapshotMode, createdAt: proof.manifest.createdAt, statistics: proof.manifest.statistics, runtime: proof.manifest.runtime, restoreVerified: false };
    result.archiveScope = proof.manifest.archiveScope ?? 'FULL';
  } else result = await restoreBackup({ file: options['--file'], destination: options['--destination'], mode: options['--mode'] ?? 'DISABLED', targetServerId: options['--target-server-id'],
    collectorToken: process.env.MCM_RESTORE_COLLECTOR_TOKEN, endpoint: process.env.MCM_RESTORE_INGEST_URL });
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ error: error.code ?? 'BACKUP_FAILED', message: error.message })); process.exitCode = 1; }
