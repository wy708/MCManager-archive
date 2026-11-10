import { t } from './i18n'
import {
  Activity,
  Bot,
  Box,
  CalendarDays,
  HardDrive,
  Home,
  Leaf,
  Map,
  Server,
  Settings,
  Terminal,
  Users,
} from '@lucide/vue'
import type { WorkspaceSection } from './workspaceRoute'

// One catalog drives navigation, feature search and page introductions.
export const navigation = [
  {
    key: 'overview',
    label: t('m0175'),
    group: t('m0176'),
    icon: Home,
    description: t('m0177'),
    keywords: t('m0178'),
  },
  {
    key: 'servers',
    label: t('m0044'),
    group: t('m0176'),
    icon: Server,
    description: t('m0179'),
    keywords: t('m0180'),
  },
  {
    key: 'players',
    label: t('m0073'),
    group: t('m0176'),
    icon: Users,
    description: t('m0181'),
    keywords: t('m0182'),
  },
  {
    key: 'activity',
    label: t('m0183'),
    group: t('m0176'),
    icon: Activity,
    description: t('m0184'),
    keywords: t('m0185'),
  },
  {
    key: 'map',
    label: t('m0186'),
    group: t('m0176'),
    icon: Map,
    description: t('m0187'),
    keywords: t('m0188'),
  },
  {
    key: 'projects',
    label: t('m0189'),
    group: t('m0190'),
    icon: Box,
    description: t('m0191'),
    keywords:
      t('m0192'),
  },
  {
    key: 'exploration',
    label: t('m0193'),
    group: t('m0190'),
    icon: Leaf,
    description: t('m0194'),
    keywords: t('m0195'),
  },
  {
    key: 'reports',
    label: t('m0196'),
    group: t('m0190'),
    icon: CalendarDays,
    description: t('m0197'),
    keywords: t('m0198'),
  },
  {
    key: 'runtime',
    label: t('m0199'),
    group: t('m0200'),
    icon: Activity,
    description: t('m0201'),
    keywords: t('m0202'),
  },
  {
    key: 'console',
    label: t('m0203'),
    group: t('m0200'),
    icon: Terminal,
    description: t('m0204'),
    keywords: t('m0205'),
    admin: true,
  },
  {
    key: 'agents',
    label: t('m0206'),
    group: t('m0200'),
    icon: Bot,
    description: t('m0207'),
    keywords: t('m0208'),
    admin: true,
  },
  {
    key: 'backups',
    label: t('m0209'),
    group: t('m0200'),
    icon: HardDrive,
    description: t('m0210'),
    keywords: t('m0211'),
    admin: true,
  },
  {
    key: 'accounts',
    label: t('m0212'),
    group: t('m0213'),
    icon: Users,
    description: t('m0214'),
    keywords: t('m0215'),
    admin: true,
  },
  {
    key: 'settings',
    label: t('m0216'),
    group: t('m0213'),
    icon: Settings,
    description: t('m0217'),
    keywords: t('m0218'),
    admin: true,
  },
] satisfies {
  key: WorkspaceSection
  label: string
  group: string
  icon: unknown
  description: string
  keywords: string
  admin?: boolean
}[]
export const navigationGroups = [t('m0176'), t('m0190'), t('m0200'), t('m0213')]
export const visibleNavigation = (admin: boolean) =>
  navigation.filter((item) => !('admin' in item && item.admin) || admin)
