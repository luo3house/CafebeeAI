/**
 * Async JSON encoding via yieldable-json (generator-based incremental stringify that yields through
 * setImmediate every 512*intensity nodes), so large payloads no longer block the JS thread in one piece.
 * Hard rules (verified against yieldable-json@2.1.0 source):
 * - ONLY stringifyAsync. parseAsync touches `Buffer.isBuffer` at entry - Hermes has no Buffer global, it would crash.
 *   Decoding stays on native JSON.parse everywhere.
 * - Calls MUST be strictly serialized: the library keeps MODULE-LEVEL mutable state (counter / temp / objStack);
 *   two interleaved stringifyAsync runs corrupt each other (false "Circular Structure Detected" / broken escapes).
 *   Hence the promise chain below - one in-flight run at a time, failures don't poison the chain.
 * - The value must not be mutated while a run is in flight (library README). Callers therefore hand in an
 *   immutable snapshot (e.g. a valtio derived snapshot), never a live proxy/raw object being streamed into.
 */
import yj from "yieldable-json"

let chain: Promise<unknown> = Promise.resolve()

export function stringifyAsyncSafe(value: unknown): Promise<string> {
  const run = () =>
    new Promise<string>((resolve, reject) => {
      yj.stringifyAsync(value, (err, result) => {
        if (err) reject(err)
        else resolve(result ?? "")
      })
    })
  const task = chain.then(run, run)
  chain = task.then(
    () => undefined,
    () => undefined
  )
  return task
}
