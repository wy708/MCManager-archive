import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const native = path.join(root, 'collector/build/windows/x64/release/verify-collector-core.exe')
assert.ok(existsSync(native), 'Build collector/verify-collector-core first')
const settings = Object.fromEntries(readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/).filter(line => line.startsWith('MCM_')).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
const base = process.env.MCM_QA_BASE_URL ?? 'http://127.0.0.1:18088'
const directory = path.join(root, '.tools', 'native-transport-' + randomUUID())
mkdirSync(directory, { recursive: true })
const cookies = new Map()
let csrf
async function request(endpoint, options = {}) {
  const response = await fetch(base + endpoint, { ...options, headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers } })
  for (const cookie of response.headers.getSetCookie()) {
    const index = cookie.indexOf('='); cookies.set(cookie.slice(0, index), cookie.slice(index + 1).split(';')[0])
  }
  return response
}
async function admin(endpoint, data, method = 'POST') {
  const response = await request(endpoint, { method, headers: { [csrf.headerName]: csrf.token, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) })
  assert.ok(response.ok, `${endpoint}: HTTP ${response.status}`)
  return response.status === 204 ? undefined : response.json()
}
function child(phase, config) {
  return new Promise((resolve, reject) => {
    const process = spawn(native, [phase, config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    process.stdout.on('data', data => { output += data })
    process.stderr.on('data', data => { errors += data })
    process.once('error', reject)
    process.once('exit', code => code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(`Native verification failed: ${errors}`)))
  })
}
function config(name, value) { const file = path.join(directory, name + '.json'); writeFileSync(file, JSON.stringify(value)); return file }
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)) }) }
function close(server) { return new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }

