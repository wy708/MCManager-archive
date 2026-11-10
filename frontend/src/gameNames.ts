import catalog from './bedrock-names.zh-CN.json'
import { activityIdleDuration, dimensions } from './statistics'

export type GameNameKind = 'block' | 'item' | 'entity' | 'dimension' | 'death' | 'subject'

const blocks: Record<string, string> = catalog.blocks
const items: Record<string, string> = catalog.items
const entities: Record<string, string> = catalog.entities
const causes: Record<string, string> = {
  none: '未记录死因',
  unknown: '未知死因',
  override: '强制伤害',
  contact: '接触伤害',
  entity_attack: '实体攻击',
  projectile: '投射物',
  suffocation: '窒息',
  fall: '摔落',
  fire: '火焰',
  fire_tick: '持续燃烧',
  lava: '熔岩',
  drowning: '溺水',
  block_explosion: '方块爆炸',
  entity_explosion: '实体爆炸',
  void: '坠入虚空',
  self_destruct: '自我摧毁',
  magic: '魔法伤害',
  wither: '凋零效果',
  starve: '饥饿',
  anvil: '坠落的铁砧',
  thorns: '荆棘反伤',
  falling_block: '坠落的方块',
  piston: '活塞挤压',
  fly_into_wall: '飞行撞墙',
  magma: '岩浆块',
  fireworks: '烟花爆炸',
  lightning: '闪电',
  charging: '冲锋撞击',
  temperature: '温度伤害',
  freezing: '冻伤',
  stalactite: '坠落的钟乳石',
  stalagmite: '撞上石笋',
  ram_attack: '冲撞攻击',
  sonic_boom: '音波攻击',
  campfire: '营火',
  soul_campfire: '灵魂营火',
  mace_smash: '重锤重击',
}

export const unknownGameNames: Record<GameNameKind, string> = {
  block: '未收录的方块',
  item: '未收录的物品',
  entity: '未收录的实体',
  dimension: '自定义维度',
  death: '未收录的死因',
  subject: '未收录的分类对象',
}

function lookup(names: Record<string, string>, key: string) {
  return Object.hasOwn(names, key) ? names[key] : undefined
}

export function gameName(raw: string, kind: GameNameKind): string | undefined {
  if (raw === 'all') return '总计'
  if (kind === 'subject' && raw === 'archive:active') return '活跃时段'
  if (kind === 'death') return lookup(causes, raw)
  if (kind === 'dimension') {
    const index = /^bedrock:dimension_(-?\d+)$/.exec(raw)?.[1]
    return index === undefined ? lookup(dimensions, raw) : `维度 ${index}`
  }
  if (!raw.startsWith('minecraft:')) return undefined
  const key = raw.slice('minecraft:'.length)
  if (kind === 'block') return lookup(blocks, key)
  if (kind === 'item') return lookup(items, key) ?? lookup(blocks, key)
  if (kind === 'entity') return lookup(entities, key)
  return lookup(blocks, key) ?? lookup(items, key) ?? lookup(entities, key)
}

export function behaviorSubjectKind(metric: string): GameNameKind {
  if (metric.startsWith('blocks.') || metric.startsWith('crops.')) return 'block'
  if (metric === 'dimension.visits') return 'dimension'
  if (metric === 'deaths') return 'death'
  if (metric === 'fishing.retrievals' || /^(kills|breeding|travel)\./.test(metric)) return 'entity'
  if (/^(items|fishing|crafting|villager)\./.test(metric)) return 'item'
  return 'subject'
}

const algorithms: Record<string, string> = {
  native: '原生记录',
  'native-action-state': '玩家动作状态',
  'native-breeding-result': '繁殖结果',
  'native-crafting-commit': '合成确认',
  'native-crop-state': '作物生长状态',
  'native-dimension': '维度切换',
  'native-fishing-result': '钓鱼结果',
  'native-item-confirmed': '物品使用确认',
  'native-item-inventory': '背包变化确认',
  'native-item-request': '物品使用请求',
  'native-kill-source': '击杀来源归属',
  'native-level-observed': '等级观测',
  'native-mining': '方块挖掘确认',
  'native-motion-sample': '移动距离估算',
  'native-placement': '方块放置确认',
  'native-trade-commit': '交易确认',
}

export function behaviorAlgorithmName(raw: string) {
  const idle = activityIdleDuration(raw)
  if (idle) return `活跃时间估算（挂机阈值 ${idle}）`
  const match = /^(.*)-v(\d+)$/.exec(raw)
  if (!match) return '其他统计口径'
  const [, key = '', version] = match
  const label = lookup(algorithms, key)
  return label ? `${label} · 第 ${version} 版` : '其他统计口径'
}
