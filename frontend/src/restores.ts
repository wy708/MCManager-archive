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
  if (!value) return '未确认'
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return '未确认'
  if (amount < 1024) return amount.toLocaleString('zh-CN') + ' B'
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = amount / 1024,
    unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return size.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' ' + units[unit]
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
  DISABLED: '独立检查，关闭采集',
  CONTINUE: '继续原一期',
  FORK: '创建新一期',
}
export const restoreStates: Record<string, string> = {
  QUEUED: '等待执行',
  CLAIMED: '已领取',
  RUNNING: '正在准备文件',
  READY: '文件准备完成',
  FAILED: '已失败',
  UNCERTAIN: '结果待核实',
  CANCELLED: '已取消',
}
export const restoreDiagnostics: Record<string, string> = {
  DOWNLOAD_FAILED: '下载未完成，请检查执行端连接。',
  ARCHIVE_INVALID: '归档校验失败，不能作为完成结果。',
  DESTINATION_EXISTS: '目标目录已经存在，原目录没有被覆盖。',
  RESTORE_FAILED: '文件准备未完成，请检查执行端诊断。',
  EXECUTION_INTERRUPTED: '执行中断，现场保留，不会自动再次解包。',
  EXECUTION_EXPIRED: '执行租约过期，请核对原目录。',
  CREDENTIAL_CHANGED: '执行端凭据已轮换，请核对原结果。',
  ACCESS_REVOKED: '执行端已撤销，请核对原结果。',
  RUNNER_CHANGED: '运行实例已改变，请检查原尝试。',
  COLLECTOR_REJECTED: '目标采集凭据未通过确认。',
  OPERATOR_CANCELLED: '执行端已确认取消。',
  OPERATOR_RESOLVED: '已保存人工处理结果。',
  CLAIM_EXPIRED: '尚未开始的领取已过期，等待重新领取。',
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
