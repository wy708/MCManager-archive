import { t } from './i18n'
export interface Project {
  id: string; serverId: string; serverName: string; name: string; creator: string; dimension: string;
  minX: number; maxX: number; minZ: number; maxZ: number; revision: number; status: string; publicUrl: string;
}
export interface ProjectDetail {
  project: Project; revision: number; startedAt: string; endedAt: string | null;
  statistics: { materials: { block: string; operation: string; count: string }[]; contributors: { name: string; contributorId: string; operation: string; count: string }[] };
  mapAt: string | null; mapMetadata: { tileCoverageComplete?: boolean; truncated?: boolean; layer?: string } | null;
  mapAvailable: boolean; revisions: number[]; notice: string;
}
export const statusName = (status: string) => ({ ACTIVE: t('m0219'), COMPLETE: t('m0064'), SAVING: t('m0220') }[status] ?? status)
export const blockIcon = (block: string) => `/project-icons/${encodeURIComponent(block.replace(':', '__'))}.png`
