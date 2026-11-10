import zh from './locales/zh-CN.json'
import en from './locales/en.json'
import serverMessages from './locales/server-messages.json'
import { interpolate, resolveLocale } from './i18n-core.mjs'

export const languageStorageKey = 'mcmanager.language'
let saved: string | null = null
try { saved = localStorage.getItem(languageStorageKey) } catch { /* Storage can be disabled. */ }
const queryLanguage = typeof location === 'undefined' ? null : new URL(location.href).searchParams.get('lang')
export const locale = resolveLocale(queryLanguage ?? saved, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language)
export const formatLocale = locale === 'en' ? 'en-US' : 'zh-CN'
export const weekdays = locale === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : [...'一二三四五六日']
const messages: Record<string, string> = locale === 'en' ? en : zh

export function t(key: keyof typeof zh, values: readonly unknown[] = []): string {
  return interpolate(messages[key] ?? zh[key], values)
}

// Use only for platform-owned diagnostics and metric labels, never player content.
export function systemMessage(value: string): string {
  const key = (serverMessages as Record<string, string>)[value]
  return locale === 'en' && key ? (en as Record<string, string>)[key] ?? value : value
}

export function localizedUrl(value: string): string {
  const url = new URL(value, location.origin)
  url.searchParams.set('lang', locale)
  return url.href
}

export function changeLanguage(value: string) {
  if (value !== 'en' && value !== 'zh-CN') return
  try { localStorage.setItem(languageStorageKey, value) } catch { /* URL keeps the choice when storage is unavailable. */ }
  const url = new URL(location.href)
  url.searchParams.set('lang', value)
  // A full navigation refreshes module-level chart labels and preserves route, filters and hash.
  location.assign(url.href)
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = locale
  document.title = locale === 'en' ? 'MCManager · Server Archive' : 'MCManager · 服务器纪念档案'
}
