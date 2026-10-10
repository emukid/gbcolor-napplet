import { readFileSync } from 'node:fs';

// The pinned JS core's saveState/loadState use byte-only load/store mocks,
// truncating CPU registers. Capture its JS state directly instead.
export function coreSnapshot() {
  return {
    name: 'wasmboy-js-snapshot',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/wasmboy/dist/core/core.esm.js')) return;
      return code + '\n' + readFileSync(new URL('../src/core-snapshot-runtime.js', import.meta.url), 'utf8');
    },
  };
}
