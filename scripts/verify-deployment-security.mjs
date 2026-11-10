import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const internal = new URL('http://127.0.0.1:18090');
const tls = process.argv.includes('--https');
const mode = tls ? 'https' : 'http';
const env = Object.fromEntries(readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('MCM_') && line.includes('='))
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const evidence = { mode, verifiedAt: '' };
let proxy, directory, certificate, base = internal;

function request(route, { method = 'GET', headers = {}, body, trusted = true } = {}) {
  return new Promise((resolve, reject) => {
    const client = tls ? https : http;
    const req = client.request(new URL(route, base), { method, headers, ca: trusted ? certificate : undefined, timeout: 15_000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Request timed out for ${route}`)));
    req.end(body);
  });
}

function sessionCookie(response) {
  const value = response.headers['set-cookie']?.find(header => header.startsWith('JSESSIONID='));
  assert.ok(value, 'Expected a session cookie');
  assert.ok(/;\s*HttpOnly(?:;|$)/i.test(value), 'Session cookie must be HttpOnly');
  assert.ok(/;\s*SameSite=Strict(?:;|$)/i.test(value), 'Session cookie must use SameSite=Strict');
  assert.equal(/;\s*Secure(?:;|$)/i.test(value), tls, 'Secure must reflect deployment mode');
  return value.split(';')[0];
}

async function login() {
  const forged = { 'X-Forwarded-Proto': tls ? 'http' : 'https', Forwarded: `proto=${tls ? 'http' : 'https'}` };
  const before = await request('/api/auth/csrf', { headers: forged });
  assert.equal(before.status, 200);
  const initial = sessionCookie(before), csrf = JSON.parse(before.body);
  const response = await request('/api/auth/login', { method: 'POST', headers: {
    ...forged, Cookie: initial, [csrf.headerName]: csrf.token, 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ username: env.MCM_ADMIN_USERNAME ?? 'admin', password: env.MCM_ADMIN_PASSWORD }).toString() });
  assert.equal(response.status, 204);
  const cookie = sessionCookie(response);
  assert.ok(cookie !== initial, 'Session identifier must rotate on authentication');
  assert.equal((await request('/api/servers', { headers: { Cookie: initial } })).status, 401);
  const fresh = await request('/api/auth/csrf', { headers: { Cookie: cookie } });
  assert.equal(fresh.status, 200);
  return { cookie, csrf: JSON.parse(fresh.body) };
}

function publishEvidence() {
  evidence.verifiedAt = new Date().toISOString();
  writeFileSync(path.join(root, `.tools/security-${mode}-evidence.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}

try {
  if (tls) {
    directory = mkdtempSync(path.join(root, '.tools/security-tls-'));
    const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
    const config = path.join(directory, 'openssl.cnf');
    writeFileSync(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n');
    execFileSync(process.env.MCM_QA_OPENSSL ?? 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-config', config, '-days', '1'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    certificate = readFileSync(cert);
    proxy = https.createServer({ key: readFileSync(key), cert: certificate }, (req, res) => {
      const upstream = http.request({ hostname: internal.hostname, port: internal.port, path: req.url, method: req.method, headers: req.headers }, answer => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(18443, '127.0.0.1', resolve); });
    base = new URL('https://127.0.0.1:18443');
    await assert.rejects(() => request('/api/health', { trusted: false }), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    assert.equal((await request('/api/health')).status, 200);
    evidence.tlsCertificateVerified = true;
  }

  const { cookie, csrf } = await login();
  evidence.sessionIdRotated = true;
  evidence.secureCookie = tls;
  evidence.httpOnlyAndSameSiteStrict = true;
  evidence.forgedForwardedProtoIgnored = true;
  const admin = (route, method = 'GET', data) => request(route, { method, headers: {
    Cookie: cookie, [csrf.headerName]: csrf.token, 'Content-Type': 'application/json',
  }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (tls) {
    const site = await request('/');
    assert.equal(site.status, 200);
    assert.match(site.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(site.headers['x-content-type-options'], 'nosniff');
    const archive = await admin('/api/servers', 'POST', { name: '部署安全隔离验收', description: 'Loopback security QA', startDate: '2020-01-01' });
    assert.equal(archive.status, 201);
    const serverId = JSON.parse(archive.body).id;
    const collector = await admin(`/api/servers/${serverId}/collector-credential`, 'POST');
    const agent = await admin('/api/agents', 'POST', { name: '部署安全只读验收', grants: [{ serverId, scopes: ['STATS_READ'] }] });
    const host = await admin('/api/backup-hosts', 'POST', { serverId, name: '部署安全宿主验收' });
    assert.equal(collector.status, 200);
    assert.equal(agent.status, 200);
    assert.equal(host.status, 201);
    for (const issued of [collector, agent, host]) assert.match(issued.headers['cache-control'], /\bno-store\b/);
    const collectorToken = JSON.parse(collector.body).token;
    const agentIssued = JSON.parse(agent.body), hostIssued = JSON.parse(host.body);
    const credentials = { anonymous: {}, admin: { Cookie: cookie },
      collector: { Authorization: 'Bearer ' + collectorToken }, agent: { Authorization: 'Bearer ' + agentIssued.token },
      host: { Authorization: 'Bearer ' + hostIssued.token } };
    const targets = {
      admin: { route: '/api/servers' },
      collector: { route: '/api/ingest/v1/batches', body: { protocolVersion: 1, batchId: randomUUID(), reportedAt: new Date().toISOString(),
        collector: { version: 'security-qa', bdsVersion: 'qa', leviLaminaVersion: 'qa', bootId: randomUUID(), pendingEvents: 0 }, capabilities: [], events: [] } },
      agent: { route: '/api/agent/servers' },
      host: { route: '/api/host/v1/heartbeat', body: { runId: randomUUID(), state: 'STOPPED', version: 'security-qa' } },
    };
    const access = (target, credential) => request(target.route, { method: target.body ? 'POST' : 'GET',
      headers: { ...credential, 'Content-Type': 'application/json' }, body: target.body ? JSON.stringify(target.body) : undefined });
    try {
      for (const [role, target] of Object.entries(targets)) {
        for (const [presented, credential] of Object.entries(credentials)) {
          const result = await access(target, credential);
          assert.equal(result.status, role === presented ? 200 : 401, `${presented} accessing ${role}`);
          if (role !== 'admin') assert.ok(!result.headers['set-cookie'], 'Machine requests must remain stateless');
        }
      }
      evidence.roleMatrixCases = 20;
      const crossOrigin = await request('/api/servers', { headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' } });
      assert.equal(crossOrigin.headers['access-control-allow-origin'], undefined);
      const noCsrf = await request('/api/activity/retention', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"days":1}' });
      assert.equal(noCsrf.status, 403);
      assert.equal((await request(`/api/agent/servers/${serverId}/activity?chat=true`, { headers: credentials.agent })).status, 403);
      assert.equal((await request(`/api/agent/servers/${randomUUID()}/statistics`, { headers: credentials.agent })).status, 403);
      evidence.agentReadScopeAndArchiveVerified = true;
      evidence.csrfAndCorsVerified = true;
      assert.equal((await admin(`/api/servers/${serverId}/collector-credential`, 'DELETE')).status, 204);
      assert.equal((await admin(`/api/agents/${agentIssued.account.id}`, 'DELETE')).status, 204);
      assert.equal((await admin(`/api/backup-hosts/${hostIssued.host.id}`, 'DELETE')).status, 204);
      for (const role of ['collector', 'agent', 'host']) assert.equal((await access(targets[role], credentials[role])).status, 401);
      evidence.machineRevocationsVerified = true;
    } finally {
      await admin(`/api/servers/${serverId}/collector-credential`, 'DELETE').catch(() => {});
      await admin(`/api/agents/${agentIssued.account.id}`, 'DELETE').catch(() => {});
      await admin(`/api/backup-hosts/${hostIssued.host.id}`, 'DELETE').catch(() => {});
    }

    const auth = await request('/api/auth/csrf');
    const unauthenticatedCookie = sessionCookie(auth), loginCsrf = JSON.parse(auth.body);
    let blocked = 0, denied = 0;
    for (let attempt = 0; attempt < 16; attempt++) {
      const result = await request('/api/auth/login', { method: 'POST', headers: { Cookie: unauthenticatedCookie, [loginCsrf.headerName]: loginCsrf.token,
        'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': `198.51.100.${attempt + 1}` },
      body: new URLSearchParams({ username: env.MCM_ADMIN_USERNAME ?? 'admin', password: 'invalid-security-qa-password' }).toString() });
      if (result.status === 429) blocked++;
      else { assert.equal(result.status, 401); denied++; }
    }
    assert.ok(denied > 0 && blocked > 0);
    assert.equal((await admin('/api/servers')).status, 200);
    evidence.invalidLoginAttempts = denied;
    evidence.rateLimitedAttempts = blocked;
    evidence.otherRoutesRemainAvailable = true;
    const { chromium, expect } = await import('../frontend/node_modules/@playwright/test/index.mjs');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(internal.origin);
      await page.getByLabel('密码', { exact: true }).fill('invalid-security-qa-password');
      const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/auth/login');
      await page.getByRole('button', { name: '进入工作台' }).click();
      assert.equal((await response).status(), 429);
      await expect(page.getByRole('alert')).toContainText('登录尝试过于频繁');
      evidence.browserShowsLoginThrottle = true;
    } finally { await browser.close(); }
  }
  assert.equal((await admin('/api/auth/logout', 'POST')).status, 204);
  assert.equal((await request('/api/servers', { headers: { Cookie: cookie } })).status, 401);
  evidence.logoutInvalidatedSession = true;
  publishEvidence();
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  if (directory) {
    for (const name of ['key.pem', 'cert.pem', 'openssl.cnf']) { try { unlinkSync(path.join(directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    rmdirSync(directory);
  }
}
