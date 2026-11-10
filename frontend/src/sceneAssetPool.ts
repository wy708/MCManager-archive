/** Bounded transfers; cancel siblings on failure and settle them before disposal. */
export async function loadSceneAssets<T>(items: readonly T[], load: (item: T, signal: AbortSignal) => Promise<void>, signal?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  let cursor = 0
  let failed = false
  let failure: unknown
  async function worker() {
    try {
      while (cursor < items.length) {
        controller.signal.throwIfAborted()
        const item = items[cursor++]!
        await load(item, controller.signal)
      }
    } catch (error) {
      if (!failed) { failed = true; failure = error }
      controller.abort(error)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
    if (failed) throw failure
    controller.signal.throwIfAborted()
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
