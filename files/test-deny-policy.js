'use strict';
// Unit tests of the access policy. No network, no npm packages: node files/test-deny-policy.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPolicy, parseEnv, TOOLS } = require('./deny-policy');

let passed = 0;
const ok = (name) => { passed++; console.log('PASS', name); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deny-policy-'));
const root = path.join(tmp, 'esphome');
const outside = path.join(tmp, 'outside');
const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'x.yaml'), 'outside');
w('a.yaml', 'a');
w('secrets.yaml', 'wifi_password: hunter2');
w('secrets.yaml.bak', 'old');
w('notes.txt', 'n');
w('sub/b.yaml', 'b');
w('sub/secrets.yaml', 'sub secret');
w('.esphome/build.txt', 'cache');
fs.symlinkSync(path.join(root, 'secrets.yaml'), path.join(root, 'innocent.yaml'));
fs.symlinkSync(outside, path.join(root, 'escape'));

const base = { roots: [root], denyNames: ['secrets*', '.esphome'] };
const p = createPolicy(base);
const R = (rel) => path.join(root, rel);

// ---- reads --------------------------------------------------------------
assert.ok(p.checkPath(R('a.yaml')).ok); ok('ordinary file is readable');
assert.ok(p.checkPath(R('sub/b.yaml')).ok); ok('file in a subdirectory is readable');
assert.ok(p.checkPath(root, { kind: 'dir' }).ok); ok('the root itself is listable');

for (const [label, rel] of [
  ['secrets.yaml', 'secrets.yaml'],
  ['upper case spelling', 'SECRETS.YAML'],
  ['mixed case spelling', 'Secrets.Yaml'],
  ['trailing dot', 'secrets.yaml.'],
  ['trailing space', 'secrets.yaml '],
  ['NTFS stream suffix', 'secrets.yaml::$DATA'],
  ['secrets*.bak variant', 'secrets.yaml.bak'],
  ['secrets in a subdirectory', 'sub/secrets.yaml'],
  ['dot-dot that lands on it', 'sub/../secrets.yaml'],
  ['.esphome directory', '.esphome'],
  ['file inside .esphome', '.esphome/build.txt'],
  ['8.3 short name', 'SECRET~1.YAM'],
  ['symlink that points to secrets.yaml', 'innocent.yaml'],
  ['fullwidth lookalike (NFKC)', 'ｓecrets.yaml'],
]) {
  const r = p.checkPath(R(rel));
  assert.strictEqual(r.ok, false, `${label} must be refused`);
  ok(`refused: ${label}`);
}

for (const [label, input] of [
  ['absolute path outside the root', path.join(outside, 'x.yaml')],
  ['dot-dot out of the root', R('../outside/x.yaml')],
  ['symlink out of the root', R('escape/x.yaml')],
  ['tilde path', '~/a.yaml'],
  ['NUL byte', R('a.yaml\0.txt')],
  ['empty string', ''],
  ['number', 42],
  ['null', null],
]) {
  assert.strictEqual(p.checkPath(input).ok, false, `${label} must be refused`);
  ok(`refused: ${label}`);
}

// ---- writes -------------------------------------------------------------
assert.ok(p.checkPath(R('new.yaml'), { write: true, kind: 'file' }).ok); ok('new file can be written');
assert.ok(p.checkPath(R('a.yaml'), { write: true, kind: 'file' }).ok); ok('existing file can be overwritten');
assert.ok(p.checkPath(R('newdir'), { write: true, kind: 'dir' }).ok); ok('new directory can be created');
assert.strictEqual(p.checkPath(R('secrets.yaml'), { write: true, kind: 'file' }).ok, false); ok('secrets.yaml cannot be overwritten');
assert.strictEqual(p.checkPath(R('Secrets.yaml'), { write: true, kind: 'file' }).ok, false); ok('other spelling cannot be created either');

