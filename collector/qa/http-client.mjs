// Local QA adapter for Mojang's full-ICE NetherNet HTTP signaling.
// Uses the pinned client's external signaling hook; does not alter game authentication.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import bedrock from 'bedrock-protocol';
const require = createRequire(import.meta.url);
const JWT = require('jsonwebtoken');
const { attachIdentity } = require('nethernet/src/identity');
const { SignalStructure, SignalType } = require('nethernet');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function localGameClient(origin, username = 'ArchiveQA', onError = () => {}, offlineIdentity, profileId) {
  const url = new URL(origin); assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname));
  // Offline clients carry a separate self-signed/device identity as well as
  // the protocol UUID. Persistence tests must keep both stable across clients.
  if (offlineIdentity !== undefined) assert.match(offlineIdentity, uuidPattern);
  if (profileId !== undefined) assert.match(profileId, uuidPattern);
  let advertised;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/v1/join', url), { signal: AbortSignal.timeout(10_000) });
    // BDS can accept HTTP before its game advertisement is ready during startup.
    if (response.status === 204 || response.status === 503) { await delay(100); continue; }
    assert.equal(response.status, 200, 'The local game advertisement must be available');
    advertised = await response.json(); break;
  }
  assert.ok(advertised, 'The local game advertisement did not become ready');
  assert.match(advertised.version, /^1\.26\.51(?:\.1)?$/);
  const client = bedrock.createClient({ host: url.hostname, port: Number(url.port), version: '1.26.51', username,
    offline: true, skipPing: true, transport: 'nethernet', nethernet: { networkId: 1n, webrtcBackend: 'werift' },
    connectTimeout: 30_000, conLog: () => {}, viewDistance: 5,
    ...(offlineIdentity === undefined ? {} : { skinData: { SelfSignedId: offlineIdentity, DeviceId: offlineIdentity, PlatformOfflineId: offlineIdentity } }) });
  // The pinned client's offline session is created synchronously; its identity
  // chain is signed later, after network settings are received.
  if (profileId !== undefined) client.profile.uuid = profileId;
  client.on('error', onError);
  const transport = client.connection.nethernet;
  clearInterval(transport.pingInterval);
  transport.identity = { privateKey: client.ecdhKeyPair.privateKey, token: JWT.sign({ cpk: client.clientX509 }, client.privateKeyPEM, { algorithm: 'ES384', expiresIn: '1h' }) };
  transport.signalHandler = signal => {
    if (signal.type !== SignalType.ConnectRequest) return;
    (async () => {
      const offer = attachIdentity(transport.rtcConnection.localDescription.sdp, transport.identity);
      const response = await fetch(new URL('/v1/join/' + transport.networkId.toString(), url), {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer, redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Local game signaling rejected: HTTP ${response.status}`);
      await transport.handleAnswer(new SignalStructure(SignalType.ConnectResponse, signal.connectionId, await response.text(), transport.serverNetworkId));
    })().catch(error => client.emit('error', error));
  };
  // createClient starts LAN discovery synchronously; switch that pending connection to our HTTP path.
  transport.startOffer();
  return client;
}
