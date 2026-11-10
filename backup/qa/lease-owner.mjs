// Isolated real-process fault injector. The parent supplies only the private
// game-console transport; this process owns and renews its native lease.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const operationId = randomUUID(), pending = new Map();
process.on('message', message => { const callback = pending.get(message.id); if (callback) { pending.delete(message.id); callback(message.result); } });
const request = action => new Promise(resolve => { const id = randomUUID(); pending.set(id, resolve); process.send({ id, action, operationId }); });
let response = await request('begin');
while (response.phase === 'PREPARING') { await delay(100); response = await request('query'); }
if (response.phase !== 'READY') throw new Error('Lease fault injector did not acquire a real native snapshot');
process.send({ held: true, operationId });
while (true) { await delay(1000); await request('query'); }
