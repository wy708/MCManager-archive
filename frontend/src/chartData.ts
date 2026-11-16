// Chart preparation preserves missing observations; an absent row is not a zero.
export function calendarDays(from: string, to: string): string[] {
  const start = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z')
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []
  return Array.from({ length: Math.min(366, Math.floor((end - start) / 86400000) + 1) },
    (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10))
}

export function relativeActivity(values: (number | null)[]): (number | null)[] {
  const peak = Math.max(0, ...values.map(value => value ?? 0))
  return values.map(value => value == null ? null : peak > 0 ? Math.round(value / peak * 1000) / 10 : 0)
}

export function heightBands(values: number[]): number[] {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return []
  const low = Math.floor(Math.min(...finite) / 8) * 8, high = Math.floor(Math.max(...finite) / 8) * 8
  return Array.from({ length: Math.min(512, (high - low) / 8 + 1) }, (_, i) => low + i * 8)
}

export function byteRateUnit(values: (number | null)[]): { divisor: number; unit: string } {
  const peak = Math.max(0, ...values.map(value => value ?? 0))
  return peak >= 1048576 ? { divisor: 1048576, unit: 'MiB/s' }
    : peak >= 1024 ? { divisor: 1024, unit: 'KiB/s' } : { divisor: 1, unit: 'B/s' }
}
