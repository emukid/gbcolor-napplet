import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source = await readFile('src/main.ts', 'utf8');
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = ['runtimeRequest', 'getFilesystemInfo', 'readFilesystemBytes'];
const code = ts.transpileModule(tree.statements.filter(n => names.includes(n.name?.text)).map(n => n.getText(tree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let now = 0, infos = 0;
const calls = [];
const file = new Uint8Array(2 * 1024 * 1024);
const scope = {
  runtimeRequests: Promise.resolve(), lastRuntimeRequest: 0, filesystemInfo: undefined,
  Date: { now: () => now }, window: { setTimeout: (fn, delay) => { now += delay; fn(); } }, Uint8Array,
  base64ToBytes: data => new Uint8Array(Buffer.from(data, 'base64')),
  fs: {
    info: async () => { infos++; calls.push(now); return { limits: { maxReadBytes: 1024 * 1024 } }; },
    read: async (path, { offset, length }) => {
      calls.push(now); assert.equal(length, 1024 * 1024);
      const bytes = file.slice(offset, offset + length);
      return { offset, bytesRead: bytes.length, data: Buffer.from(bytes).toString('base64'), eof: offset + bytes.length === file.length };
    },
  },
};
vm.createContext(scope); vm.runInContext(code, scope);
await Promise.all([scope.getFilesystemInfo(), scope.getFilesystemInfo()]);
assert.equal((await scope.readFilesystemBytes('/rom.gbc', file.length)).length, file.length);
assert.equal(infos, 1, 'Share filesystem limits across callers and chunks');
assert.equal(calls.length, 3, '2 MB ROM should require only two reads when permitted');
assert.ok(calls.every((time, i) => !i || time - calls[i - 1] >= 300), 'Runtime calls must be paced');
const restore = tree.statements.find(n => n.name?.text === 'restoreLastGame').getText(tree);
assert.ok(restore.includes('findCachedRom(saved.sha256)'));
assert.ok(!restore.includes('refreshFilesystemRoms'));
console.log('Runtime budget passed: shared info, large bounded reads, paced requests, targeted startup cache lookup.');