// ---- tool calls ---------------------------------------------------------
let v = p.vetToolCall('read_text_file', { path: R('a.yaml') });
assert.ok(v.ok); ok('read_text_file on an allowed file passes');
assert.strictEqual(p.vetToolCall('read_text_file', { path: R('secrets.yaml') }).ok, false); ok('read_text_file on secrets.yaml is refused');
assert.strictEqual(p.vetToolCall('read_text_file', {}).ok, false); ok('missing path argument is refused');
assert.strictEqual(p.vetToolCall('read_text_file', { path: ['x'] }).ok, false); ok('array instead of string is refused');
assert.strictEqual(p.vetToolCall('read_text_file', [R('a.yaml')]).ok, false); ok('arguments as an array are refused');
assert.strictEqual(p.vetToolCall('delete_everything', { path: R('a.yaml') }).ok, false); ok('unknown tool is refused (fail closed)');
assert.strictEqual(p.vetToolCall('constructor', {}).ok, false); ok('prototype names are not tools');
assert.ok(p.vetToolCall('list_allowed_directories', undefined).ok); ok('list_allowed_directories needs no arguments');
assert.ok(p.vetToolCall('write_file', { path: R('new.yaml'), content: 'x' }).ok); ok('write_file on an allowed path passes');
assert.strictEqual(p.vetToolCall('write_file', { path: R('secrets.yaml'), content: 'x' }).ok, false); ok('write_file on secrets.yaml is refused');
assert.strictEqual(p.vetToolCall('edit_file', { path: R('secrets.yaml'), edits: [], dryRun: true }).ok, false); ok('edit_file dry run on secrets.yaml is refused');
assert.ok(p.vetToolCall('move_file', { source: R('a.yaml'), destination: R('a2.yaml') }).ok); ok('move_file between allowed names passes');
assert.strictEqual(p.vetToolCall('move_file', { source: R('secrets.yaml'), destination: R('x.yaml') }).ok, false); ok('move_file out of secrets.yaml is refused');
assert.strictEqual(p.vetToolCall('move_file', { source: R('a.yaml'), destination: R('secrets.yaml') }).ok, false); ok('move_file onto secrets.yaml is refused');
assert.ok(p.vetToolCall('read_multiple_files', { paths: [R('a.yaml'), R('sub/b.yaml')] }).ok); ok('read_multiple_files with allowed paths passes');
assert.strictEqual(p.vetToolCall('read_multiple_files', { paths: [R('a.yaml'), R('secrets.yaml')] }).ok, false); ok('one denied path refuses the whole read_multiple_files');
assert.strictEqual(p.vetToolCall('read_multiple_files', { paths: [] }).ok, false); ok('empty paths list is refused');
assert.strictEqual(p.vetToolCall('list_directory', { path: R('.esphome') }).ok, false); ok('listing .esphome is refused');
assert.strictEqual(p.vetToolCall('search_files', { path: R('.esphome'), pattern: 'x' }).ok, false); ok('searching inside .esphome is refused');

// ---- READ_ONLY ----------------------------------------------------------
const ro = createPolicy({ ...base, readOnly: true });
assert.ok(ro.vetToolCall('read_text_file', { path: R('a.yaml') }).ok); ok('READ_ONLY still reads');
for (const t of ['write_file', 'edit_file', 'create_directory', 'move_file']) {
  assert.strictEqual(ro.vetToolCall(t, { path: R('x'), source: R('a.yaml'), destination: R('b.yaml'), content: '' }).ok, false);
  ok(`READ_ONLY refuses ${t}`);
}
for (const [name, spec] of Object.entries(TOOLS)) {
  if (spec.write) assert.ok(['write_file', 'edit_file', 'create_directory', 'move_file'].includes(name));
}
ok('the write tools in the table are exactly the four the tests cover');

