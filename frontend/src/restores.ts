import { t, formatLocale } from './i18n'
export interface RestoreSource {
  id: string
  serverId: string
  status: string
  sourceBackupId: string | null
  sha256: string | null
  archiveBytes: string | null
  fileCount: number | null
  snapshotAt?: string | null
  createdAt?: string
  summary: {
    archiveScope?: 'WORLD' | 'FULL'
    statistics?: {
      pendingEvents?: string | null
      cacheIntegrity?: string
      latestAcknowledgedEventAt?: string | null
    }
  } | null
}
export interface RestoreHost {
  id: string
  serverId: string
  name: string
  revoked: boolean
  restoreEnabled: boolean
  online: boolean
  runtimeState: string | null
  version?: string | null
}
export function supportsWorldBackup(version: string | null | undefined) {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return false
  const [major, minor] = version.split('.').map(Number)
  return major! > 0 || minor! >= 7
}
export function formatRestoreBytes(value: string | null | undefined) {
  if (!value) return t('m0227')
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return t('m0227')
  if (amount < 1024) return amount.toLocaleString(formatLocale) + ' B'
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = amount / 1024,
    unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return size.toLocaleString(formatLocale, { maximumFractionDigits: 1 }) + ' ' + units[unit]
}
export interface RestoreJob {
  id: string
  backupId: string
  sourceServerId: string
  targetServerId: string
  hostId: string
  mode: string
  destinationName: string
  note: string
  status: string
  cancelRequested: boolean
  sourceBackupId: string
  archiveSha256: string
  archiveBytes: string
  fileCount: number
  restorationId: string | null
  errorCode: string | null
  resolutionNote: string | null
  createdAt: string
  worldRuntimeVerified: false
}
export interface RestoreDraft {
  backupId: string
  requestId: string
  hostId: string
  mode: 'DISABLED' | 'CONTINUE' | 'FORK'
  destinationName: string
  note: string
  forkName: string | null
  forkStartDate: string | null
}
export const restoreModes = {
  DISABLED: t('m0228'),
  CONTINUE: t('m0229'),
  FORK: t('m0230'),
}
export const restoreStates: Record<string, string> = {
  QUEUED: t('m0231'),
  CLAIMED: t('m0232'),
  RUNNING: t('m0233'),
  READY: t('m0234'),
  FAILED: t('m0235'),
  UNCERTAIN: t('m0236'),
  CANCELLED: t('m0237'),
}
export const restoreDiagnostics: Record<string, string> = {
  DOWNLOAD_FAILED: t('m0238'),
  ARCHIVE_INVALID: t('m0239'),
  DESTINATION_EXISTS: t('m0240'),
  RESTORE_FAILED: t('m0241'),
  EXECUTION_INTERRUPTED: t('m0242'),
  EXECUTION_EXPIRED: t('m0243'),
  CREDENTIAL_CHANGED: t('m0244'),
  ACCESS_REVOKED: t('m0245'),
  RUNNER_CHANGED: t('m0246'),
  COLLECTOR_REJECTED: t('m0247'),
  OPERATOR_CANCELLED: t('m0248'),
  OPERATOR_RESOLVED: t('m0249'),
  CLAIM_EXPIRED: t('m0250'),
}
export const validRestoreFolder = (name: string) =>
  name.length <= 64 &&
  name.normalize('NFC') === name &&
  /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u.test(name) &&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)
export function validRestoreDraft(value: unknown): value is RestoreDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as RestoreDraft,
    uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  return (
    [draft.backupId, draft.requestId, draft.hostId].every(
      (id) => typeof id === 'string' && uuid.test(id),
    ) &&
    ['DISABLED', 'CONTINUE', 'FORK'].includes(draft.mode) &&
    typeof draft.destinationName === 'string' &&
    validRestoreFolder(draft.destinationName) &&
    typeof draft.note === 'string' &&
    draft.note.length <= 1000 &&
    (draft.mode === 'FORK'
      ? typeof draft.forkName === 'string' &&
        draft.forkName.length > 0 &&
        draft.forkName.length <= 64 &&
        draft.forkName === draft.forkName.trim() &&
        typeof draft.forkStartDate === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(draft.forkStartDate)
      : draft.forkName === null && draft.forkStartDate === null)
  )
}
