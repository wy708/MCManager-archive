import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import minecraftData from '../collector/qa/node_modules/minecraft-data/index.js';

const version = '1.26.51';
const data = minecraftData('bedrock_' + version);
assert.equal(data.version.minecraftVersion, version);
const gameRoot = process.argv[2] ?? '.tools/game-qa-26.51.8';
const resourcePacks = path.join(gameRoot, 'resource_packs');

function names(locale) {
  const result = new Map();
  for (const pack of ['vanilla', 'chemistry']) {
    const lang = readFileSync(path.join(resourcePacks, pack, 'texts', locale + '.lang'), 'utf8');
    for (const line of lang.split(/\r?\n/)) {
      const match = /^(tile|item|entity)\.([^=]+)\.name=(.*)$/.exec(line.trim());
      if (match) result.set(match[1] + '.' + match[2], match[3].split(/\t| #/)[0].trim());
    }
  }
  return result;
}

const chinese = names('zh_CN');
const english = names('en_US');
const normalize = (name) => name.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
const isChinese = (name) => /[\u3400-\u9fff]/.test(name ?? '');

// Modern resource IDs can still refer to older language keys. Some technical
// IDs have no inventory label, so give those a distinct descriptive name.
const blockAliases = {
  tnt: 'TNT 炸药', moving_block: '活塞移动方块', deprecated_anvil: '旧版铁砧',
  info_update: '更新占位方块', info_update2: '更新占位方块 2',
  reserved6: '保留方块 6', client_request_placeholder_block: '客户端请求占位方块',
  element_constructor: '元素构造器', compound_creator: '化合物创建器',
  material_reducer: '材料分解器', lab_table: '实验台', chemical_heat: '化学热源',
  underwater_tnt: '水下 TNT 炸药', underwater_torch: '水下火把',
  colored_torch_red: '红色火把', colored_torch_green: '绿色火把',
  colored_torch_blue: '蓝色火把', colored_torch_purple: '紫色火把',
  colored_torch_rg: '红绿火把', colored_torch_bp: '蓝紫火把',
  deprecated_purpur_block_1: '旧版紫珀块 1', deprecated_purpur_block_2: '旧版紫珀块 2',
  infested_mossy_stone_bricks: '虫蚀苔石砖', infested_cracked_stone_bricks: '虫蚀裂纹石砖',
  infested_chiseled_stone_bricks: '虫蚀錾制石砖',
  petrified_oak_slab: '石化橡木台阶', petrified_oak_double_slab: '石化橡木双层台阶',
  stone_block_slab: '石质台阶', stone_block_slab2: '石质台阶 2',
  stone_block_slab3: '石质台阶 3', stone_block_slab4: '石质台阶 4',
  double_stone_block_slab: '石质双层台阶', double_stone_block_slab2: '石质双层台阶 2',
  double_stone_block_slab3: '石质双层台阶 3', double_stone_block_slab4: '石质双层台阶 4',
  coral_block: '珊瑚块', coral_fan: '珊瑚扇', coral_fan_dead: '失活的珊瑚扇', coral: '珊瑚',
  sapling: '树苗', leaves2: '树叶（旧分类）', log2: '原木（旧分类）',
  concrete: '混凝土', concrete_powder: '混凝土粉末', wood: '木头',
  stained_glass: '染色玻璃', stained_glass_pane: '染色玻璃板',
  chemistry_table: '化学工作台',
};
const itemAliases = {
  'item.reeds': '甘蔗', 'item.frame': '物品展示框',
  bundle: '收纳袋', potion: '药水', splash_potion: '喷溅药水', lingering_potion: '滞留药水',
  compound: '化合物', medicine: '药剂', rapid_fertilizer: '超能肥料',
  balloon: '气球', sparkler: '仙女棒', glow_stick: '荧光棒',
  chest_boat: '运输船', boat: '船', skull: '头颅', dye: '染料',
};
const entityAliases = {
  npc: '非玩家角色', chalkboard: '黑板', balloon: '气球', ice_bomb: '冰弹',
  item_frame: '物品展示框', glow_item_frame: '荧光物品展示框',
};
const colors = {
  white: '白色', orange: '橙色', magenta: '品红色', light_blue: '淡蓝色', yellow: '黄色',
  lime: '黄绿色', pink: '粉红色', gray: '灰色', light_gray: '淡灰色', cyan: '青色',
  purple: '紫色', blue: '蓝色', brown: '棕色', green: '绿色', red: '红色', black: '黑色',
};

function catalog(rows, prefixes, aliases, fallback = {}) {
  const byEnglish = new Map();
  for (const [key, englishName] of english) {
    const label = chinese.get(key);
    if (!prefixes.includes(key.split('.', 1)[0]) || !isChinese(label)) continue;
    const lookup = normalize(englishName);
    if (!byEnglish.has(lookup)) byEnglish.set(lookup, new Set());
    byEnglish.get(lookup).add(label);
  }

  const result = { ...aliases };
  // Also carry explicit locale names for older IDs that may already be stored
  // in archives. Variant language keys are resolved through the registry below.
  const primary = prefixes[0] + '.';
  for (const [key, label] of chinese) {
    const name = key.slice(primary.length);
    if (key.startsWith(primary) && /^[a-z0-9_]+$/.test(name) && isChinese(label))
      result[name] = aliases[name] ?? label;
  }
  for (const {name, displayName} of rows) {
    const exact = prefixes.map(prefix => chinese.get(prefix + '.' + name)).find(isChinese);
    const matches = byEnglish.get(normalize(displayName));
    const matched = matches?.size === 1 ? [...matches][0] : undefined;
    result[name] = aliases[name] ?? exact ?? fallback[name] ?? matched;
  }
  // Double slabs and chemistry variants often lack a separate localized key.
  for (const {name} of rows) {
    if (result[name]) continue;
    const hardGlass = /^hard_(?:(.+)_)?(glass(?:_pane)?)$/.exec(name);
    const bundle = /^(.+)_bundle$/.exec(name);
    const light = /^light_block_(\d+)$/.exec(name);
    const element = /^element_(\d+)$/.exec(name);
    const slab = name.replace('_double_slab', '_slab');
    if (hardGlass) result[name] = '硬化' + (colors[hardGlass[1]] ?? (hardGlass[1] === 'stained' ? '染色' : '')) +
        (hardGlass[2] === 'glass_pane' ? '玻璃板' : '玻璃');
    else if (bundle && colors[bundle[1]]) result[name] = colors[bundle[1]] + '收纳袋';
    else if (light) result[name] = '光源方块（亮度 ' + light[1] + '）';
    else if (element) result[name] = '元素 ' + element[1];
    else if (slab !== name && (result[slab] || fallback[slab]))
      result[name] = '双层' + (result[slab] ?? fallback[slab]);
  }
  const missing = rows.map(({name}) => name).filter(name => !result[name]);
  assert.deepEqual(missing, [], 'Review Bedrock IDs without Chinese names');
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

const blocks = catalog(data.blocksArray, ['tile', 'item'], blockAliases);
const items = catalog(data.itemsArray, ['item', 'tile'], itemAliases, blocks);
const entities = catalog(data.entitiesArray, ['entity'], entityAliases);
// Shared names for block items are stored once.
for (const name of Object.keys(items)) if (items[name] === blocks[name]) delete items[name];
const output = { version, blocks, items, entities };
writeFileSync(new URL('../frontend/src/bedrock-names.zh-CN.json', import.meta.url),
  JSON.stringify(output, null, 2) + '\n');
console.log({version, blocks: data.blocksArray.length, items: data.itemsArray.length, entities: data.entitiesArray.length});
