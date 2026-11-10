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
    label: '数据总览',
    group: '服务器管理',
    icon: Home,
    description: '看看伙伴们的足迹，也照顾好你的服务器。',
    keywords: '首页 概况 趋势 在线',
  },
  {
    key: 'servers',
    label: '服务器档案',
    group: '服务器管理',
    icon: Server,
    description: '为每一期世界建立档案，从这里进入玩家、地图和管理功能。',
    keywords: '添加 创建 服务器 编辑 封存 配置',
  },
  {
    key: 'players',
    label: '玩家统计',
    group: '服务器管理',
    icon: Users,
    description: '找到你的伙伴，回看在线时长、冒险足迹和历史记录。',
    keywords: '玩家 名字 在线 活跃 时长 排行 档案',
  },
  {
    key: 'activity',
    label: '行为统计',
    group: '服务器管理',
    icon: Activity,
    description: '查看挖掘、放置和物品使用，或从游玩会话里回看聊天。',
    keywords: '聊天 会话 物品 方块 放置 挖掘 死亡 坐标',
  },
  {
    key: 'map',
    label: '世界地图',
    group: '服务器管理',
    icon: Map,
    description: '俯瞰熟悉的风景，跳转坐标，打开可以分享的世界地图。',
    keywords: '地图 坐标 地形 位置 下界 地狱',
  },
  {
    key: 'projects',
    label: '施工工程',
    group: '世界建设与记录',
    icon: Box,
    description: '给建筑起个名字，记录建设者的贡献，留下地图与三维纪念。',
    keywords:
      '建筑 工程 创建 范围 贡献 三维 3d 模型 导出 下载 glb blender 导出模型 导出3d模型 三维预览',
  },
  {
    key: 'exploration',
    label: '世界故事馆',
    group: '世界建设与记录',
    icon: Leaf,
    description: '用有趣的图表，发现伙伴们的作息、协作与世界的变化。',
    keywords: '图表 热力图 材料 作息 协作 建设 回放 统计',
  },
  {
    key: 'reports',
    label: '服务器日报',
    group: '世界建设与记录',
    icon: CalendarDays,
    description: '一天的冒险，一页就能回顾。看看建设、采集和工程进展。',
    keywords: '日报 每日 昨天 今天 报告',
  },
  {
    key: 'runtime',
    label: '运行状况',
    group: '运行与维护',
    icon: Activity,
    description: '先看整台游戏主机，再看游戏进程，找到卡顿和资源占用的线索。',
    keywords: '性能 监控 主机 cpu 内存 磁盘 网络 tps 卡顿',
  },
  {
    key: 'console',
    label: '服务器控制台',
    group: '运行与维护',
    icon: Terminal,
    description: '查看游戏日志、发送命令，管理服务器的启动与停止。',
    keywords: '日志 命令 启动 停止 重启 终端',
    admin: true,
  },
  {
    key: 'agents',
    label: 'AI 助手',
    group: '运行与维护',
    icon: Bot,
    description: '连接小鲸鱼等 AI 助手，为它选择服务器和可使用的能力。',
    keywords: 'ai mcp dsh 小鲸鱼 机器人 密钥 授权 回复',
    admin: true,
  },
  {
    key: 'backups',
    label: '备份中心',
    group: '运行与维护',
    icon: HardDrive,
    description: '按服务器收好世界存档，设置每日备份，需要时再恢复。',
    keywords: '备份 存档 下载 恢复 自动 定时 每天 时间 计划 上传 每天备份 定时备份',
    admin: true,
  },
  {
    key: 'accounts',
    label: '账号管理',
    group: '账户与设置',
    icon: Users,
    description: '邀请伙伴进入工作台，按需要分配管理员或只读权限。',
    keywords: '账户 账号 创建 用户 密码 权限 只读',
    admin: true,
  },
  {
    key: 'settings',
    label: '平台设置',
    group: '账户与设置',
    icon: Settings,
    description: '连接游戏插件，查看上传状态，管理数据和存储空间。',
    keywords: '采集 插件 连接 上传 数据 保存 保留 清理 存储 密钥 配置',
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
export const navigationGroups = ['服务器管理', '世界建设与记录', '运行与维护', '账户与设置']
export const visibleNavigation = (admin: boolean) =>
  navigation.filter((item) => !('admin' in item && item.admin) || admin)
