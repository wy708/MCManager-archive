import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = fileURLToPath(new URL('../../', import.meta.url));
const evidence = JSON.parse(await readFile(path.join(project, '.tools/online-backup-evidence.json'), 'utf8'));
assert.ok(evidence.worldRuntimeVerified && evidence.actualBrowserDownloadRestoredAndBooted && evidence.catalogId);
const recreation = JSON.parse(await readFile(path.join(project, '.tools/online-backup-container-recreation.json'), 'utf8'));
assert.notEqual(recreation.before, recreation.after);
const environment = Object.fromEntries((await readFile(path.join(project, '.env'), 'utf8')).split(/\r?\n/)
  .filter(line => line.startsWith('MCM_') && line.includes('='))
  .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'; assert.equal(new URL(base).hostname, '127.0.0.1');
const cookies = new Map();
async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, { ...options, redirect: 'error',
    headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers },
    signal: AbortSignal.timeout(900000) });
  for (const cookie of response.headers.getSetCookie()) { const at = cookie.indexOf('='); cookies.set(cookie.slice(0, at), cookie.slice(at + 1).split(';')[0]); }
  return response;
}
const csrf = await (await request('/api/auth/csrf')).json();
assert.equal((await request('/api/auth/login', { method: 'POST', headers: { [csrf.headerName]: csrf.token },
  body: new URLSearchParams({ username: environment.MCM_ADMIN_USERNAME ?? 'admin', password: environment.MCM_ADMIN_PASSWORD }) })).status, 204);
const record = await (await request(`/api/backups/${evidence.catalogId}`)).json();
assert.equal(record.status, 'READY'); assert.equal(record.sourceBackupId, evidence.backupId);
assert.equal(record.sha256, evidence.archiveSha256); assert.equal(record.summary.snapshotMode, 'BDS_SAVE_QUERY');
assert.equal(record.summary.coordination.nativeWriteCacheFlushed, true);
const response = await request(`/api/backups/${record.id}/content`); assert.equal(response.status, 200);
assert.equal(response.headers.get('x-archive-sha256'), evidence.archiveSha256);
const hash = createHash('sha256'); let bytes = 0n;
for await (const chunk of response.body) { bytes += BigInt(chunk.length); hash.update(chunk); }
assert.equal(hash.digest('hex'), evidence.archiveSha256); assert.equal(bytes.toString(), evidence.archiveBytes);
const result = { verifiedAt: new Date().toISOString(), backupId: evidence.backupId, catalogId: record.id,
  archiveSha256: evidence.archiveSha256, archiveBytes: bytes.toString(),
  backendContainerChanged: recreation.before !== recreation.after, metadataAndArchivePreserved: true };
await writeFile(path.join(project, '.tools/online-backup-persistence-evidence.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
