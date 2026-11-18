/**
 * useSnapshotCustom: keeps listening to a valtio proxy in the JS layer (subscribe), but only pushes a new
 * snapshot into React through a debounce(+maxWait) gate - "defer the UI update" so high-frequency proxy
 * writes (LLM stream flushes) stop saturating the JS thread that menus/typing need.
 * Semantics:
 * - leading/idle fire: first notification after >= maxWait of quiet flushes immediately (turn start /
 *   one-off writes never feel delayed);
 * - continuous notifications coalesce at debounceMs trailing intervals, capped so no update waits > maxWaitMs;
 * - `flushNow()` (checked per notification) bypasses the gate entirely - used for turn-end final states,
 *   deletions, anything not mid-stream;
 * - setValue with an unchanged reference bails out of the re-render (valtio caches child snapshots, so
 *   writes elsewhere in the subscribed tree don't wake this component).
 * The caller is responsible for re-mounting (React key) when the slice identity changes; this hook only
 * tracks changes underneath `target`.
 */
import { useEffect, useRef, useState } from "react"
import { subscribe } from "valtio"

export interface SnapshotCustomOptions {
  /** trailing coalescing interval while notifications keep arriving (default 150) */
  debounceMs?: number
  /** upper bound on how long any update may wait; also the idle window for the leading fire (default 300) */
  maxWaitMs?: number
  /** called on every notification; return true to flush immediately and skip the throttle (e.g. streaming already ended) */
  flushNow?: () => boolean
}

export function useSnapshotCustom<T>(
  target: object,
  read: () => T,
  options?: SnapshotCustomOptions
): T {
  const debounceMs = options?.debounceMs ?? 150
  const maxWaitMs = options?.maxWaitMs ?? 300

  const readRef = useRef(read)
  readRef.current = read
  const flushNowRef = useRef(options?.flushNow)
  flushNowRef.current = options?.flushNow

  const [value, setValue] = useState<T>(() => read())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastFire = 0
    const doFlush = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      lastFire = Date.now()
      setValue(readRef.current())
    }
    const unsub = subscribe(target, () => {
      if (flushNowRef.current?.()) {
        doFlush()
        return
      }
      const since = Date.now() - lastFire
      if (since >= maxWaitMs) {
        doFlush()
        return
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(doFlush, Math.min(debounceMs, maxWaitMs - since))
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [target, debounceMs, maxWaitMs])

  return value
}