// ---- ALLOW_ONLY ---------------------------------------------------------
const ao = createPolicy({ roots: [root], denyNames: ['secrets*'], allowOnly: [{ prefix: root, globs: ['*.yaml', '*.yml'] }] });
assert.ok(ao.checkPath(R('a.yaml')).ok); ok('ALLOW_ONLY: *.yaml passes');
assert.strictEqual(ao.checkPath(R('notes.txt')).ok, false); ok('ALLOW_ONLY: notes.txt is refused');
assert.strictEqual(ao.checkPath(R('notes.txt'), { write: true, kind: 'file' }).ok, false); ok('ALLOW_ONLY: cannot create a .txt file');
assert.ok(ao.checkPath(R('sub'), { kind: 'dir' }).ok); ok('ALLOW_ONLY: directories stay listable');
assert.ok(ao.checkPath(R('sub')).ok); ok('ALLOW_ONLY: existing directory is recognised on disk');
assert.ok(ao.checkPath(R('newdir'), { write: true, kind: 'dir' }).ok); ok('ALLOW_ONLY: directory can be created');
assert.strictEqual(ao.checkPath(R('a.txt:b.yaml')).ok, false); ok('ALLOW_ONLY: stream-style name does not slip in');
assert.strictEqual(ao.vetToolCall('write_file', { path: R('run.sh'), content: '#!/bin/sh' }).ok, false); ok('ALLOW_ONLY: cannot drop a script next to the YAMLs');

// ---- a second root is untouched by a prefix rule ------------------------
const other = path.join(tmp, 'sessions');
fs.mkdirSync(other);
fs.writeFileSync(path.join(other, 'talk.md'), 'x');
const two = createPolicy({ roots: [root, other], denyNames: ['secrets*'], allowOnly: [{ prefix: root, globs: ['*.yaml'] }] });
assert.ok(two.checkPath(path.join(other, 'talk.md')).ok); ok('ALLOW_ONLY of one root does not restrict another root');

// ---- names are judged below the root, not above it ----------------------
const odd = path.join(tmp, 'secrets-vault');
fs.mkdirSync(odd);
fs.writeFileSync(path.join(odd, 'ok.txt'), 'x');
const underOdd = createPolicy({ roots: [odd], denyNames: ['secrets*'] });
assert.ok(underOdd.checkPath(path.join(odd, 'ok.txt')).ok); ok('a root whose own name matches DENY_NAMES still works');

// ---- result filtering ---------------------------------------------------
const lsText = ['[FILE] a.yaml', '[FILE] innocent.yaml', '[FILE] notes.txt', '[FILE] secrets.yaml', '[FILE] secrets.yaml.bak', '[DIR] sub', '[DIR] .esphome'].join('\n');
v = p.vetToolCall('list_directory', { path: root });
let out = p.filterResult(v, { content: [{ type: 'text', text: lsText }], structuredContent: { content: lsText } });
for (const hidden of ['secrets.yaml', 'secrets.yaml.bak', '.esphome', 'innocent.yaml']) {
  assert.ok(!JSON.stringify(out).includes(hidden), `${hidden} must not appear in the listing`);
}
assert.ok(out.content[0].text.includes('a.yaml') && out.content[0].text.includes('[DIR] sub'));
assert.deepStrictEqual(out.structuredContent, { content: out.content[0].text });
ok('list_directory: hidden names removed from content AND structuredContent');

const sizesText = ['[FILE] a.yaml                          12 B', '[FILE] secrets.yaml                    21 B', '[DIR] sub', '', 'Total: 2 files, 1 directories', 'Combined size: 33 bytes'].join('\n');
v = p.vetToolCall('list_directory_with_sizes', { path: root });
out = p.filterResult(v, { content: [{ type: 'text', text: sizesText }] });
assert.ok(!out.content[0].text.includes('secrets'));
assert.ok(!/Total:|Combined size:/.test(out.content[0].text));
assert.ok(out.content[0].text.includes('a.yaml'));
ok('list_directory_with_sizes: hidden names and the totals that would reveal them are removed');

const tree = [
  { name: 'a.yaml', type: 'file' },
  { name: 'secrets.yaml', type: 'file' },
  { name: '.esphome', type: 'directory', children: [{ name: 'build.txt', type: 'file' }] },
  { name: 'sub', type: 'directory', children: [{ name: 'b.yaml', type: 'file' }, { name: 'secrets.yaml', type: 'file' }] },
];
v = p.vetToolCall('directory_tree', { path: root });
out = p.filterResult(v, { content: [{ type: 'text', text: JSON.stringify(tree, null, 2) }], structuredContent: { content: JSON.stringify(tree) } });
assert.ok(!JSON.stringify(out).includes('secrets'));
assert.ok(!JSON.stringify(out).includes('.esphome'));
const kept = JSON.parse(out.content[0].text);
assert.deepStrictEqual(kept.map((n) => n.name), ['a.yaml', 'sub']);
assert.deepStrictEqual(kept[1].children.map((n) => n.name), ['b.yaml']);
ok('directory_tree: hidden nodes removed at every depth');

