import { t, locale } from './i18n'
import chineseCatalog from './bedrock-names.zh-CN.json'
import englishCatalog from './bedrock-names.en.json'
const catalog = locale === 'en' ? englishCatalog : chineseCatalog
import { activityIdleDuration, dimensions } from './statistics'

export type GameNameKind = 'block' | 'item' | 'entity' | 'dimension' | 'death' | 'subject'

const blocks: Record<string, string> = catalog.blocks
const items: Record<string, string> = catalog.items
const entities: Record<string, string> = catalog.entities
const causes: Record<string, string> = {
  none: t('m0110'),
  unknown: t('m0111'),
  override: t('m0112'),
  contact: t('m0113'),
  entity_attack: t('m0114'),
  projectile: t('m0115'),
  suffocation: t('m0116'),
  fall: t('m0117'),
  fire: t('m0118'),
  fire_tick: t('m0119'),
  lava: t('m0120'),
  drowning: t('m0121'),
  block_explosion: t('m0122'),
  entity_explosion: t('m0123'),
  void: t('m0124'),
  self_destruct: t('m0125'),
  magic: t('m0126'),
  wither: t('m0127'),
  starve: t('m0128'),
  anvil: t('m0129'),
  thorns: t('m0130'),
  falling_block: t('m0131'),
  piston: t('m0132'),
  fly_into_wall: t('m0133'),
  magma: t('m0134'),
  fireworks: t('m0135'),
  lightning: t('m0136'),
  charging: t('m0137'),
  temperature: t('m0138'),
  freezing: t('m0139'),
  stalactite: t('m0140'),
  stalagmite: t('m0141'),
  ram_attack: t('m0142'),
  sonic_boom: t('m0143'),
  campfire: t('m0144'),
  soul_campfire: t('m0145'),
  mace_smash: t('m0146'),
}

export const unknownGameNames: Record<GameNameKind, string> = {
  block: t('m0147'),
  item: t('m0148'),
  entity: t('m0149'),
  dimension: t('m0150'),
  death: t('m0151'),
  subject: t('m0152'),
}

function lookup(names: Record<string, string>, key: string) {
  return Object.hasOwn(names, key) ? names[key] : undefined
}

export function gameName(raw: string, kind: GameNameKind): string | undefined {
  if (raw === 'all') return t('m0153')
  if (kind === 'subject' && raw === 'archive:active') return t('m0154')
  if (kind === 'death') return lookup(causes, raw)
  if (kind === 'dimension') {
    const index = /^bedrock:dimension_(-?\d+)$/.exec(raw)?.[1]
    return index === undefined ? lookup(dimensions, raw) : t('m0155', [index])
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
  native: t('m0156'),
  'native-action-state': t('m0157'),
  'native-breeding-result': t('m0158'),
  'native-crafting-commit': t('m0159'),
  'native-crop-state': t('m0160'),
  'native-dimension': t('m0161'),
  'native-fishing-result': t('m0162'),
  'native-item-confirmed': t('m0163'),
  'native-item-inventory': t('m0164'),
  'native-item-request': t('m0165'),
  'native-kill-source': t('m0166'),
  'native-level-observed': t('m0167'),
  'native-mining': t('m0168'),
  'native-motion-sample': t('m0169'),
  'native-placement': t('m0170'),
  'native-trade-commit': t('m0171'),
}

export function behaviorAlgorithmName(raw: string) {
  const idle = activityIdleDuration(raw)
  if (idle) return t('m0172', [idle])
  const match = /^(.*)-v(\d+)$/.exec(raw)
  if (!match) return t('m0173')
  const [, key = '', version] = match
  const label = lookup(algorithms, key)
  return label ? t('m0174', [label, version]) : t('m0173')
}