csrf = await (await request('/api/auth/csrf')).json()
assert.equal((await request('/api/auth/login', { method: 'POST', headers: { [csrf.headerName]: csrf.token }, body: new URLSearchParams({ username: settings.MCM_ADMIN_USERNAME ?? 'admin', password: settings.MCM_ADMIN_PASSWORD }) })).status, 204)
csrf = await (await request('/api/auth/csrf')).json()
const archive = await admin('/api/servers', { name: 'QA · 原生上传 ' + randomUUID().slice(0, 8), description: 'Native WinHTTP/outbox contract verification, not real gameplay', startDate: '2020-01-01' })
const credential = await admin(`/api/servers/${archive.id}/collector-credential`, {})
const identity = ((BigInt('0x' + randomBytes(8).toString('hex')) % 9_000_000_000_000_000_000n) + 1n).toString()
const player = { identityType: 'XUID', identity, name: 'Native-Contract-QA' }
const at = new Date(Date.now() - 10000).toISOString()
const payload = { protocolVersion: 1, batchId: randomUUID(), reportedAt: new Date().toISOString(), collector: { version: 'native-transport-qa', bdsVersion: 'not-a-game', leviLaminaVersion: 'not-a-plugin', bootId: randomUUID(), pendingEvents: 1 }, capabilities: ['blocks.mined', 'experience.gained'].map(metric => ({ metric, state: 'ACTIVE', quality: 'EXACT', algorithmVersion: 'native-qa-v1', dimensionAware: true })), events: [{ eventId: randomUUID(), kind: 'COUNTER', at, player, dimension: 'minecraft:overworld', metric: 'blocks.mined', value: 3, subject: 'minecraft:stone' }, { eventId: randomUUID(), kind: 'COUNTER', at, player, dimension: 'minecraft:overworld', metric: 'experience.gained', value: 5 }] }
const body = JSON.stringify(payload)
const common = { serverId: archive.id, token: credential.token, body, endpoint: base + '/api/ingest/v1/batches' }
const live = config('real-backend', { ...common, outbox: path.join(directory, 'real-backend') })
let mode = 'wrong-id', faultRequests = 0, redirectedRequests = 0
const sink = http.createServer((req, res) => { redirectedRequests++; req.resume(); res.end('{}') })
const sinkPort = await listen(sink)
const faults = http.createServer((req, res) => {
  faultRequests++; req.resume(); req.once('end', () => {
    if (mode === 'redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${sinkPort}/api/ingest/v1/batches` }); res.end(); return }
    if (mode === 'failure') { res.writeHead(503); res.end('{}'); return }
    res.setHeader('Content-Type', 'application/json')
    if (mode === 'html') res.end('<html>proxy login</html>')
    else if (mode === 'control-success') res.end('[]')
    else if (mode === 'oversize') res.end(' '.repeat(70000))
    else res.end(JSON.stringify({ batchId: mode === 'wrong-id' ? randomUUID() : payload.batchId, acceptedEvents: mode === 'wrong-count' ? 3 : 2, duplicateEvents: 0, duplicateBatch: mode === 'contradiction' }))
  })
})
const port = await listen(faults)
let tls
try {
  const staged = await child('--http-stage', live)
  assert.equal(staged.pending, 1)
  const replayed = await child('--http-replay', live)
  assert.equal(replayed.pending, 0)
  const cases = []
  for (const name of ['wrong-id', 'wrong-count', 'contradiction', 'html', 'oversize', 'redirect', 'failure']) {
    mode = name
    const fixture = config(name, { ...common, endpoint: `http://127.0.0.1:${port}/api/ingest/v1/batches`, outbox: path.join(directory, 'fault-outbox'), expectedStatus: name === 'redirect' ? 302 : name === 'failure' ? 503 : 200 })
    const result = await child('--http-reject', fixture)
    assert.equal(result.pending, 1); cases.push(name)
  }
  assert.equal(redirectedRequests, 0, 'Bearer request followed a redirect')
  const controlCases = []
  for (const name of ['control-success', 'redirect', 'oversize', 'failure']) {
    mode = name
    await child('--http-control', config('control-' + name, { ...common, endpoint: `http://127.0.0.1:${port}/api/ingest/v1/batches`, expectedStatus: name === 'redirect' ? 302 : name === 'failure' ? 503 : 200, success: name === 'control-success' }))
    controlCases.push(name)
  }
  const beforeInvalidControl = faultRequests
  for (const extra of [{ route: '/commands/../batches' }, { controlBody: ' '.repeat(65537) }]) {
    await child('--http-control', config('invalid-control-' + randomUUID(), { ...common, ...extra, endpoint: `http://127.0.0.1:${port}/api/ingest/v1/batches`, expectedStatus: 0, success: false }))
  }
  assert.equal(faultRequests, beforeInvalidControl, 'Invalid command route or oversized request reached the network')
  assert.equal(redirectedRequests, 0, 'Command Bearer request followed a redirect')
  controlCases.push('invalid-route', 'request-size-limit')
  const before = faultRequests
  await child('--http-reject', config('other-server', { ...common, token: randomUUID() + credential.token.slice(36), endpoint: `http://127.0.0.1:${port}/api/ingest/v1/batches`, outbox: path.join(directory, 'fault-outbox'), expectedStatus: 0 }))
  assert.equal(faultRequests, before, 'Wrong server credential reached the network')
  cases.push('server-binding')
  const openssl = process.env.MCM_OPENSSL ?? 'C:/Program Files/Git/usr/bin/openssl.exe'
  assert.ok(existsSync(openssl), 'Set MCM_OPENSSL to an OpenSSL executable for TLS rejection verification')
  const key = path.join(directory, 'self-signed.key'), certificate = path.join(directory, 'self-signed.crt')
  await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1'], { windowsHide: true })
  let tlsRequests = 0
  tls = https.createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (req, res) => { tlsRequests++; req.resume(); res.end(JSON.stringify({ batchId: payload.batchId, acceptedEvents: 2, duplicateEvents: 0, duplicateBatch: false })) })
  const tlsPort = await listen(tls)
  await child('--http-reject', config('self-signed', { ...common, endpoint: `https://127.0.0.1:${tlsPort}/api/ingest/v1/batches`, outbox: path.join(directory, 'fault-outbox'), expectedStatus: 0 }))
  assert.equal(tlsRequests, 0)
  await child('--http-control', config('control-self-signed', { ...common, endpoint: `https://127.0.0.1:${tlsPort}/api/ingest/v1/batches`, expectedStatus: 0, success: false }))
  assert.equal(tlsRequests, 0, 'Command request bypassed TLS validation')
  controlCases.push('untrusted-tls')
  cases.push('untrusted-tls')
  const summary = await (await request(`/api/statistics/summary?serverId=${archive.id}&playerKey=xuid:${identity}`)).json()
  assert.equal(summary.metrics.find(metric => metric.key === 'blocks.mined').value, '3')
  assert.equal(summary.metrics.find(metric => metric.key === 'experience.gained').value, '5')
  const evidence = { verifiedAt: new Date().toISOString(), serverId: archive.id, processRestartReplay: true, nativeWinHttp: true, minedBlocks: '3', experience: '5', failureCases: cases, controlCases, redirectsFollowed: 0, realGameplay: false }
  writeFileSync(path.join(root, '.tools/native-transport-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
} finally {
  await close(faults); await close(sink); if (tls) await close(tls)
  await admin(`/api/servers/${archive.id}/collector-credential`, undefined, 'DELETE')
}
