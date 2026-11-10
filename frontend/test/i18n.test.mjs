import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { resolveLocale, interpolate } from '../src/i18n-core.mjs'

const read = name => JSON.parse(readFileSync(new URL('../src/' + name, import.meta.url), 'utf8'))
const zh = read('locales/zh-CN.json'), en = read('locales/en.json')

test('explicit language overrides browser language and invalid preferences fall back safely', () => {
  assert.equal(resolveLocale('en', 'zh-CN'), 'en')
  assert.equal(resolveLocale('zh-CN', 'en-US'), 'zh-CN')
  assert.equal(resolveLocale(null, 'en-GB'), 'en')
  assert.equal(resolveLocale(null, 'zh-TW'), 'zh-CN')
  assert.equal(resolveLocale('not-a-language', 'zh-CN'), 'zh-CN')
})

test('both catalogs cover every message and preserve all interpolation and chart tokens', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.keys(zh)) {
    assert.equal(typeof en[key], 'string', key)
    const tokens = value => (value.match(/\{[^{}]+\}/g) ?? []).sort()
    assert.deepEqual(tokens(en[key]), tokens(zh[key]), key)
    assert.ok(!/[\u3400-\u9fff]/.test(en[key]), key + ': untranslated text')
  }
})

test('interpolation supports reordered and repeated values without interpreting player content', () => {
  assert.equal(interpolate('{1} placed {0}, then {0}', ['<中文玩家>', 4]), '4 placed <中文玩家>, then <中文玩家>')
  assert.equal(interpolate('{0}/{1}/{2}', [0, false, null]), '0/false/')
  assert.equal(interpolate('{0} {1}', ['$&']), '$& {1}')
})

test('server diagnostics reference real translations and game IDs stay identical across languages', () => {
  for (const key of Object.values(read('locales/server-messages.json'))) assert.ok(Object.hasOwn(en, key), key)
  const english = read('bedrock-names.en.json'), chinese = read('bedrock-names.zh-CN.json')
  for (const kind of ['blocks', 'items', 'entities']) {
    assert.deepEqual(Object.keys(english[kind]).sort(), Object.keys(chinese[kind]).sort())
    for (const label of Object.values(english[kind])) assert.ok(!/[\u3400-\u9fff]/.test(label))
  }
  assert.equal(english.blocks.grass_block, 'Grass Block')
  assert.equal(english.items.diamond, 'Diamond')
})

test('standalone map uses explicit locale even when browser storage is blocked', () => {
  const source = readFileSync(new URL('../../map/viewer_language.js', import.meta.url), 'utf8')
  const context = vm.createContext({URL, location: {href:'https://example.invalid/maps/world/?lang=en'}, navigator:{language:'zh-CN'}, localStorage:{getItem(){throw new Error('blocked')}}})
  vm.runInContext(source, context)
  assert.equal(vm.runInContext("mcmanagerMapText('跳转','Go')", context), 'Go')
  context.location.href='https://example.invalid/maps/world/'
  assert.equal(vm.runInContext("mcmanagerMapText('跳转','Go')", context), '跳转')
})
