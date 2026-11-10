import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { GameAiMailbox } from './game-ai.mjs';
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mcm-ai-native-'));
try {
  const directory = path.join(base, 'mailbox');
  const mailbox = new GameAiMailbox({ schema: 1, enabled: true, directory,
    serverId: '11111111-1111-4111-8111-111111111111', groupKey: 'group:123456789' }, {
    allowed: () => true, wake: async () => true
  });
  const child = spawn(path.resolve(process.argv[2]), [directory, '--bridge'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const finished = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
  const deadline = Date.now() + 8000;
  while (!output.includes('request-ready') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.match(output, /request-ready/);
  await mailbox.scan();
  assert.equal(mailbox.pending.size, 1);
  const [id, record] = [...mailbox.pending][0];
  const receipt = await mailbox.reply(`game:${id}`, record.token, { messages: '检查燃料和配方。' });
  assert.equal(receipt.delivered, false);
  assert.equal(await finished, 0, output);
  console.log(output.trim());
  console.log('Real native C++ worker -> local bridge -> native response passed. No DSH model or game player was invoked.');
} finally { await fs.rm(base, { recursive: true, force: true }); }
