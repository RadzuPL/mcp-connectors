'use strict';
// Tests for trilium/server.js against an in-memory mock of the TriliumNext ETAPI.
// Run: node trilium/test-server.js

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const srv = require('./server.js');

// ------------------------------------------------------------------ mock ETAPI

const TOKEN = 'secret-etapi-token';
let seq = 0;
const notes = new Map();
const attrs = new Map();
const branches = new Map();
const content = new Map();
const calls = []; // "METHOD route"
let failRevision = false;

function addNote(id, title, parent, type = 'text', body = '', extra = {}) {
  notes.set(id, { noteId: id, title, type, mime: type === 'text' ? 'text/html' : 'text/plain', isProtected: false, dateCreated: '2026-10-01 10:00:00.000+0000', dateModified: '2026-10-02 10:00:00.000+0000', ...extra });
  content.set(id, body);
  if (parent) addBranch(id, parent);
}
function addBranch(id, parent) {
  const bid = `${parent}_${id}`;
  branches.set(bid, { branchId: bid, noteId: id, parentNoteId: parent, notePosition: 10 });
}
function view(id) {
  const n = notes.get(id);
  if (!n) return null;
  const bs = [...branches.values()];
  return {
    ...n,
    attributes: [...attrs.values()].filter((a) => a.noteId === id),
    parentNoteIds: bs.filter((b) => b.noteId === id).map((b) => b.parentNoteId),
    childNoteIds: bs.filter((b) => b.parentNoteId === id).map((b) => b.noteId),
    parentBranchIds: bs.filter((b) => b.noteId === id).map((b) => b.branchId),
    childBranchIds: bs.filter((b) => b.parentNoteId === id).map((b) => b.branchId),
  };
}
function reset() {
  notes.clear(); attrs.clear(); branches.clear(); content.clear(); calls.length = 0; seq = 0; failRevision = false;
  addNote('root', 'root', null);
  addNote('npcFolder01', 'NPC', 'root');
  addNote('placeFolder1', 'Miejsca', 'root');
  addNote('npcBorin001', 'Borin', 'npcFolder01', 'text', '<p>Kowal.</p>');
  addNote('placeKuznia1', 'Kuźnia', 'placeFolder1', 'text', '<p>Tu pracuje <a class="reference-link" href="#root/npcBorin001">Borin</a> i <a href="#root/npcFolder01/npcBorin001">kowal</a>. <a href="https://example.com">ext</a></p>');
  addNote('protNote0001', 'secret', 'root', 'text', 'x', { isProtected: true });
  addNote('mdNote000001', 'Notatka md', 'root', 'code', 'tekst [[npcBorin001]]', { mime: 'text/x-markdown' });
  attrs.set('a1', { attributeId: 'a1', noteId: 'placeKuznia1', type: 'relation', name: 'npc', value: 'npcBorin001' });
  attrs.set('a2', { attributeId: 'a2', noteId: 'npcBorin001', type: 'label', name: 'npc', value: '' });
}

function readBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (d) => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
  });
}
const send = (res, status, obj, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
};
const nf = (res, msg = 'not found') => send(res, 404, { status: 404, code: 'NOTE_NOT_FOUND', message: msg });

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname.replace(/^\/etapi/, '');
  calls.push(`${req.method} ${route}`);
  if (req.headers.authorization !== TOKEN) return send(res, 401, { status: 401, code: 'NOT_AUTHENTICATED', message: 'bad token' });
  const body = await readBody(req);
  let m;
  const json = () => (body ? JSON.parse(body) : {});

  if (req.method === 'GET' && route === '/app-info') return send(res, 200, { appVersion: '0.99.0', dbVersion: 240 });
  if (req.method === 'GET' && route === '/notes') {
    const q = (url.searchParams.get('search') || '').toLowerCase();
    const rows = [...notes.keys()].filter((id) => notes.get(id).title.toLowerCase().includes(q) && !notes.get(id).isProtected).map(view);
    return send(res, 200, { results: rows });
  }
  if (req.method === 'GET' && route === '/notes/history') return send(res, 200, [{ noteId: 'npcBorin001', utcDate: '2026-10-02 10:00:00', current_title: 'Borin' }]);
  if (req.method === 'GET' && (m = route.match(/^\/notes\/([^/]+)\/content$/))) return notes.has(m[1]) ? send(res, 200, content.get(m[1]), 'text/html') : nf(res);
  if (req.method === 'PUT' && (m = route.match(/^\/notes\/([^/]+)\/content$/))) { content.set(m[1], body); return send(res, 204, ''); }
  if (req.method === 'POST' && (m = route.match(/^\/notes\/([^/]+)\/revision$/))) {
    if (failRevision) return send(res, 500, { message: 'boom' });
    return send(res, 204, '');
  }
  if (req.method === 'POST' && (m = route.match(/^\/notes\/([^/]+)\/undelete$/))) return send(res, 204, '');
  if (req.method === 'GET' && (m = route.match(/^\/notes\/([^/]+)$/))) return notes.has(m[1]) ? send(res, 200, view(m[1])) : nf(res);
  if (req.method === 'PATCH' && (m = route.match(/^\/notes\/([^/]+)$/))) { Object.assign(notes.get(m[1]), json()); return send(res, 200, view(m[1])); }
  if (req.method === 'DELETE' && (m = route.match(/^\/notes\/([^/]+)$/))) { notes.get(m[1]).deleted = true; return send(res, 204, ''); }
  if (req.method === 'POST' && route === '/create-note') {
    const b = json();
    const id = `newNote${String(++seq).padStart(5, '0')}`;
    addNote(id, b.title, b.parentNoteId, b.type, b.content, b.mime ? { mime: b.mime } : {});
    return send(res, 201, { note: view(id), branch: {} });
  }
  if (req.method === 'POST' && route === '/attributes') {
    const b = json();
    const id = `attr${++seq}`;
    attrs.set(id, { attributeId: id, ...b });
    return send(res, 201, attrs.get(id));
  }
  if (req.method === 'PATCH' && (m = route.match(/^\/attributes\/([^/]+)$/))) { Object.assign(attrs.get(m[1]), json()); return send(res, 200, attrs.get(m[1])); }
  if (req.method === 'DELETE' && (m = route.match(/^\/attributes\/([^/]+)$/))) { attrs.delete(m[1]); return send(res, 204, ''); }
  if (req.method === 'POST' && route === '/branches') {
    const b = json();
    const bid = `${b.parentNoteId}_${b.noteId}`;
    const existed = branches.has(bid);
    addBranch(b.noteId, b.parentNoteId);
    return send(res, existed ? 200 : 201, branches.get(bid));
  }
  if (req.method === 'GET' && (m = route.match(/^\/branches\/([^/]+)$/))) return branches.has(m[1]) ? send(res, 200, branches.get(m[1])) : nf(res);
  if (req.method === 'DELETE' && (m = route.match(/^\/branches\/([^/]+)$/))) { branches.delete(m[1]); return send(res, 204, ''); }
  if (req.method === 'GET' && (m = route.match(/^\/calendar\/days\/(.+)$/))) return send(res, 200, { noteId: 'dayNote00001', title: m[1] });
  if (req.method === 'PUT' && (m = route.match(/^\/backup\/(.+)$/))) return send(res, 204, '');
  return send(res, 404, { status: 404, code: 'ROUTE', message: `no mock for ${req.method} ${route}` });
});

// ------------------------------------------------------------------- helpers

async function call(name, args = {}) {
  const r = await srv.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.content[0].text, isError: r.isError === true };
}
const names = async () => (await srv.handleRequest({ method: 'tools/list' })).tools.map((t) => t.name);

