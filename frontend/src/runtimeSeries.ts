export type RuntimeMetric = 'tps' | 'cpuPercent' | 'memoryMiB' | 'players' | 'maxTickIntervalMillis' | 'hostCpuPercent' | 'hostMemoryUsedPercent' | 'hostNetworkReceiveBps' | 'hostNetworkSendBps'
type Point = { at: string } & Partial<Record<RuntimeMetric, number | null>>
type Report = {
  from: string
  to: string
  bucketSeconds: number
  points: Point[]
  events: {at: string; type: string}[]
}

// Sampling is approximate, not aligned to UTC buckets. A skipped 10-second
// bucket is normal when uploads take 11 seconds. Plot only saved measurements;
// retain explicit unknown values and real gaps without inventing samples.
export function runtimeSeries(report: Report, key: RuntimeMetric): [number, number | null][] {
  if (!report.points.length) return []
  const step = report.bucketSeconds * 1000
  const to = Date.parse(report.to)
  const from = Math.max(Date.parse(report.from), Math.min(Date.parse(report.points[0]!.at) - step, to - 300000))
  const values: [number, number | null][] = [[Math.floor(from / step) * step, null]]
  const breaks = report.events.filter(e => e.type === 'STOPPED' || e.type === 'RESTART').map(e => Date.parse(e.at))
  const gapLimit = Math.max(45000, step * 1.5)
  let previous: number | undefined
  for (const point of report.points) {
    const at = Date.parse(point.at)
    if (previous !== undefined && (at - previous > gapLimit || breaks.some(t => t > previous! && t <= at))) {
      values.push([previous + (at - previous) / 2, null])
    }
    values.push([at, point[key] ?? null])
    previous = at
  }
  if (previous !== undefined && to > previous) values.push([to, null])
  return values
}
