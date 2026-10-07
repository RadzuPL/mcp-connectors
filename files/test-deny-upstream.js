'use strict';
// Runs the access policy in front of the REAL @modelcontextprotocol/server-filesystem
// (the version pinned in files/UPSTREAM_REF). Needs `mcp-server-filesystem` on PATH:
//   npm install -g "@modelcontextprotocol/server-filesystem@$(cat files/UPSTREAM_REF)"
//   node files/test-deny-upstream.js
// Without the server it prints SKIP and exits 0, unless REQUIRE_UPSTREAM=1 (CI sets it).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { TOOLS } = require('./deny-policy');

const which = spawnSync('sh', ['-c', 'command -v mcp-server-filesystem']);
if (which.status !== 0) {
  if (process.env.REQUIRE_UPSTREAM === '1') { console.error('FAIL mcp-server-filesystem is not installed'); process.exit(1); }
  console.log('SKIP mcp-server-filesystem is not installed');
  process.exit(0);
}

let passed = 0;
const ok = (name) => { passed++; console.log('PASS', name); };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deny-upstream-')));
const root = tmp + '/data';
fs.mkdirSync(root + '/sub', { recursive: true });
fs.mkdirSync(root + '/.esphome');
fs.writeFileSync(root + '/a.yaml', 'a-content');
fs.writeFileSync(root + '/secrets.yaml', 'wifi_password: hunter2');
fs.writeFileSync(root + '/sub/b.yaml', 'b-content');
fs.writeFileSync(root + '/sub/secrets.yaml', 'sub-secret-xyz');
fs.writeFileSync(root + '/.esphome/build.txt', 'cache');

const p = spawn('node', [path.join(__dirname, 'deny-proxy.js'), 'mcp-server-filesystem', root], {
  env: { PATH: process.env.PATH, DENY_NAMES: 'secrets*,.esphome', ALLOW_ONLY: `${root}=*.yaml|*.yml` },
});
const lines = [];
let err = '';
let buf = '';
p.stdout.setEncoding('utf8');
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
p.stderr.setEncoding('utf8');
p.stderr.on('data', (d) => { err += d; });
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function reply(id) {
  for (let t = 0; t < 200; t++) {
    const hit = lines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).find((m) => m && m.id === id);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error('timeout waiting for id ' + id + '\nstderr: ' + err);
}
let nextId = 10;
async function call(name, args) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const m = await reply(id);
  return { res: m.result, raw: JSON.stringify(m) };
}
const text = (r) => (r.content || []).map((c) => c.text).join('\n');

(async () => {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'deny-upstream-test', version: '0' } } });
  assert.ok((await reply(1)).result, 'initialize must succeed'); ok('initialize through the proxy');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (await reply(2)).result.tools.map((t) => t.name);
  const unknown = names.filter((n) => !Object.prototype.hasOwnProperty.call(TOOLS, n));
  assert.deepStrictEqual(unknown, [], `upstream has tools the policy does not know (they would be refused): ${unknown.join(', ')}. Add them to TOOLS in files/deny-policy.js, with the right path arguments.`);
  ok(`every upstream tool is in the policy table (${names.length} tools)`);
  for (const n of ['read_text_file', 'write_file', 'list_directory', 'directory_tree', 'search_files', 'move_file']) assert.ok(names.includes(n), `expected upstream tool ${n}`);
  ok('the tools the policy relies on exist upstream');

  let r = await call('read_text_file', { path: root + '/a.yaml' });
  assert.ok(!r.res.isError && text(r.res).includes('a-content')); ok('allowed file is read');
  r = await call('read_text_file', { path: root + '/secrets.yaml' });
  assert.strictEqual(r.res.isError, true); assert.ok(!r.raw.includes('hunter2')); ok('secrets.yaml is refused');
  r = await call('read_text_file', { path: root + '/sub/Secrets.YAML' });
  assert.strictEqual(r.res.isError, true); assert.ok(!r.raw.includes('sub-secret-xyz')); ok('secrets.yaml in another spelling is refused');

  for (const [tool, args] of [['list_directory', { path: root }], ['directory_tree', { path: root }], ['search_files', { path: root, pattern: 'secrets' }], ['search_files', { path: root, pattern: 'yaml' }]]) {
    r = await call(tool, args);
    assert.ok(!/secrets|\.esphome/i.test(r.raw.replace(/\\\//g, '/').replace(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')), `${tool} leaked a hidden name: ${r.raw}`);
    ok(`${tool}: no hidden name anywhere in the response`);
  }
  r = await call('list_directory', { path: root });
  assert.ok(text(r.res).includes('a.yaml') && text(r.res).includes('sub')); ok('list_directory still shows the allowed entries');
  r = await call('directory_tree', { path: root });
  assert.ok(text(r.res).includes('b.yaml')); ok('directory_tree still shows the allowed entries');
  if (names.includes('list_directory_with_sizes')) {
    r = await call('list_directory_with_sizes', { path: root });
    assert.ok(!/secrets|\.esphome/i.test(r.raw.replace(new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')), 'list_directory_with_sizes leaked: ' + r.raw);
    assert.ok(text(r.res).includes('a.yaml')); ok('list_directory_with_sizes: hidden names gone, allowed entries kept');
  }

  r = await call('write_file', { path: root + '/new.yaml', content: 'created' });
  assert.ok(!r.res.isError); assert.strictEqual(fs.readFileSync(root + '/new.yaml', 'utf8'), 'created'); ok('write to a new .yaml works');
  r = await call('edit_file', { path: root + '/a.yaml', edits: [{ oldText: 'a-content', newText: 'a-edited' }] });
  assert.ok(!r.res.isError); assert.strictEqual(fs.readFileSync(root + '/a.yaml', 'utf8'), 'a-edited'); ok('edit_file works');
  r = await call('write_file', { path: root + '/secrets.yaml', content: 'pwned' });
  assert.strictEqual(r.res.isError, true); assert.strictEqual(fs.readFileSync(root + '/secrets.yaml', 'utf8'), 'wifi_password: hunter2'); ok('write to secrets.yaml is refused');
  r = await call('write_file', { path: root + '/run.sh', content: 'x' });
  assert.strictEqual(r.res.isError, true); assert.ok(!fs.existsSync(root + '/run.sh')); ok('a .sh file cannot be created');
  r = await call('move_file', { source: root + '/new.yaml', destination: root + '/secrets.yaml' });
  assert.strictEqual(r.res.isError, true); assert.ok(fs.existsSync(root + '/new.yaml')); ok('move onto secrets.yaml is refused');
  r = await call('move_file', { source: root + '/new.yaml', destination: root + '/moved.yaml' });
  assert.ok(!r.res.isError); assert.ok(fs.existsSync(root + '/moved.yaml')); ok('an ordinary move works');

  p.stdin.end();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('FAIL', e.message || e); try { p.kill(); } catch (x) { /* ignore */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* ignore */ } process.exit(1); });