let passed = 0;
async function test(label, fn) {
  try {
    reset();
    await fn();
    passed++;
    console.log(`ok   ${label}`);
  } catch (err) {
    console.error(`FAIL ${label}\n     ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  }
}
const setFlags = (w, d) => {
  process.env.TRILIUM_ENABLE_WRITE = w ? 'true' : '';
  process.env.TRILIUM_ENABLE_DESTRUCTIVE = d ? 'true' : '';
};

// --------------------------------------------------------------------- tests

(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trilium-test-')), 'token');
  fs.writeFileSync(tokenFile, TOKEN + '\n');
  process.env.TRILIUM_URL = `http://127.0.0.1:${port}`;
  process.env.TRILIUM_TOKEN_FILE = tokenFile;

  // pure functions
  await test('fromHtml turns reference links and internal links into [[ ]]', async () => {
    const out = srv.fromHtml(content.get('placeKuznia1'));
    assert.ok(out.includes('[[npcBorin001]] i [[npcBorin001|kowal]]'), out);
    assert.ok(out.includes('<a href="https://example.com">ext</a>'), 'external link untouched');
  });
  await test('isNeverAllowed blocks auth, import, export', async () => {
    assert.ok(srv.isNeverAllowed('POST', '/auth/login'));
    assert.ok(srv.isNeverAllowed('POST', '/notes/abcd/import'));
    assert.ok(srv.isNeverAllowed('GET', '/notes/abcd/export'));
    assert.ok(!srv.isNeverAllowed('GET', '/notes/abcd'));
  });

  // gating
  await test('read-only: write and destructive tools hidden and refused', async () => {
    setFlags(false, false);
    const n = await names();
    assert.ok(n.includes('search_notes') && !n.includes('create_note') && !n.includes('delete_note'));
    const r = await call('create_note', { parent: 'root', title: 'x' });
    assert.ok(r.isError && /disabled/.test(r.text));
    assert.ok(!calls.some((c) => c.startsWith('POST')), 'no write call reached the mock');
  });
  await test('write on, destructive off: delete hidden and refused', async () => {
    setFlags(true, false);
    const n = await names();
    assert.ok(n.includes('create_note') && !n.includes('delete_note'));
    const r = await call('delete_note', { id: 'npcBorin001' });
    assert.ok(r.isError);
    assert.ok(!calls.some((c) => c.startsWith('DELETE')));
  });
  await test('destructive without write stays off', async () => {
    process.env.TRILIUM_ENABLE_WRITE = '';
    process.env.TRILIUM_ENABLE_DESTRUCTIVE = 'true';
    assert.ok(!(await names()).includes('delete_note'));
  });
  await test('unknown tool is an RPC error', async () => {
    await assert.rejects(srv.handleRequest({ method: 'tools/call', params: { name: 'nope' } }), /unknown tool/);
  });

  // read tools
  await test('status', async () => {
    setFlags(false, false);
    const r = await call('status');
    assert.ok(/Trilium 0\.99\.0/.test(r.text) && /write tools: off/.test(r.text), r.text);
  });
  await test('search_notes finds by title and shows labels', async () => {
    setFlags(false, false);
    const r = await call('search_notes', { q: 'borin' });
    assert.ok(r.text.includes('npcBorin001 | Borin | text | #npc'), r.text);
    assert.ok(!r.text.includes('secret'));
  });
  await test('search_notes validates depth', async () => {
    const r = await call('search_notes', { q: 'x', depth: 'bad' });
    assert.ok(r.isError);
  });
  await test('get_note shows wiki links, relation target title, link titles', async () => {
    setFlags(false, false);
    const r = await call('get_note', { id: 'placeKuznia1' });
    assert.ok(r.text.includes('~npc->npcBorin001 (Borin)'), r.text);
    assert.ok(r.text.includes('[[npcBorin001]]'), r.text);
    assert.ok(r.text.includes('links: npcBorin001 = Borin'), r.text);
  });
  await test('get_note on protected note does not read content', async () => {
    const r = await call('get_note', { id: 'protNote0001' });
    assert.ok(/protected/.test(r.text) && !/content \(/.test(r.text), r.text);
    assert.ok(!calls.includes('GET /notes/protNote0001/content'));
  });
  await test('get_note rejects a bad id and reports 404', async () => {
    assert.ok((await call('get_note', { id: '../etc' })).isError);
    const r = await call('get_note', { id: 'doesnotexist' });
    assert.ok(r.isError && /not found/.test(r.text));
  });
  await test('get_tree outlines and hides system subtree', async () => {
    addNote('_hidden', 'hidden', 'root');
    const r = await call('get_tree', { depth: 2 });
    assert.ok(r.text.includes('NPC [npcFolder01]') && r.text.includes('Borin [npcBorin001]'), r.text);
    assert.ok(!r.text.includes('_hidden'));
  });
  await test('recent_changes', async () => {
    const r = await call('recent_changes', {});
    assert.ok(r.text.includes('npcBorin001'), r.text);
  });

  // write tools
  await test('create_note converts [[id]] to a reference link and adds labels and relations', async () => {
    setFlags(true, false);
    const r = await call('create_note', { parent: 'npcFolder01', title: 'Ela', content: '<p>Siostra [[npcBorin001]], pracuje w [[placeKuznia1|kuźni]].</p>', labels: { npc: '', rola: 'handlarka' }, relations: { siostra: 'npcBorin001' } });
    assert.ok(!r.isError && /created newNote/.test(r.text), r.text);
    const id = r.text.match(/created (\w+):/)[1];
    assert.ok(content.get(id).includes('<a class="reference-link" href="#root/npcBorin001">Borin</a>'), content.get(id));
    assert.ok(content.get(id).includes('<a href="#root/placeKuznia1">kuźni</a>'));
    const a = [...attrs.values()].filter((x) => x.noteId === id);
    assert.strictEqual(a.length, 3);
  });
  await test('create_note refuses links to missing notes and writes nothing', async () => {
    setFlags(true, false);
    const r = await call('create_note', { parent: 'root', title: 'Zly', content: '[[nope0000]]' });
    assert.ok(r.isError && /not found/.test(r.text));
    assert.ok(!calls.includes('POST /create-note'));
  });
  await test('create_note with missing relation target creates nothing', async () => {
    setFlags(true, false);
    const r = await call('create_note', { parent: 'root', title: 'Zly', relations: { npc: 'nope0000' } });
    assert.ok(r.isError && !calls.includes('POST /create-note'));
  });
  await test('create_note markdown stores a code note with markdown mime, text as typed', async () => {
    setFlags(true, false);
    const r = await call('create_note', { parent: 'root', title: 'MD', format: 'markdown', content: '# Hej [[npcBorin001]]' });
    const id = r.text.match(/created (\w+):/)[1];
    assert.strictEqual(notes.get(id).type, 'code');
    assert.strictEqual(notes.get(id).mime, 'text/x-markdown');
    assert.strictEqual(content.get(id), '# Hej [[npcBorin001]]');
  });
  await test('update_note replace_text: saves a revision first, keeps links', async () => {
    setFlags(true, false);
    const r = await call('update_note', { id: 'placeKuznia1', replace_text: { find: 'Tu pracuje', replace: 'Tutaj pracuje' } });
    assert.ok(!r.isError, r.text);
    assert.ok(calls.indexOf('POST /notes/placeKuznia1/revision') < calls.indexOf('PUT /notes/placeKuznia1/content'));
    const c = content.get('placeKuznia1');
    assert.ok(c.includes('Tutaj pracuje') && c.includes('class="reference-link"'), c);
  });
  await test('update_note: no revision, no change', async () => {
    setFlags(true, false);
    failRevision = true;
    const r = await call('update_note', { id: 'npcBorin001', append: '<p>Dodane</p>' });
    assert.ok(r.isError && /revision/.test(r.text));
    assert.ok(!calls.includes('PUT /notes/npcBorin001/content'));
  });
  await test('update_note append and title', async () => {
    setFlags(true, false);
    const r = await call('update_note', { id: 'npcBorin001', title: 'Borin Kowal', append: '<p>Dodane</p>' });
    assert.ok(!r.isError, r.text);
    assert.strictEqual(notes.get('npcBorin001').title, 'Borin Kowal');
    assert.ok(content.get('npcBorin001').endsWith('<p>Dodane</p>'));
  });
  await test('update_note refuses ambiguous replace and protected notes', async () => {
    setFlags(true, false);
    addNote('dup000000001', 'dup', 'root', 'text', '<p>a a</p>');
    assert.ok((await call('update_note', { id: 'dup000000001', replace_text: { find: 'a', replace: 'b' } })).isError);
    assert.ok((await call('update_note', { id: 'protNote0001', append: 'x' })).isError);
    assert.ok((await call('update_note', { id: 'npcBorin001' })).isError);
  });
  await test('set_label updates, is idempotent; set_relation is idempotent', async () => {
    setFlags(true, false);
    assert.ok(/already/.test((await call('set_label', { id: 'npcBorin001', name: 'npc' })).text));
    await call('set_label', { id: 'npcBorin001', name: 'rola', value: 'kowal' });
    assert.ok(/updated #rola/.test((await call('set_label', { id: 'npcBorin001', name: 'rola', value: 'płatnerz' })).text));
    assert.ok(/already/.test((await call('set_relation', { id: 'placeKuznia1', name: 'npc', target: 'npcBorin001' })).text));
    assert.ok(/added ~/.test((await call('set_relation', { id: 'placeKuznia1', name: 'bywa', target: 'npcBorin001' })).text));
  });
  await test('remove_attribute', async () => {
    setFlags(true, false);
    assert.ok(!(await call('remove_attribute', { id: 'npcBorin001', name: 'npc' })).isError);
    assert.ok(![...attrs.values()].some((a) => a.id === 'a2' || a.attributeId === 'a2'));
    assert.ok((await call('remove_attribute', { id: 'npcBorin001', name: 'npc' })).isError);
  });
  await test('clone_note and move_note', async () => {
    setFlags(true, false);
    assert.ok(/cloned/.test((await call('clone_note', { id: 'npcBorin001', to_parent: 'placeKuznia1' })).text));
    assert.strictEqual(view('npcBorin001').parentNoteIds.length, 2);
    // two parents: move without from_parent is refused
    assert.ok((await call('move_note', { id: 'npcBorin001', to_parent: 'root' })).isError);
    const r = await call('move_note', { id: 'npcBorin001', from_parent: 'placeKuznia1', to_parent: 'root' });
    assert.ok(!r.isError, r.text);
    assert.deepStrictEqual(view('npcBorin001').parentNoteIds.sort(), ['npcFolder01', 'root']);
  });
  await test('move_note adds the new placement before deleting the old one', async () => {
    setFlags(true, false);
    await call('move_note', { id: 'npcBorin001', to_parent: 'placeFolder1' });
    assert.ok(calls.indexOf('POST /branches') < calls.indexOf('DELETE /branches/npcFolder01_npcBorin001'));
    assert.deepStrictEqual(view('npcBorin001').parentNoteIds, ['placeFolder1']);
  });
  await test('day_note, create_backup, undelete_note, input validation', async () => {
    setFlags(true, false);
    assert.ok(/dayNote00001/.test((await call('day_note', { date: '2026-10-21' })).text));
    assert.ok((await call('day_note', { date: '21.10.2026' })).isError);
    assert.ok(!(await call('create_backup', { name: 'przed_zmiana' })).isError);
    assert.ok((await call('create_backup', { name: '../x' })).isError);
    assert.ok(!(await call('undelete_note', { id: 'npcBorin001' })).isError);
  });
  await test('delete_note works only with both flags', async () => {
    setFlags(true, true);
    assert.ok((await names()).includes('delete_note'));
    const r = await call('delete_note', { id: 'npcBorin001' });
    assert.ok(!r.isError && /soft delete/.test(r.text), r.text);
    assert.ok(calls.includes('DELETE /notes/npcBorin001'));
  });

  // errors and secrets
  await test('wrong ETAPI token gives a clear message without leaking the token', async () => {
    setFlags(false, false);
    const f = path.join(path.dirname(tokenFile), 'bad');
    fs.writeFileSync(f, 'wrong-token');
    process.env.TRILIUM_TOKEN_FILE = f;
    const r = await call('status');
    process.env.TRILIUM_TOKEN_FILE = tokenFile;
    assert.ok(r.isError && /rejected the ETAPI token/.test(r.text) && !r.text.includes('wrong-token') && !r.text.includes(TOKEN), r.text);
  });
  await test('unreachable Trilium gives a readable error', async () => {
    const old = process.env.TRILIUM_URL;
    process.env.TRILIUM_URL = 'http://127.0.0.1:1';
    const r = await call('status');
    process.env.TRILIUM_URL = old;
    assert.ok(r.isError && /cannot reach Trilium/.test(r.text), r.text);
  });
  await test('initialize and ping', async () => {
    const i = await srv.handleRequest({ method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.strictEqual(i.serverInfo.name, 'trilium');
    assert.deepStrictEqual(await srv.handleRequest({ method: 'ping' }), {});
  });

  mock.close();
  console.log(`\n${passed} passed${process.exitCode ? ', with FAILURES' : ''}`);
})();
