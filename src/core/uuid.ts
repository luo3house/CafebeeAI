/**
 * uuid generation: 32 lowercase chars, no dashes. No dependency on native crypto (not guaranteed under Hermes).
 */
export function uuid32(): string {
  // @ts-ignore Hermes may lack crypto.getRandomValues
  const cryptoObj = globalThis.crypto as { getRandomValues?: (arr: Uint8Array) => Uint8Array } | undefined
  const bytes = new Uint8Array(32)
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let s = ""
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0")
  }
  return s.toLowerCase()
}

/** Default project uuid: all zeros (cannot be deleted/renamed) */
export const DEFAULT_PROJECT_ID = "0".repeat(32)

export function isDefaultProjectId(id: string): boolean {
  return id === DEFAULT_PROJECT_ID
}