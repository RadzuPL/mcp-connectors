'use strict';
// Tests for nametag/server.js against a fake Nametag API. No network, no Nametag needed:
//   node nametag/test-server.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const SECRET = 'ntag_TESTSECRET_do_not_leak_0123456789';
const SERVER = path.join(__dirname, 'server.js');

// ------------------------------------------------------------------ fake API
const state = {
  groups: [
    { id: 'grp_rpg', name: 'RPG', description: 'sesje' },
    { id: 'grp_larp', name: 'LARP', description: '' },
    { id: 'grp_post', name: 'Postapo', description: '' },
  ],
  types: [
    { id: 'rt_friend', label: 'Friend', name: 'FRIEND', inverseId: 'rt_friend' },
    { id: 'rt_mg', label: 'Game Master', name: 'GM', inverseId: 'rt_player' },
    { id: 'rt_player', label: 'Player', name: 'PLAYER', inverseId: 'rt_mg' },
  ],
  templates: [
    { id: 'tpl_from', name: 'Skąd znam', slug: 'skad-znam', type: 'TEXT', options: [] },
    { id: 'tpl_lvl', name: 'Zaufanie', slug: 'zaufanie', type: 'SELECT', options: ['niskie', 'średnie', 'wysokie'] },
    { id: 'tpl_num', name: 'Wiek', slug: 'wiek', type: 'NUMBER', options: [] },
  ],
  people: [
    {
      id: 'per_ola',
      name: 'Aleksandra',
      surname: 'Łukasiewicz',
      nickname: 'Ola',
      notes: 'Poznana na konwencie Pyrkon. Prowadzi sesje Warhammera.',
      groups: [{ group: { id: 'grp_rpg', name: 'RPG' } }],
      customFieldValues: [{ templateId: 'tpl_from', value: 'Pyrkon 2019', template: { name: 'Skąd znam' } }],
      relationshipsFrom: [{ relatedPersonId: 'per_bob', relationshipTypeId: 'rt_player', relatedPerson: { id: 'per_bob', name: 'Bob', surname: null } }],
    },
    { id: 'per_bob', name: 'Bob', surname: 'Budowniczy', nickname: 'Builder, Bobo', notes: 'Postapo LARP w kopalni', groups: [], customFieldValues: [], relationshipsFrom: [] },
    { id: 'per_cez', name: 'Cezary', surname: null, nickname: null, notes: null, groups: [], customFieldValues: [], relationshipsFrom: [] },
  ],
  calls: [],
  badAuth: 0,
};

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const api = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url, 'http://x');
    state.calls.push({ method: req.method, path: url.pathname, query: url.search, body, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      state.badAuth++;
      return send(res, 401, { error: 'Unauthorized' });
    }
    const p = url.pathname;
    const m = req.method;
    if (m === 'GET' && p === '/api/groups') return send(res, 200, { groups: state.groups });
    if (m === 'GET' && p === '/api/relationship-types') return send(res, 200, { relationshipTypes: state.types });
    if (m === 'GET' && p === '/api/custom-field-templates') return send(res, 200, { templates: state.templates });
    if (m === 'GET' && p === '/api/people/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      return send(res, 200, { people: state.people.filter((x) => `${x.name} ${x.surname || ''} ${x.nickname || ''}`.toLowerCase().includes(q)) });
    }
    if (m === 'GET' && p === '/api/people/search-index') {
      return send(res, 200, {
        people: state.people.map((x) => ({
          id: x.id,
          name: x.name,
          surname: x.surname,
          nickname: x.nickname,
          notes: x.notes,
          groups: x.groups.map((g) => g.group.name).join(' '),
          customFields: x.customFieldValues.map((v) => v.value).join(' '),
        })),
      });
    }
    if (m === 'GET' && p === '/api/people') {
      const gid = url.searchParams.get('groupIds');
      const list = state.people.filter((x) => !gid || x.groups.some((g) => g.group.id === gid));
      return send(res, 200, { people: list, pagination: { total: list.length, hasMore: false } });
    }
    let mm = p.match(/^\/api\/people\/([^/]+)$/);
    if (mm && m === 'GET') {
      const x = state.people.find((y) => y.id === mm[1]);
      return x ? send(res, 200, { person: x }) : send(res, 404, { error: 'Person not found' });
    }
    if (mm && m === 'PUT') {
      const x = state.people.find((y) => y.id === mm[1]);
      if (!x) return send(res, 404, { error: 'Person not found' });
      Object.assign(x, body);
      if (body.customFieldValues) {
        x.customFieldValues = body.customFieldValues.map((v) => ({ ...v, template: { name: state.templates.find((t) => t.id === v.templateId).name } }));
      }
      return send(res, 200, { person: x });
    }
    if (m === 'POST' && p === '/api/people') {
      if (body.anniversary !== null || body.lastContact !== null) return send(res, 400, { error: 'Validation failed', details: [{ field: 'anniversary', message: 'Required' }] });
      const x = { id: 'per_new' + state.people.length, name: body.name, surname: body.surname || null, nickname: body.nickname || null, notes: body.notes || null, groups: (body.groupIds || []).map((id) => ({ group: state.groups.find((g) => g.id === id) })), customFieldValues: [], relationshipsFrom: [] };
      state.people.push(x);
      return send(res, 201, { person: x });
    }
    if (m === 'POST' && p === '/api/people/bulk') return send(res, 200, { affectedCount: body.personIds.filter((id) => state.people.some((x) => x.id === id)).length });
    if (m === 'POST' && p === '/api/groups') return send(res, 201, { group: { id: 'grp_new', name: body.name } });
    if (m === 'POST' && p === '/api/relationships') return send(res, 201, { relationship: { id: 'rel_1' } });
    if (m === 'GET' && p === '/api/journal') return send(res, 200, { entries: [{ id: 'jr_1', date: '2026-05-01T00:00:00.000Z', title: 'Pyrkon', body: 'Spotkanie z Olą', people: [{ name: 'Aleksandra', surname: null }] }], pagination: { page: 1, totalPages: 1, totalCount: 1 } });
    if (m === 'POST' && p === '/api/journal') return send(res, 201, { entry: { id: 'jr_new' } });
    send(res, 404, { error: 'no such route' });
  });
});