const searchText = [R('a.yaml'), R('secrets.yaml'), R('sub/secrets.yaml'), R('sub/b.yaml')].join('\n');
v = p.vetToolCall('search_files', { path: root, pattern: 'yaml' });
out = p.filterResult(v, { content: [{ type: 'text', text: searchText }] });
assert.strictEqual(out.content[0].text, [R('a.yaml'), R('sub/b.yaml')].join('\n'));
ok('search_files: hidden paths removed');
out = p.filterResult(v, { content: [{ type: 'text', text: R('secrets.yaml') }] });
assert.strictEqual(out.content[0].text, 'No matches found');
ok('search_files: only hidden hits -> "No matches found"');

v = p.vetToolCall('read_text_file', { path: R('a.yaml') });
const plain = { content: [{ type: 'text', text: 'a' }], structuredContent: { content: 'a' } };
assert.strictEqual(p.filterResult(v, plain), plain); ok('read results pass through untouched');

v = p.vetToolCall('list_directory', { path: root });
const errRes = { content: [{ type: 'text', text: 'ENOENT' }], isError: true };
assert.strictEqual(p.filterResult(v, errRes), errRes); ok('error results pass through untouched');
assert.throws(() => p.filterResult(v, { content: [{ type: 'image', data: 'x' }] })); ok('unexpected content type -> refused (throws)');
assert.throws(() => p.filterResult(v, { content: [] })); ok('empty content -> refused (throws)');
assert.throws(() => p.filterResult(p.vetToolCall('directory_tree', { path: root }), { content: [{ type: 'text', text: 'not json' }] })); ok('directory_tree that is not JSON -> refused (throws)');
assert.throws(() => p.filterResult(p.vetToolCall('directory_tree', { path: root }), { content: [{ type: 'text', text: '{"a":1}' }] })); ok('directory_tree of the wrong shape -> refused (throws)');
assert.throws(() => p.filterResult(p.vetToolCall('list_directory', { path: root }), { content: [{ type: 'text', text: 'x' }] }) && p.filterResult({ filter: 'list', args: { path: path.join(root, 'missing') } }, { content: [{ type: 'text', text: 'x' }] })); ok('listing of a directory that cannot be read -> refused (throws)');

// ---- configuration ------------------------------------------------------
let c = parseEnv({});
assert.strictEqual(c.active, false); ok('no variables -> inactive');
c = parseEnv({ DENY_NAMES: ' secrets* , .esphome ,', READ_ONLY: 'Yes', ALLOW_ONLY: '/data/ha-esphome=*.yaml|*.yml;/data/x=*.md' });
assert.deepStrictEqual(c.denyNames, ['secrets*', '.esphome']);
assert.strictEqual(c.readOnly, true);
assert.deepStrictEqual(c.allowOnly, [{ prefix: '/data/ha-esphome', globs: ['*.yaml', '*.yml'] }, { prefix: '/data/x', globs: ['*.md'] }]);
assert.strictEqual(c.active, true);
ok('variables are parsed');
for (const bad of ['relative/path=*.yaml', '/data/x', '/data/x=', '=*.yaml']) {
  assert.throws(() => parseEnv({ ALLOW_ONLY: bad }), /ALLOW_ONLY/);
  ok(`bad ALLOW_ONLY refused: ${bad}`);
}
assert.strictEqual(parseEnv({ READ_ONLY: '0' }).active, false); ok('READ_ONLY=0 is off');
assert.throws(() => createPolicy({ roots: [], denyNames: ['x'] })); ok('no allowed directories -> refuses to build a policy');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
