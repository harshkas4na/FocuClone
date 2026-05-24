// Node 24 ESM loader hook that maps `import 'electron'` to a tiny stub so the
// main-process processor.js can be exercised headlessly.
import { fileURLToPath, pathToFileURL } from 'url'
import { resolve as pathResolve } from 'path'

const STUB_URL = pathToFileURL(pathResolve('./scripts/electron-stub-impl.mjs')).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: STUB_URL, format: 'module', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
