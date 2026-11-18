/**
 * Static image assets: Metro replaces `import x from "./a.png"` with the asset-registry id (a number),
 * which is what `Image source` expects. Declared here because react-native's own types ship no
 * wildcard module declarations and `tsconfig.json` keeps `types: []`.
 */
declare module "*.png" {
  const source: number
  export default source
}

declare module "*.jpg" {
  const source: number
  export default source
}
