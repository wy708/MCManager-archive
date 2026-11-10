import { t, locale } from './i18n'
// Short axis labels only. Tooltips and the accessible value lists retain exact values.
export function compactChartNumber(value: number): string {
  if (locale === 'en') return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  const magnitude = Math.abs(value)
  const unit = magnitude >= 1e8 ? [1e8, t('m0107')] as const : magnitude >= 1e4 ? [1e4, t('m0108')] as const : magnitude >= 1e3 ? [1e3, t('m0109')] as const : undefined
  return unit ? `${Number((value / unit[0]).toFixed(1))}${unit[1]}` : String(Number(value.toFixed(2)))
}
