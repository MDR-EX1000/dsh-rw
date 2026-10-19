// dsh-rw — the version of the code that is LOADED, not the one on disk.
//
// This exists because "installed 1.4.0 but the process still runs 1.1.0" is a
// real, repeated confusion: the plugin page reads the manifest from disk, while
// the host keeps the module it loaded at boot. Reporting the version from our
// own module gives every caller a way to see which one is actually running.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function readOwnVersion(): string {
  try {
    // lib/index.js → ../package.json; src/index.ts under vitest → ../package.json
    // as well, because both resolve to the package root.
    const here = dirname(fileURLToPath(import.meta.url))
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Version of the dsh-rw module currently loaded by the host process. */
export const PLUGIN_VERSION = readOwnVersion()
