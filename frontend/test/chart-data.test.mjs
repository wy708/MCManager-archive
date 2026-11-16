import test from 'node:test'
import assert from 'node:assert/strict'
import { calendarDays, relativeActivity, heightBands, byteRateUnit } from '../src/chartData.ts'

test('daily charts retain gaps and seven days across month and year boundaries', () => {
  assert.deepEqual(calendarDays('2025-12-28', '2026-01-03'), ['2025-12-28','2025-12-29','2025-12-30','2025-12-31','2026-01-01','2026-01-02','2026-01-03'])
  assert.deepEqual(calendarDays('2026-01-03', '2026-01-03'), ['2026-01-03'])
  assert.deepEqual(calendarDays('', ''), [])
})

test('activity comparisons distinguish missing samples from recorded zero', () => {
  assert.deepEqual(relativeActivity([10, null, 0, 20]), [50, null, 0, 100])
  assert.deepEqual(relativeActivity([null, 0]), [null, 0])
  assert.deepEqual(relativeActivity([123]), [100])
})

test('height charts retain empty bands including negative heights', () => {
  assert.deepEqual(heightBands([-16, 8]), [-16, -8, 0, 8])
  assert.deepEqual(heightBands([64, 64]), [64])
  assert.deepEqual(heightBands([]), [])
})

test('network curves share a readable unit without rounding or replacing missing samples', () => {
  assert.deepEqual(byteRateUnit([null, 512]), {divisor: 1, unit: 'B/s'})
  assert.deepEqual(byteRateUnit([0, 2048]), {divisor: 1024, unit: 'KiB/s'})
  assert.deepEqual(byteRateUnit([0, 2097152]), {divisor: 1048576, unit: 'MiB/s'})
})
