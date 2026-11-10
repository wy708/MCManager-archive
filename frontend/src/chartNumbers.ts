// Short axis labels only. Tooltips and the accessible value lists retain exact values.
export function compactChartNumber(value: number): string {
  const magnitude = Math.abs(value)
  const unit = magnitude >= 1e8 ? [1e8, '亿'] as const : magnitude >= 1e4 ? [1e4, '万'] as const : magnitude >= 1e3 ? [1e3, '千'] as const : undefined
  return unit ? `${Number((value / unit[0]).toFixed(1))}${unit[1]}` : String(Number(value.toFixed(2)))
}
