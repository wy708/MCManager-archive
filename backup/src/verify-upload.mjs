// Private subprocess contract for the Java management service. Never extracts or
// executes an uploaded server. No configuration contents are returned.
import { inspectBackup } from './archive.mjs';
import { canonicalJson, check, isUuid, writeNew } from './paths.mjs';

const [file, expectedServerId, output, expandedLimit] = process.argv.slice(2);
let result;
try {
  check(isUuid(expectedServerId), 'Invalid expected server');
  const proof = await inspectBackup(file, { maxBytes: BigInt(expandedLimit) });
  if (proof.manifest.serverId !== expectedServerId) {
    result = { valid: false, code: 'ARCHIVE_WRONG_SERVER' };
  } else {
    const value = proof.manifest;
    result = { valid: true, backupId: value.backupId, serverId: value.serverId, sha256: proof.sha256,
      archiveBytes: proof.archiveBytes, sourceBytes: value.totalBytes, fileCount: value.files.length,
      snapshotMode: value.snapshotMode, snapshotStartedAt: value.snapshotStartedAt, createdAt: value.createdAt,
      archiveScope: value.archiveScope ?? 'FULL', worldDirectory: value.worldDirectory ?? value.coordination?.worldDirectory ?? null,
      statistics: value.statistics, runtime: value.runtime, externalDatabases: value.externalDatabases,
      ...(value.coordination ? { coordination: { controlProtocol: value.coordination.controlProtocol,
        nativeWriteCacheFlushed: value.coordination.nativeWriteCacheFlushed,
        preparedAt: value.coordination.preparedAt, releaseConfirmedAt: value.coordination.releaseConfirmedAt,
        ancillaryStableInterval: value.coordination.ancillaryStableInterval, worldFileCount: value.coordination.worldFiles.length,
        ...(value.coordination.collectorCheckpoint ? { collectorCheckpoint: value.coordination.collectorCheckpoint } : {}),
        consistency: value.archiveScope === 'WORLD' ? 'NATIVE_WORLD_ONLY' : 'NATIVE_WORLD_AND_STABLE_ANCILLARY_FILES' } } : {}),
      worldRuntimeVerified: false };
  }
} catch {
  result = { valid: false, code: 'ARCHIVE_INVALID' };
}
await writeNew(output, canonicalJson(result));
if (!result.valid) process.exitCode = 2;