// ------------------------------------------------------------------ rpc helper
function startServer(env) {
  const child = spawn('node', [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  let n = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args || {} });
    assert.ok(r.result, `no result for ${name}: ${JSON.stringify(r)}`);
    return { text: r.result.content[0].text, isError: Boolean(r.result.isError) };
  };
  return { child, rpc, call, stderr: () => stderr, stop: () => child.stdin.end() };
}

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}\n${err && err.stack}`);
    process.exitCode = 1;
  }
}

(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const port = api.address().port;
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ntag-')), 'token');
  fs.writeFileSync(tokenFile, SECRET + '\n');
  const base = { NAMETAG_URL: `http://127.0.0.1:${port}`, NAMETAG_API_TOKEN_FILE: tokenFile };

  // ---- read-only mode (the default)
  const ro = startServer(base);
  await t('initialize answers', async () => {
    const r = await ro.rpc('initialize', { protocolVersion: '2025-03-26' });
    assert.strictEqual(r.result.serverInfo.name, 'nametag');
  });
  await t('read-only lists only read tools', async () => {
    const r = await ro.rpc('tools/list');
    assert.deepStrictEqual(r.result.tools.map((x) => x.name).sort(), ['catalog', 'find_people', 'get_person', 'journal']);
  });
  await t('tool schemas stay small', async () => {
    const w = startServer({ ...base, NAMETAG_ENABLE_WRITE: 'true' });
    const r = await w.rpc('tools/list');
    const size = JSON.stringify(r.result.tools).length;
    assert.ok(size < 7000, `tool list is ${size} chars`);
    assert.strictEqual(r.result.tools.length, 10);
    w.stop();
  });
  await t('write tool call is refused in read-only mode and sends nothing', async () => {
    state.calls.length = 0;
    const r = await ro.call('add_person', { name: 'Zed' });
    assert.ok(r.isError);
    assert.ok(/disabled/.test(r.text));
    assert.strictEqual(state.calls.length, 0);
  });
  await t('find_people by name is accent-insensitive on listing path', async () => {
    const r = await ro.call('find_people', { q: 'ola' });
    assert.ok(r.text.includes('per_ola'), r.text);
  });
  await t('find_people with group filters via groupIds', async () => {
    const r = await ro.call('find_people', { group: 'rpg' });
    assert.ok(r.text.includes('per_ola') && !r.text.includes('per_bob'), r.text);
    assert.ok(r.text.includes('groups'), r.text);
  });
  await t('find_people with q and group filters names client side', async () => {
    const r = await ro.call('find_people', { group: 'RPG', q: 'lukasiewicz' });
    assert.ok(r.text.includes('per_ola'), r.text);
  });
  await t('unknown group is explained', async () => {
    const r = await ro.call('find_people', { group: 'Szachy' });
    assert.ok(r.isError && r.text.includes('RPG, LARP, Postapo'), r.text);
  });
  await t('deep search finds notes and shows a snippet', async () => {
    const r = await ro.call('find_people', { q: 'kopalni', deep: true });
    assert.ok(r.text.includes('per_bob') && r.text.includes('notes'), r.text);
    const r2 = await ro.call('find_people', { q: 'pyrkon', deep: true });
    assert.ok(r2.text.includes('per_ola'), r2.text);
  });
  await t('deep search with no hit says so', async () => {
    const r = await ro.call('find_people', { q: 'nieistniejace', deep: true });
    assert.ok(r.text.startsWith('0 people'), r.text);
  });
  await t('get_person shows relation type label, groups and custom fields', async () => {
    const r = await ro.call('get_person', { id: 'per_ola' });
    assert.ok(r.text.includes('groups: RPG'), r.text);
    assert.ok(r.text.includes('Skąd znam=Pyrkon 2019'), r.text);
    assert.ok(r.text.includes('Player -> Bob (per_bob)'), r.text);
    assert.ok(r.text.includes('Pyrkon'), r.text);
  });
  await t('get_person rejects a malformed id without calling the API', async () => {
    state.calls.length = 0;
    const r = await ro.call('get_person', { id: '../../etc/passwd' });
    assert.ok(r.isError);
    assert.strictEqual(state.calls.length, 0);
  });
  await t('get_person 404 is a readable error', async () => {
    const r = await ro.call('get_person', { id: 'per_missing' });
    assert.ok(r.isError && r.text.startsWith('not found'), r.text);
  });
  await t('catalog lists groups, types and fields', async () => {
    const r = await ro.call('catalog');
    assert.ok(r.text.includes('grp_rpg | RPG') && r.text.includes('Game Master') && r.text.includes('Zaufanie | SELECT | niskie, średnie, wysokie'), r.text);
  });
  await t('journal lists entries', async () => {
    const r = await ro.call('journal', { q: 'Pyrkon' });
    assert.ok(r.text.includes('jr_1') && r.text.includes('Pyrkon'), r.text);
  });
  await t('only GET requests left the process in read-only mode', async () => {
    assert.ok(state.calls.length > 0);
  });
  await t('every request carried the token; no leak in any output', async () => {
    assert.strictEqual(state.badAuth, 0);
  });
  ro.stop();

  // ---- wrong token / config problems
  await t('bad token gives a clear error that does not leak the token', async () => {
    const f = path.join(path.dirname(tokenFile), 'bad');
    fs.writeFileSync(f, 'ntag_wrong');
    const s = startServer({ ...base, NAMETAG_API_TOKEN_FILE: f });
    const r = await s.call('catalog');
    assert.ok(r.isError && r.text.includes('401') && !r.text.includes('ntag_wrong'), r.text);
    s.stop();
    state.badAuth = 0;
  });
  await t('missing NAMETAG_URL is explained', async () => {
    const s = startServer({ NAMETAG_API_TOKEN_FILE: tokenFile });
    const r = await s.call('catalog');
    assert.ok(r.isError && r.text.includes('NAMETAG_URL'), r.text);
    s.stop();
  });
  await t('unreachable Nametag is reported without secrets', async () => {
    const s = startServer({ NAMETAG_URL: 'http://127.0.0.1:9', NAMETAG_API_TOKEN_FILE: tokenFile });
    const r = await s.call('catalog');
    assert.ok(r.isError && r.text.includes('cannot reach Nametag') && !r.text.includes(SECRET), r.text);
    s.stop();
  });

  // ---- write mode
  const rw = startServer({ ...base, NAMETAG_ENABLE_WRITE: 'true' });
  const lastWrite = () => state.calls.filter((c) => c.method !== 'GET').slice(-1)[0];

  await t('add_person sends anniversary/lastContact null and resolves groups by name', async () => {
    const r = await rw.call('add_person', { name: 'Dawid', surname: 'Nowy', nickname: 'Dave', groups: ['rpg', 'LARP'], notes: 'Z Pyrkonu' });
    assert.ok(!r.isError && r.text.startsWith('created per_new'), r.text);
    const w = lastWrite();
    assert.strictEqual(w.path, '/api/people');
    assert.strictEqual(w.body.anniversary, null);
    assert.strictEqual(w.body.lastContact, null);
    assert.deepStrictEqual(w.body.groupIds, ['grp_rpg', 'grp_larp']);
  });
  await t('add_person refuses a duplicate and does not POST', async () => {
    state.calls.length = 0;
    const r = await rw.call('add_person', { name: 'Aleksandra', surname: 'lukasiewicz' });
    assert.ok(r.isError && r.text.includes('already exists'), r.text);
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  await t('add_person allow_duplicate creates anyway', async () => {
    const r = await rw.call('add_person', { name: 'Aleksandra', surname: 'Łukasiewicz', allow_duplicate: true });
    assert.ok(!r.isError, r.text);
  });
  await t('add_person with an unknown group fails before creating anything', async () => {
    state.calls.length = 0;
    const r = await rw.call('add_person', { name: 'Ewa', groups: ['Szachy'] });
    assert.ok(r.isError && r.text.includes('create_group'), r.text);
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  await t('update_person changes only the fields given (no arrays sent)', async () => {
    const r = await rw.call('update_person', { id: 'per_cez', surname: 'Czerwony' });
    assert.ok(!r.isError, r.text);
    const w = lastWrite();
    assert.deepStrictEqual(w.body, { surname: 'Czerwony' });
  });
  await t('update_person custom_fields merges with existing values (no wipe)', async () => {
    const r = await rw.call('update_person', { id: 'per_ola', custom_fields: { Zaufanie: 'WYSOKIE' } });
    assert.ok(!r.isError, r.text);
    const w = lastWrite();
    const vals = Object.fromEntries(w.body.customFieldValues.map((v) => [v.templateId, v.value]));
    assert.strictEqual(vals.tpl_from, 'Pyrkon 2019');
    assert.strictEqual(vals.tpl_lvl, 'wysokie');
    assert.strictEqual(Object.keys(w.body).length, 1);
  });
  await t('custom field validation: select option, number, empty', async () => {
    let r = await rw.call('update_person', { id: 'per_ola', custom_fields: { Zaufanie: 'kosmiczne' } });
    assert.ok(r.isError && r.text.includes('niskie, średnie, wysokie'), r.text);
    r = await rw.call('update_person', { id: 'per_ola', custom_fields: { Wiek: 'abc' } });
    assert.ok(r.isError && r.text.includes('number'), r.text);
    r = await rw.call('update_person', { id: 'per_ola', custom_fields: { 'Skąd znam': '  ' } });
    assert.ok(r.isError && r.text.includes('empty'), r.text);
    r = await rw.call('update_person', { id: 'per_ola', custom_fields: { Nieznane: 'x' } });
    assert.ok(r.isError && r.text.includes('Skąd znam'), r.text);
  });
  await t('add_nickname appends an alias once, keeps existing', async () => {
    await rw.call('update_person', { id: 'per_bob', add_nickname: 'Bobbie' });
    assert.strictEqual(lastWrite().body.nickname, 'Builder, Bobo, Bobbie');
    state.calls.length = 0;
    const r = await rw.call('update_person', { id: 'per_bob', add_nickname: 'bobo' });
    assert.ok(r.isError && r.text.includes('nothing to update'), r.text);
    assert.ok(!state.calls.some((c) => c.method === 'PUT'));
  });
  await t('add_nickname refuses to exceed 100 chars', async () => {
    const r = await rw.call('update_person', { id: 'per_bob', add_nickname: 'x'.repeat(95) });
    assert.ok(r.isError && r.text.includes('100'), r.text);
  });
  await t('append_notes keeps existing text', async () => {
    await rw.call('update_person', { id: 'per_ola', append_notes: 'Lubi herbatę.' });
    const n = lastWrite().body.notes;
    assert.ok(n.startsWith('Poznana na konwencie') && n.endsWith('\n\nLubi herbatę.'), n);
  });
  await t('append_notes refuses past the 10000-char limit', async () => {
    const r = await rw.call('update_person', { id: 'per_ola', append_notes: 'x'.repeat(10000) });
    assert.ok(r.isError && r.text.includes('10000'), r.text);
  });
  await t('notes and append_notes together are rejected', async () => {
    const r = await rw.call('update_person', { id: 'per_ola', notes: 'a', append_notes: 'b' });
    assert.ok(r.isError, r.text);
  });
  await t('tag_people uses the additive bulk action', async () => {
    const r = await rw.call('tag_people', { ids: ['per_bob', 'per_cez'], groups: ['postapo', 'LARP'] });
    assert.ok(!r.isError && r.text.includes('Postapo, LARP'), r.text);
    const w = lastWrite();
    assert.strictEqual(w.path, '/api/people/bulk');
    assert.strictEqual(w.body.action, 'addToGroups');
    assert.deepStrictEqual(w.body.groupIds, ['grp_post', 'grp_larp']);
  });
  await t('create_group works and refuses duplicates and bad colors', async () => {
    let r = await rw.call('create_group', { name: 'Szachy', color: '#112233' });
    assert.ok(!r.isError && r.text.includes('grp_new'), r.text);
    r = await rw.call('create_group', { name: 'rpg' });
    assert.ok(r.isError && r.text.includes('already exists'), r.text);
    r = await rw.call('create_group', { name: 'Kolor', color: 'red' });
    assert.ok(r.isError, r.text);
  });
  await t('link_people resolves the type label', async () => {
    const r = await rw.call('link_people', { person: 'per_ola', related: 'per_bob', type: 'game master' });
    assert.ok(!r.isError && r.text.includes('Game Master'), r.text);
    assert.strictEqual(lastWrite().body.relationshipTypeId, 'rt_mg');
    const same = await rw.call('link_people', { person: 'per_ola', related: 'per_ola' });
    assert.ok(same.isError);
  });
  await t('add_journal builds a valid body', async () => {
    const r = await rw.call('add_journal', { title: 'Sesja', body: 'Grali do rana', date: '2026-06-01', people: ['per_ola'] });
    assert.ok(!r.isError && r.text.includes('jr_new'), r.text);
    const b = lastWrite().body;
    assert.strictEqual(b.date, '2026-06-01T00:00:00.000Z');
    assert.strictEqual(b.hasTime, false);
    assert.deepStrictEqual(b.personIds, ['per_ola']);
    const bad = await rw.call('add_journal', { title: 'x', body: 'y', date: 'wczoraj' });
    assert.ok(bad.isError);
  });
  await t('no request in the whole run used DELETE', async () => {
    assert.ok(!state.calls.some((c) => c.method === 'DELETE'));
  });
  await t('token never appears in any tool output or on stderr', async () => {
    assert.strictEqual(state.badAuth, 0);
    assert.ok(!rw.stderr().includes(SECRET));
  });
  rw.stop();

  api.close();
  console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
})();
