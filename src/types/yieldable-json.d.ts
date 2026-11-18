declare module "yieldable-json" {
  interface YieldableJson {
    stringifyAsync(
      value: unknown,
      callback: (err: Error | null, result?: string) => void
    ): void
    parseAsync(
      text: string,
      callback: (err: Error | null, result?: unknown) => void
    ): void
  }
  const yj: YieldableJson
  export = yj
}
