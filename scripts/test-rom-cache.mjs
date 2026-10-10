import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const source = await readFile('src/main.ts', 'utf8');
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = ['loadRomBytes', 'verifyRomHash', 'verifyRomByteCount', 'abortableRomLoad', 'ensureFilesystemDirectory', 'isRecord'];
const code = ts.transpileModule(tree.statements.filter(n => names.includes(n.name?.text)).map(n => n.getText(tree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const bytes = new Uint8Array([1, 2, 3]);
const hash = createHash('sha256').update(bytes).digest('hex');
let downloads = 0, reads = 0, corrupt = false, missing = false;
const local = { id: 'cached', sha256: hash, event: { id: 'event', pubkey: 'author' }, sources: [{ filesystemPath: '/cache/rom.gb', label: 'Filesystem', sha256: hash, bytes: 3 }] };
const rom = { id: 'published', sha256: hash, bytes: 3, event: local.event, sources: [{ url: 'remote', label: 'Remote' }] };
const scope = { runtimeRequest: operation => operation(), findCachedRom: async () => {}, Error, Blob, Uint8Array, AbortController, DOMException, Map, Set,
  pendingRomCaches: new Map(), filesystemRoms: new Map([[local.id, local]]), hasDomain: () => true,
  sha256Hex: async data => createHash('sha256').update(data).digest('hex'),
  readFilesystemBytes: async () => { reads++; if (missing) throw new Error('not-found'); return corrupt ? new Uint8Array([3, 2, 1]) : bytes; },
  resource: { bytes: async () => { downloads++; return new Blob([bytes]); } },
  decodeRomTransport: value => value, withTimeout: promise => promise, BLOSSOM_SERVERS: [], fs: {},
};
vm.createContext(scope); vm.runInContext(code, scope);
assert.equal((await scope.loadRomBytes(rom)).source, local.sources[0]);
assert.equal(downloads, 0, 'Published ROM must read the cache without a download');
await scope.loadRomBytes({ ...rom, sha256: undefined });
assert.equal(downloads, 0, 'Event identity should find a cached ROM without a published hash');
corrupt = true;
await scope.loadRomBytes(rom);
assert.equal(downloads, 1);
assert.equal(scope.filesystemRoms.size, 0, 'Invalid catalog entry must be removed so caching can repair it');
corrupt = false; missing = true;
scope.filesystemRoms.set(local.id, local);
await scope.loadRomBytes(rom);
assert.equal(downloads, 2);
missing = false;
let finish;
scope.pendingRomCaches.set(rom.id, new Promise(resolve => { finish = () => { scope.filesystemRoms.set(local.id, local); resolve(); }; }));
const pending = scope.loadRomBytes(rom);
await Promise.resolve();
assert.equal(downloads, 2);
finish(); await pending;
assert.equal(downloads, 2, 'Loading during a cache write must wait for the copy');
scope.pendingRomCaches.clear();
const controller = new AbortController(); controller.abort();
await assert.rejects(scope.loadRomBytes(rom, controller.signal), { name: 'AbortError' });
scope.fs.mkdir = async () => { throw new Error('already-exists'); };
scope.fs.stat = async () => ({ kind: 'directory' });
await scope.ensureFilesystemDirectory('/existing');
scope.fs.stat = async () => ({ kind: 'file' });
await assert.rejects(scope.ensureFilesystemDirectory('/file'), /already-exists/);
scope.fs.mkdir = async () => { throw new Error('permission-denied'); };
await assert.rejects(scope.ensureFilesystemDirectory('/denied'), /permission-denied/);
console.log('ROM cache passed: cache-first published loads, event identity, invalid/missing fallback, pending writes, cancellation, existing directory handling.');
