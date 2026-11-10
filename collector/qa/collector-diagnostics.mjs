import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function spoolAccess(spool, action, originalAcl = '') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $spool = Get-Item -LiteralPath $env:MCM_QA_DIAGNOSTICS_SPOOL
    if (!$spool.PSIsContainer -or ($spool.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid QA spool path' }
    $acl = Get-Acl -LiteralPath $spool.FullName
    if ($env:MCM_QA_DIAGNOSTICS_ACL_ACTION -eq 'read') { $acl.Sddl; exit }
    if ($env:MCM_QA_DIAGNOSTICS_ACL_ACTION -eq 'block') {
      $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,
        [Security.AccessControl.FileSystemRights]::CreateFiles, [Security.AccessControl.AccessControlType]::Deny)
      $acl.AddAccessRule($rule)
    } else {
      $acl.SetSecurityDescriptorSddlForm($env:MCM_QA_DIAGNOSTICS_ORIGINAL_ACL, [Security.AccessControl.AccessControlSections]::Access)
    }
    Set-Acl -LiteralPath $spool.FullName -AclObject $acl
  `], { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...env,
    MCM_QA_DIAGNOSTICS_SPOOL: spool, MCM_QA_DIAGNOSTICS_ACL_ACTION: action, MCM_QA_DIAGNOSTICS_ORIGINAL_ACL: originalAcl } }).trim();
}

export async function verifyCollectorDiagnostics({ bot, received, command, status, diagnostics, until, spool, readChat, replay }) {
  const initial = await until(async () => (await status()).diagnostics);
  assert.equal(initial.captureGaps, 0);
  assert.equal(initial.rejectedSubmissions, 0);
  assert.equal(initial.diskError, false);
  const say = message => bot.queue('text', { category: 'authored', type: 'chat', needs_translation: false,
    source_name: bot.profile.name, xuid: '', platform_chat_id: '', has_filtered_message: false, message });
  const diskMessage = '写盘故障恢复验收 ' + randomUUID();
  const originalAcl = spoolAccess(spool, 'read');
  assert.ok(originalAcl);
  const savedAcl = path.resolve(spool, '..', 'qa-diagnostics-original-acl.txt');
  writeFileSync(savedAcl, originalAcl, { flag: 'wx' });
  try {
    spoolAccess(spool, 'block');
    say(diskMessage);
    await until(() => received.some(packet => packet.message === diskMessage));
    const fault = await until(async () => {
      const value = (await status()).diagnostics;
      return value?.bootId === initial.bootId && value.diskError && value.queuedEvents > 0 ? value : null;
    });
    assert.equal(fault.diskFaults, 1);
    assert.ok(!(await readChat()).items.some(item => item.text === diskMessage));
    console.log(JSON.stringify({ stage: 'native-write-denied-but-heartbeat-reported', queuedEvents: fault.queuedEvents }));
  } finally {
    spoolAccess(spool, 'restore', originalAcl);
    assert.equal(spoolAccess(spool, 'read'), originalAcl);
    unlinkSync(savedAcl);
  }
  await until(async () => {
    const value = (await status()).diagnostics;
    return value?.bootId === initial.bootId && !value.diskError && value.queuedEvents === 0 && value.diskFaults === 1;
  });
  const recoveredChat = await until(async () => {
    const messages = (await readChat()).items.filter(item => item.text === diskMessage);
    return messages.length ? messages : null;
  });
  assert.equal(recoveredChat.length, 1);

  say('[QA] overflow chat observations');
  await until(() => diagnostics().includes('QA filled chat observation buffer without broadcasting'));
  const live = await until(async () => {
    const value = await status();
    return value.diagnostics?.bootId === initial.bootId && value.diagnostics.captureGaps === 3 ? value.diagnostics : null;
  });
  assert.equal(live.finalReport, false);
  assert.equal(live.rejectedSubmissions, 0);
  assert.equal(live.diskFaults, 1);
  assert.ok(!(await readChat()).items.some(item => item.text.includes('QA unpublished observation') || item.text.includes('[QA] overflow chat observations')));
  command('ll disable archive-collector');
  await until(() => diagnostics().includes('Disable mod archive-collector successfully'));
  let original;
  for (const file of readdirSync(spool)) {
    if (!file.endsWith('.pending')) continue;
    const { body } = JSON.parse(readFileSync(path.join(spool, file), 'utf8'));
    const batch = JSON.parse(body);
    if (batch.collector.bootId !== initial.bootId || !batch.collector.diagnostics?.final) continue;
    assert.equal(batch.collector.diagnostics.captureGaps, 3);
    assert.equal(batch.events.length, 0);
    original = body;
    break;
  }
  assert.ok(original, 'Final anomaly snapshot must survive collector shutdown');
  command('ll enable archive-collector');
  const restarted = await until(async () => {
    const value = await status();
    const previous = value.previousAnomalies.find(item => item.bootId === initial.bootId);
    return value.diagnostics && value.diagnostics.bootId !== initial.bootId && previous?.finalReport ? value : null;
  });
  assert.equal(restarted.diagnostics.captureGaps, 0);
  const prior = restarted.previousAnomalies.find(item => item.bootId === initial.bootId);
  assert.equal(prior.captureGaps, 3);
  assert.equal(prior.diskFaults, 1);
  assert.equal(prior.diskError, false);
  const receipt = await replay(original);
  assert.equal(receipt.duplicateBatch, true);
  assert.equal(receipt.acceptedEvents, 0);
  console.log(JSON.stringify({ stage: 'native-diagnostics-replayed-after-restart', knownGaps: 3 }));
  return { priorBoot: initial.bootId, currentBoot: restarted.diagnostics.bootId, knownGaps: 3, currentGaps: 0,
    nativeObservationOverflow: true, finalDiagnosticsReplayed: true, noSyntheticChatPersisted: true,
    diskFaults: 1, actualWriteDenied: true, recoveredChatOnce: true };
}
