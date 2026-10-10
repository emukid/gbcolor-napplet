import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile('src/main.ts', 'utf8');
const tree = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'orderedRomEntries');
assert.ok(fn);
const code = ts.transpileModule(fn.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const entry = (id, author, hash, time, name = 'Game') => ({ id, name, sha256: hash, event: { pubkey: author, created_at: time } });
const old = entry('old', 'a', 'ab'.repeat(32), 1);
const latest = entry('latest', 'a', 'AB'.repeat(32), 3, 'Renamed game');
const otherAuthor = entry('other-author', 'b', old.sha256, 2);
const otherRom = entry('other-rom', 'a', 'cd'.repeat(32), 2);
const unknown = entry('unknown', 'a', undefined, 2);
const unknown2 = entry('unknown2', 'a', undefined, 2);
const local = { id: 'local', sha256: old.sha256 };
const entries = [old, latest, otherAuthor, otherRom, unknown, unknown2];
function ordered(values) {
  const context = vm.createContext({ roms: new Map(values.map(rom => [rom.id, rom])), localRom: local, filesystemRoms: new Map(), romScope: 'global' });
  vm.runInContext(code, context);
  return Array.from(vm.runInContext('orderedRomEntries()', context), rom => rom.id);
}
const result = ordered(entries);
assert.deepEqual(result, ordered(entries.toReversed()));
assert.equal(result[0], 'local');
assert.ok(result.includes('latest'));
assert.ok(!result.includes('old'));
for (const id of ['other-author', 'other-rom', 'unknown', 'unknown2']) assert.ok(result.includes(id));
console.log('Cartridge dedup passed: author/hash identity, newest upload, changed title, distinct authors/ROMs, missing hashes, local ROM, query order.');
