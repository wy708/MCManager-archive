import { onScopeDispose, ref, shallowRef, watch, type WatchSource } from 'vue'
import { failure } from './statistics'

export function useResource<T>(
  source: WatchSource<unknown>,
  loader: (signal: AbortSignal) => Promise<T>,
  onError: (error: unknown) => void,
  retainOnRefresh = false,
) {
  const data = shallowRef<T | null>(null)
  const busy = ref(false)
  const error = ref('')
  let controller: AbortController | undefined
  let version = 0
  async function refresh() {
    const current = ++version
    controller?.abort()
    controller = new AbortController()
    busy.value = true
    error.value = ''
    if (!retainOnRefresh) data.value = null
    try {
      const result = await loader(controller.signal)
      if (current === version) data.value = result
    } catch (ex) {
      if (current === version && !(ex instanceof DOMException && ex.name === 'AbortError')) {
        error.value = failure(ex)
        onError(ex)
      }
    } finally {
      if (current === version) busy.value = false
    }
  }
  watch(
    source,
    () => {
      data.value = null
      void refresh()
    },
    { immediate: true },
  )
  onScopeDispose(() => {
    version++
    controller?.abort()
  })
  return { data, busy, error, refresh }
}
