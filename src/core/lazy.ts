export type LazyValue<T> = { (): T }

export const lazyInit = <T>(factory: () => T): LazyValue<T> => {
  const EMPTY = Symbol("empty")
  let value: T | typeof EMPTY = EMPTY
  return () => {
    if (value === EMPTY) value = factory()
    return value as T
  }
}
