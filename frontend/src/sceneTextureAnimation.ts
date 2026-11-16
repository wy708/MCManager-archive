export interface TextureFrame { frame: number; next: number; mix: number }

/** Sample the original animation timeline, returning only changes to its pixels. */
export function textureAnimation(frames: readonly number[], interpolate: boolean) {
  const ends: number[] = []
  let total = 0
  for (let i = 1; i < frames.length; i += 2) { total += frames[i]!; ends.push(total) }
  let previous: TextureFrame | undefined
  return (time: number): TextureFrame | undefined => {
    const tick = Math.floor(time / 50) % total
    let low = 0, high = ends.length - 1
    while (low < high) {
      const middle = (low + high) >>> 1
      if (tick < ends[middle]!) high = middle
      else low = middle + 1
    }
    const frame = frames[low * 2]!, following = frames[(low * 2 + 2) % frames.length]!
    const elapsed = tick - (low ? ends[low - 1]! : 0)
    const mix = interpolate && frame !== following ? elapsed / frames[low * 2 + 1]! : 0
    const next = mix ? following : frame
    if (previous?.frame === frame && previous.next === next && previous.mix === mix) return
    return previous = { frame, next, mix }
  }
}
