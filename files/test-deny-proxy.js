'use strict';
// Wiring test of deny-proxy.js against a fake file server (same stdio protocol, same
// result shape as @modelcontextprotocol/server-filesystem). No network, no npm packages:
//   node files/test-deny-proxy.js
// The check against the real server is files/test-deny-upstream.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ------------------------------------------------------------ fake server ----
function fakeServer(roots) {
  const log = (o) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n'); };
  const ok = (text) => ({ content: [{ type: 'text', text }], structuredContent: { content: text } });
  const bad = (text) => ({ content: [{ type: 'text', text }], isError: true });
  const inRoot = (p) => roots.some((r) => path.resolve(p) === r || path.resolve(p).startsWith(r + path.sep));
  const tree = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((e) => (
    e.isDirectory() ? { name: e.name, type: 'directory', children: tree(path.join(dir, e.name)) } : { name: e.name, type: 'file' }));
  const find = (dir, re, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (re.test(e.name)) out.push(full);
      if (e.isDirectory()) find(full, re, out);
    }
    return out;
  };
  const tools = {
    list_allowed_directories: () => ok('Allowed directories:\n' + roots.join('\n')),
    read_text_file: (a) => ok(fs.readFileSync(a.path, 'utf8')),
    write_file: (a) => { fs.writeFileSync(a.path, a.content); return ok('Successfully wrote to ' + a.path); },
    edit_file: (a) => {
      let t = fs.readFileSync(a.path, 'utf8');
      for (const e of a.edits) t = t.replace(e.oldText, e.newText);
      if (!a.dryRun) fs.writeFileSync(a.path, t);
      return ok('edited ' + a.path);
    },
    create_directory: (a) => { fs.mkdirSync(a.path, { recursive: true }); return ok('Successfully created directory ' + a.path); },
    move_file: (a) => { fs.renameSync(a.source, a.destination); return ok(`Successfully moved ${a.source} to ${a.destination}`); },
    get_file_info: (a) => ok('size: ' + fs.statSync(a.path).size),
    list_directory: (a) => ok(fs.readdirSync(a.path, { withFileTypes: true }).map((e) => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n')),
    list_directory_with_sizes: (a) => {
      const es = fs.readdirSync(a.path, { withFileTypes: true });
      const rows = es.map((e) => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name.padEnd(30)} ${(e.isDirectory() ? '' : fs.statSync(path.join(a.path, e.name)).size + ' B').padStart(10)}`);
      return ok(rows.join('\n') + `\n\nTotal: ${es.length} files, 0 directories\nCombined size: 0 bytes`);
    },
    directory_tree: (a) => (process.env.FAKE_BAD_TREE ? ok('this is not json') : ok(JSON.stringify(tree(a.path), null, 2))),
    search_files: (a) => { const hits = find(a.path, new RegExp(a.pattern, 'i'), []); return ok(hits.length ? hits.join('\n') : 'No matches found'); },
  };
  const out = (o) => { if (process.env.FAKE_JUNK) process.stdout.write('this line is not json\n'); process.stdout.write(JSON.stringify(o) + '\n'); };
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      log({ method: m.method, tool: m.params && m.params.name, args: m.params && m.params.arguments });
      if (m.id === undefined) continue;
      if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-fs', version: '0' } } });
      else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: Object.keys(tools).map((name) => ({ name })) } });
      else if (m.method === 'tools/call') {
        const t = tools[m.params.name];
        let result;
        try {
          const a = m.params.arguments || {};
          const paths = [a.path, a.source, a.destination].filter(Boolean);
          result = !t ? bad('unknown tool') : (paths.every(inRoot) ? t(a) : bad('Access denied - path outside allowed directories'));
        } catch (e) { result = bad(String(e.message)); }
        out({ jsonrpc: '2.0', id: m.id, result });
      } else out({ jsonrpc: '2.0', id: m.id, result: {} });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main !== module) { module.exports = { fakeServer }; return; }

// ------------------------------------------------------------------ tests ----
let passed = 0;
const ok = (name) => { passed++; console.log('PASS', name); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deny-proxy-'));
const root = fs.realpathSync(tmp) + '/data';
fs.mkdirSync(root + '/sub', { recursive: true });
fs.writeFileSync(root + '/a.yaml', 'a-content');
fs.writeFileSync(root + '/secrets.yaml', 'wifi_password: hunter2');
fs.writeFileSync(root + '/sub/b.yaml', 'b-content');
fs.writeFileSync(root + '/sub/secrets.yaml', 'sub-secret-xyz');
fs.mkdirSync(root + '/.esphome');
fs.writeFileSync(root + '/.esphome/build.txt', 'cache');
const fakeBin = path.join(tmp, 'fake-mcp-fs');
fs.writeFileSync(fakeBin, `#!/usr/bin/env node\nrequire(${JSON.stringify(__filename)}).fakeServer(process.argv.slice(2).map((r) => require('path').resolve(r)));\n`, { mode: 0o755 });
const logFile = path.join(tmp, 'server-calls.log');

class Session {
  constructor(env, args) {
    this.lines = [];
    this.waiters = [];
    this.err = '';
    this.p = spawn('node', [path.join(__dirname, 'deny-proxy.js'), fakeBin, ...(args || [root])], {
      env: { PATH: process.env.PATH, FAKE_LOG: logFile, ...env },
    });
    let buf = '';
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        this.lines.push(line);
        this.waiters.forEach((w) => w());
      }
    });
    this.p.stderr.setEncoding('utf8');
    this.p.stderr.on('data', (d) => { this.err += d; });
    this.exited = new Promise((r) => this.p.on('exit', (code) => r(code)));
  }
  send(obj) { this.p.stdin.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'); }
  async reply(id, timeout = 4000) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.lines.map((l) => { try { return JSON.parse(l); } catch (e) { throw new Error('non-JSON on stdout: ' + l); } }).find((m) => m.id === id);
      if (hit) return hit;
      if (Date.now() - t0 > timeout) throw new Error('timeout waiting for id ' + id + '\nstderr: ' + this.err);
      await new Promise((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
  }
  async call(id, name, args) { this.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }); return (await this.reply(id)).result; }
  raw() { return this.lines.join('\n'); }
  async close() { this.p.stdin.end(); return this.exited; }
}
const serverCalls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const text = (r) => r.content[0].text;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- 1. no policy variables: the server is started untouched -------------
  let s = new Session({});
  let r = await s.call(1, 'read_text_file', { path: root + '/secrets.yaml' });
  assert.ok(text(r).includes('hunter2')); ok('no policy variables -> plain passthrough (secrets.yaml readable)');
  assert.strictEqual(await s.close(), 0);

  // ---- 2. policy on ---------------------------------------------------------
  fs.rmSync(logFile, { force: true });
  s = new Session({ DENY_NAMES: 'secrets*,.esphome', ALLOW_ONLY: `${root}=*.yaml|*.yml` });
  s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.strictEqual((await s.reply(1)).result.serverInfo.name, 'fake-fs'); ok('initialize is passed through');
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok((await s.reply(2)).result.tools.length > 5); ok('tools/list is passed through');

  r = await s.call(3, 'read_text_file', { path: root + '/a.yaml' });
  assert.strictEqual(text(r), 'a-content'); ok('allowed file is read');

  r = await s.call(4, 'read_text_file', { path: root + '/secrets.yaml' });
  assert.strictEqual(r.isError, true); assert.match(text(r), /Access denied/);
  assert.ok(!s.raw().includes('hunter2'));
  ok('secrets.yaml read is refused and the content never appears');
  r = await s.call(5, 'read_text_file', { path: root + '/SECRETS.YAML' });
  assert.strictEqual(r.isError, true); ok('other spelling is refused too');
  r = await s.call(6, 'read_text_file', { path: root + '/sub/secrets.yaml' });
  assert.strictEqual(r.isError, true); assert.ok(!s.raw().includes('sub-secret-xyz')); ok('secrets.yaml in a subdirectory is refused');
  assert.ok(!serverCalls().some((c) => /secrets/i.test(JSON.stringify(c.args || ''))), 'the server must never see a call for secrets');
  ok('the server never received a call that mentions secrets');

  r = await s.call(7, 'list_directory', { path: root });
  assert.ok(text(r).includes('a.yaml') && text(r).includes('[DIR] sub')); ok('list_directory shows allowed entries');
  r = await s.call(8, 'list_directory_with_sizes', { path: root });
  assert.ok(text(r).includes('a.yaml')); ok('list_directory_with_sizes shows allowed entries');
  r = await s.call(9, 'directory_tree', { path: root });
  assert.deepStrictEqual(JSON.parse(text(r)).map((n) => n.name), ['a.yaml', 'sub']); ok('directory_tree shows allowed entries');
  r = await s.call(10, 'search_files', { path: root, pattern: 'yaml' });
  assert.strictEqual(text(r).split('\n').length, 2); ok('search_files shows allowed hits');
  assert.ok(!/secrets|\.esphome/i.test(s.raw().split('\n').filter((l) => [7, 8, 9, 10].includes(JSON.parse(l).id)).join('\n')));
  ok('no hidden name in any list/tree/search response (content and structuredContent)');

  r = await s.call(11, 'write_file', { path: root + '/new.yaml', content: 'created' });
  assert.ok(!r.isError); assert.strictEqual(fs.readFileSync(root + '/new.yaml', 'utf8'), 'created'); ok('write to an allowed new file works');
  r = await s.call(12, 'write_file', { path: root + '/a.yaml', content: 'edited' });
  assert.ok(!r.isError); assert.strictEqual(fs.readFileSync(root + '/a.yaml', 'utf8'), 'edited'); ok('overwrite of an allowed file works');
  r = await s.call(13, 'write_file', { path: root + '/secrets.yaml', content: 'pwned' });
  assert.strictEqual(r.isError, true); assert.strictEqual(fs.readFileSync(root + '/secrets.yaml', 'utf8'), 'wifi_password: hunter2'); ok('write to secrets.yaml is refused, file unchanged');
  r = await s.call(14, 'write_file', { path: root + '/run.sh', content: '#!/bin/sh' });
  assert.strictEqual(r.isError, true); assert.ok(!fs.existsSync(root + '/run.sh')); ok('ALLOW_ONLY: a .sh file cannot be created');
  r = await s.call(15, 'move_file', { source: root + '/a.yaml', destination: root + '/secrets.yaml' });
  assert.strictEqual(r.isError, true); assert.ok(fs.existsSync(root + '/a.yaml')); ok('move onto secrets.yaml is refused');
  r = await s.call(16, 'move_file', { source: root + '/secrets.yaml', destination: root + '/stolen.yaml' });
  assert.strictEqual(r.isError, true); assert.ok(!fs.existsSync(root + '/stolen.yaml')); ok('move out of secrets.yaml is refused');
  r = await s.call(17, 'create_directory', { path: root + '/newdir' });
  assert.ok(!r.isError); assert.ok(fs.existsSync(root + '/newdir')); ok('create_directory works');
  r = await s.call(22, 'edit_file', { path: root + '/new.yaml', edits: [{ oldText: 'created', newText: 'edited' }] });
  assert.ok(!r.isError); assert.strictEqual(fs.readFileSync(root + '/new.yaml', 'utf8'), 'edited'); ok('edit_file on an allowed file works');
  r = await s.call(23, 'edit_file', { path: root + '/secrets.yaml', edits: [{ oldText: 'hunter2', newText: 'x' }], dryRun: true });
  assert.strictEqual(r.isError, true); assert.ok(!s.raw().includes('hunter2')); ok('edit_file (even a dry run) on secrets.yaml is refused');

  r = await s.call(18, 'format_disk', { path: root });
  assert.strictEqual(r.isError, true); assert.match(text(r), /not known/); ok('unknown tool is refused');
  s.send({ jsonrpc: '2.0', id: 19, method: 'resources/list' });
  assert.strictEqual((await s.reply(19)).error.code, -32601); ok('unknown method gets -32601');
  s.send('this is not json');
  assert.strictEqual((await s.reply(null)).error.code, -32700); ok('garbage on stdin gets a parse error');
  s.send([{ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'read_text_file', arguments: { path: root + '/secrets.yaml' } } },
    { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'read_text_file', arguments: { path: root + '/sub/b.yaml' } } }]);
  assert.strictEqual((await s.reply(20)).result.isError, true);
  assert.strictEqual(text((await s.reply(21)).result), 'b-content'); ok('each member of a batch is judged on its own');
  const before = s.lines.length;
  s.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'read_text_file', arguments: { path: root + '/secrets.yaml' } } });
  await sleep(300);
  assert.strictEqual(s.lines.length, before); ok('a refused call without an id produces no output and no server call');
  assert.ok(!serverCalls().some((c) => /secrets/i.test(JSON.stringify(c.args || ''))));
  ok('still no server call that mentions secrets after all of the above');
  assert.strictEqual(await s.close(), 0); ok('closing stdin ends the proxy cleanly');

  // ---- 3. READ_ONLY ---------------------------------------------------------
  s = new Session({ DENY_NAMES: 'secrets*', READ_ONLY: '1' });
  r = await s.call(1, 'write_file', { path: root + '/ro.yaml', content: 'x' });
  assert.strictEqual(r.isError, true); assert.ok(!fs.existsSync(root + '/ro.yaml'));
  r = await s.call(2, 'read_text_file', { path: root + '/sub/b.yaml' });
  assert.strictEqual(text(r), 'b-content'); ok('READ_ONLY: writes refused, reads work');
  await s.close();

  // ---- 4. server misbehaves --------------------------------------------------
  s = new Session({ DENY_NAMES: 'secrets*', FAKE_JUNK: '1' });
  r = await s.call(1, 'read_text_file', { path: root + '/sub/b.yaml' });
  assert.strictEqual(text(r), 'b-content');
  assert.ok(!s.raw().includes('this line is not json')); ok('a non-JSON line from the server is dropped, not forwarded');
  await s.close();
  s = new Session({ DENY_NAMES: 'secrets*', FAKE_BAD_TREE: '1' });
  r = await s.call(1, 'directory_tree', { path: root });
  assert.strictEqual(r.isError, true); assert.ok(!text(r).includes('this is not json')); ok('a result that cannot be filtered is replaced by an error, not passed on');
  await s.close();

  // ---- 5. bad configuration refuses to start ---------------------------------
  s = new Session({ DENY_NAMES: 'x', ALLOW_ONLY: 'relative=*.yaml' });
  assert.strictEqual(await s.exited, 2); assert.match(s.err, /refusing to start/); ok('malformed ALLOW_ONLY -> exit 2');
  s = new Session({ DENY_NAMES: 'secrets*' }, []);
  assert.strictEqual(await s.exited, 2); ok('policy but no allowed directories -> exit 2');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('FAIL', e); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) { /* ignore */ } process.exit(1); });
