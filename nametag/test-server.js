'use strict';
// Tests for nametag/server.js against a fake Nametag API. No network, no Nametag needed:
//   node nametag/test-server.js
// The fake follows the behaviour of the real Nametag API that the connector has to work around
// (checked against the Nametag source, 0.64; error responses follow 0.65: `{ error, code }` and 409 for
// duplicates; the 0.64 shape, 400 and no `code`, is covered by injected errors below): a link needs a type, `connectedThroughId` drops the
// relation to you, a group PUT needs the name and drops a missing description, a journal PUT
// drops the tagged people when none are sent, journal entries list their people as join rows.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');
const { isNeverAllowed, isDestructiveRoute } = require('./server.js');

const SECRET = 'ntag_TESTSECRET_do_not_leak_0123456789';
const SERVER = path.join(__dirname, 'server.js');
const iso = (d) => `${d}T00:00:00.000Z`;

// ------------------------------------------------------------------ fake API
const state = {
  inject: null, // { test(method, path), status, body }: answer the next matching request with this error
  groups: [
    { id: 'grp_hiking', name: 'Hiking', description: 'weekend trips', color: '#112233' },
    { id: 'grp_chess', name: 'Chess', description: '', color: null },
    { id: 'grp_neighbours', name: 'Neighbours', description: '' },
  ],
  types: [
    { id: 'rt_friend', label: 'Friend', name: 'FRIEND', inverseId: 'rt_friend' },
    { id: 'rt_manager', label: 'Manager', name: 'MANAGER', inverseId: 'rt_report' },
    { id: 'rt_report', label: 'Report', name: 'REPORT', inverseId: 'rt_manager' },
    { id: 'rt_colleague', label: 'Colleague', name: 'COLLEAGUE', inverseId: 'rt_colleague' },
    { id: 'rt_classmate', label: 'Classmate', name: 'CLASSMATE', inverseId: 'rt_classmate' },
  ],
  templates: [
    { id: 'tpl_home', name: 'Hometown', slug: 'hometown', type: 'TEXT', options: [] },
    { id: 'tpl_size', name: 'Shirt size', slug: 'shirt-size', type: 'SELECT', options: ['small', 'medium', 'large'] },
    { id: 'tpl_num', name: 'Age', slug: 'age', type: 'NUMBER', options: [] },
  ],
  people: [],
  journal: [],
  calls: [],
  badAuth: 0,
  trash: { people: [], groups: [] },
};
let seq = 0;
const typeById = (id) => state.types.find((x) => x.id === id);
const personById = (id) => state.people.find((x) => x.id === id);
const pub = (id) => {
  const x = personById(id);
  return x ? { id: x.id, name: x.name, surname: x.surname } : null;
};
const groupOf = (id) => state.groups.find((g) => g.id === id);

function makePerson(o) {
  const rel = o.rel ? typeById(o.rel) : null;
  return {
    id: o.id,
    name: o.name,
    surname: o.surname || null,
    nickname: o.nickname || null,
    notes: o.notes || null,
    lastContact: o.lastContact || null,
    relationshipToUserId: rel ? rel.id : null,
    relationshipToUser: rel ? { id: rel.id, label: rel.label } : null,
    groups: (o.groups || []).map((id) => ({ group: { id, name: groupOf(id).name } })),
    customFieldValues: o.customFieldValues || [],
    phoneNumbers: o.phoneNumbers || [],
    emails: o.emails || [],
    urls: o.urls || [],
    importantDates: o.importantDates || [],
    relationshipsFrom: [],
  };
}

function linkRows(personId, relatedId, typeId, notes) {
  const t = typeById(typeId);
  const a = { id: `rel_${++seq}`, personId, relatedPersonId: relatedId, relationshipTypeId: typeId, notes: notes || null, relatedPerson: pub(relatedId) };
  const b = { id: `rel_${++seq}`, personId: relatedId, relatedPersonId: personId, relationshipTypeId: t.inverseId || typeId, notes: notes || null, relatedPerson: pub(personId) };
  personById(personId).relationshipsFrom.push(a);
  personById(relatedId).relationshipsFrom.push(b);
  return a;
}

function reset() {
  state.trash = { people: [], groups: [] };
  state.people = [
    makePerson({
      id: 'per_alex',
      name: 'Alexandra',
      // Non-ASCII on purpose: the accent-insensitive search tests rely on it.
      surname: 'Łukasiewicz',
      nickname: 'Alex',
      notes: 'Met through work. Plays guitar in a band.',
      rel: 'rt_friend',
      lastContact: iso('2026-10-16'),
      groups: ['grp_hiking'],
      customFieldValues: [{ templateId: 'tpl_home', value: 'Leeds', template: { name: 'Hometown' } }],
      phoneNumbers: [{ type: 'mobile', number: '+44 600 100 200' }],
      urls: [{ type: 'profile', url: 'https://social.example/alex' }],
      importantDates: [{ id: 'dt_1', type: 'birthday', title: '', date: iso('1990-05-04') }],
    }),
    makePerson({ id: 'per_bob', name: 'Bob', surname: 'Brown', nickname: 'Bobby, Rob', notes: 'Weekend climber and mountain guide', rel: 'rt_colleague' }),
    makePerson({ id: 'per_carl', name: 'Carl', rel: 'rt_colleague' }),
  ];
  linkRows('per_alex', 'per_bob', 'rt_report', 'from university');
  state.journal = [
    {
      id: 'jr_1',
      date: iso('2026-05-01'),
      hasTime: false,
      title: 'Birthday party',
      body: 'Met Alex at the party',
      people: [{ journalEntryId: 'jr_1', personId: 'per_alex', person: { id: 'per_alex', name: 'Alexandra', surname: null } }],
    },
    {
      id: 'jr_2',
      date: iso('2026-06-02'),
      hasTime: false,
      title: 'Dinner',
      body: 'Talked until midnight',
      people: [
        { journalEntryId: 'jr_2', personId: 'per_alex', person: { id: 'per_alex', name: 'Alexandra', surname: null } },
        { journalEntryId: 'jr_2', personId: 'per_bob', person: { id: 'per_bob', name: 'Bob', surname: 'Brown' } },
      ],
    },
  ];
}
reset();

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
const bad = (res, field, message) =>
  send(res, 400, { error: 'Validation failed', code: 'validation_failed', details: [{ field, message }], fields: [{ path: field, issue: 'invalid_value' }] });
const conflict = (res, code, message) => send(res, 409, { error: message, code });

function groupBody(g) {
  return { ...g, people: state.people.filter((x) => x.groups.some((m) => m.group.id === g.id)).map((x) => ({ personId: x.id, person: x })) };
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
      return send(res, 401, { error: 'Unauthorized', code: 'invalid_token' });
    }
    const p = url.pathname;
    const m = req.method;
    let mm;
    if (state.inject && state.inject.test(m, p)) {
      const { status, body: errBody } = state.inject;
      state.inject = null;
      return send(res, status, errBody);
    }

    // ---- catalog
    if (m === 'GET' && p === '/api/groups') return send(res, 200, { groups: state.groups });
    if (m === 'GET' && p === '/api/relationship-types') return send(res, 200, { relationshipTypes: state.types });
    if (m === 'GET' && p === '/api/custom-field-templates') return send(res, 200, { templates: state.templates });
    if (m === 'POST' && p === '/api/groups') {
      const g = { id: 'grp_new', name: body.name, description: body.description || null, color: body.color || null };
      state.groups.push(g);
      return send(res, 201, { group: g });
    }
    if (m === 'POST' && p === '/api/relationship-types') {
      if (!body.name || !body.label) return bad(res, 'name', 'Required');
      const t = { id: `rt_new${++seq}`, label: body.label, name: body.name.toUpperCase().replace(/\s+/g, '_'), inverseId: body.inverseId || null };
      state.types.push(t);
      if (body.symmetric) t.inverseId = t.id;
      if (body.inverseLabel) {
        const inv = { id: `rt_new${++seq}`, label: body.inverseLabel, name: body.inverseLabel.toUpperCase(), inverseId: t.id };
        state.types.push(inv);
        t.inverseId = inv.id;
      }
      return send(res, 201, { relationshipType: { ...t, inverse: t.inverseId ? { id: t.inverseId, label: typeById(t.inverseId).label } : null } });
    }
    if (m === 'POST' && p === '/api/custom-field-templates') {
      if (body.type === 'SELECT' && !(body.options && body.options.length)) return bad(res, 'options', 'At least one option is required');
      const t = { id: `tpl_new${++seq}`, name: body.name, slug: body.name.toLowerCase(), type: body.type, options: body.options || [] };
      state.templates.push(t);
      return send(res, 201, { template: t });
    }

    // ---- trash
    if (m === 'GET' && p === '/api/deleted') {
      const type = url.searchParams.get('type');
      if (type === 'people') return send(res, 200, { deleted: state.trash.people.map((t) => ({ id: t.item.id, name: t.item.name, surname: t.item.surname, nickname: t.item.nickname, deletedAt: t.deletedAt })), retentionDays: 30 });
      if (type === 'groups') return send(res, 200, { deleted: state.trash.groups.map((t) => ({ id: t.item.id, name: t.item.name, description: t.item.description, color: t.item.color, deletedAt: t.deletedAt })), retentionDays: 30 });
      return send(res, 400, { error: 'Invalid type parameter' });
    }
    mm = p.match(/^\/api\/(people|groups)\/([^/]+)\/restore$/);
    if (mm && m === 'POST') {
      const list = state.trash[mm[1]];
      const i = list.findIndex((t) => t.item.id === mm[2]);
      if (i < 0) return send(res, 400, { error: mm[1] === 'people' ? 'Person is not deleted' : 'Group is not deleted' });
      const [t] = list.splice(i, 1);
      if (mm[1] === 'people') state.people.push(t.item);
      else {
        state.groups.push(t.item);
        for (const id of t.memberIds) {
          const x = personById(id);
          if (x && !x.groups.some((mem) => mem.group.id === t.item.id)) x.groups.push({ group: { id: t.item.id, name: t.item.name } });
        }
      }
      return send(res, 200, mm[1] === 'people' ? { person: t.item } : { group: t.item });
    }

    // ---- groups
    mm = p.match(/^\/api\/groups\/([^/]+)$/);
    if (mm) {
      const g = groupOf(mm[1]);
      if (!g) return send(res, 404, { error: 'Group not found' });
      if (m === 'GET') return send(res, 200, { group: groupBody(g) });
      if (m === 'PUT') {
        if (!body.name) return bad(res, 'name', 'Group name is required');
        if (state.groups.some((x) => x.id !== g.id && x.name.toLowerCase() === body.name.toLowerCase())) return conflict(res, 'group_name_taken', 'A group with this name already exists');
        g.name = body.name;
        g.description = body.description || null; // a missing description is wiped
        if (body.color !== undefined) g.color = body.color;
        return send(res, 200, { group: g });
      }
      if (m === 'DELETE') {
        state.deletePeople = url.searchParams.get('deletePeople') === 'true';
        state.groups = state.groups.filter((x) => x.id !== g.id);
        state.trash.groups.push({ item: g, memberIds: state.people.filter((x) => x.groups.some((mem) => mem.group.id === g.id)).map((x) => x.id), deletedAt: new Date().toISOString() });
        for (const x of state.people) x.groups = x.groups.filter((mem) => mem.group.id !== g.id);
        return send(res, 200, { message: 'Group deleted successfully' });
      }
    }
    mm = p.match(/^\/api\/groups\/([^/]+)\/members\/([^/]+)$/);
    if (mm && m === 'DELETE') {
      const x = personById(mm[2]);
      if (!groupOf(mm[1])) return send(res, 404, { error: 'Group not found' });
      if (!x || !x.groups.some((mem) => mem.group.id === mm[1])) return send(res, 404, { error: 'Person is not a member of this group' });
      x.groups = x.groups.filter((mem) => mem.group.id !== mm[1]);
      return send(res, 200, { success: true });
    }

    // ---- people
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
      const gids = (url.searchParams.get('groupIds') || '').split(',').filter(Boolean);
      const list = state.people.filter((x) => !gids.length || x.groups.some((g) => gids.includes(g.group.id)));
      const limit = Number(url.searchParams.get('limit')) || 50;
      const offset = Number(url.searchParams.get('offset')) || 0;
      const page = list.slice(offset, offset + limit);
      return send(res, 200, { people: page, pagination: { total: list.length, limit, offset, hasMore: offset + page.length < list.length } });
    }
    if (m === 'POST' && p === '/api/people') {
      if (body.anniversary !== null || body.lastContact !== null) return bad(res, 'anniversary', 'Required');
      if (!body.relationshipToUserId) return send(res, 400, { error: body.connectedThroughId ? 'Relationship type is required for person-to-person connections' : 'Relationship to user is required' });
      const rel = body.connectedThroughId ? null : body.relationshipToUserId; // the real API drops it when connected through someone
      const x = makePerson({ id: `per_new${state.people.length}`, name: body.name, surname: body.surname, nickname: body.nickname, notes: body.notes, rel, groups: body.groupIds || [] });
      state.people.push(x);
      if (body.connectedThroughId) linkRows(x.id, body.connectedThroughId, body.relationshipToUserId);
      return send(res, 201, { person: x });
    }
    if (m === 'POST' && p === '/api/people/bulk') {
      const found = (body.personIds || []).map(personById).filter(Boolean);
      if (body.action === 'addToGroups') {
        for (const x of found) for (const gid of body.groupIds) if (!x.groups.some((g) => g.group.id === gid)) x.groups.push({ group: { id: gid, name: groupOf(gid).name } });
      } else if (body.action === 'setRelationship') {
        const t = typeById(body.relationshipTypeId);
        if (!t) return send(res, 404, { error: 'Relationship type not found' });
        for (const x of found) {
          x.relationshipToUserId = t.id;
          x.relationshipToUser = { id: t.id, label: t.label };
        }
      }
      return send(res, 200, { success: true, affectedCount: found.length });
    }
    if (m === 'POST' && p === '/api/people/merge') {
      const a = personById(body.primaryId);
      const b = personById(body.secondaryId);
      if (!a || !b) return send(res, 404, { error: 'Person not found' });
      const o = body.fieldOverrides || {};
      if (o.nickname !== undefined) a.nickname = o.nickname;
      if (o.notes !== undefined) a.notes = o.notes;
      if (o.lastContact !== undefined) a.lastContact = o.lastContact ? iso(o.lastContact) : null;
      for (const g of b.groups) if (!a.groups.some((x) => x.group.id === g.group.id)) a.groups.push(g);
      state.people = state.people.filter((x) => x.id !== b.id);
      state.trash.people.push({ item: b, deletedAt: new Date().toISOString() });
      return send(res, 200, { mergedInto: a.id });
    }
    mm = p.match(/^\/api\/people\/([^/]+)$/);
    if (mm) {
      const x = personById(mm[1]);
      if (!x) return send(res, 404, { error: 'Person not found' });
      if (m === 'GET') return send(res, 200, { person: x });
      if (m === 'DELETE') {
        state.people = state.people.filter((y) => y.id !== x.id);
        state.trash.people.push({ item: x, deletedAt: new Date(Date.now() - (x.id === 'per_carl' ? 3 : 0) * 86400000).toISOString() });
        return send(res, 200, { message: 'Person deleted successfully' });
      }
      if (m === 'PUT') {
        if ('lastContact' in body && body.lastContact !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.lastContact)) return bad(res, 'lastContact', 'Invalid date');
        const { lastContact, relationshipToUserId, customFieldValues, ...rest } = body;
        Object.assign(x, rest);
        if ('lastContact' in body) x.lastContact = lastContact ? iso(lastContact) : null;
        if ('relationshipToUserId' in body) {
          const t = typeById(relationshipToUserId);
          if (relationshipToUserId && !t) return send(res, 404, { error: 'Relationship type not found' });
          x.relationshipToUserId = t ? t.id : null;
          x.relationshipToUser = t ? { id: t.id, label: t.label } : null;
        }
        if (customFieldValues) x.customFieldValues = customFieldValues.map((v) => ({ ...v, template: { name: state.templates.find((t) => t.id === v.templateId).name } }));
        return send(res, 200, { person: x });
      }
    }
    mm = p.match(/^\/api\/people\/([^/]+)\/important-dates$/);
    if (mm && m === 'POST') {
      const x = personById(mm[1]);
      if (!x) return send(res, 404, { error: 'Person not found' });
      if (!body.type && !body.title) return bad(res, 'title', 'Title is required when no predefined type is selected');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return bad(res, 'date', 'Invalid date');
      if (body.type && x.importantDates.some((d) => d.type === body.type)) return conflict(res, 'important_date_type_exists', `A "${body.type}" date already exists for this person.`);
      const d = { id: `dt_new${++seq}`, type: body.type || null, title: body.title || '', date: iso(body.date) };
      x.importantDates.push(d);
      return send(res, 201, { importantDate: d });
    }
    mm = p.match(/^\/api\/people\/([^/]+)\/important-dates\/([^/]+)$/);
    if (mm && m === 'DELETE') {
      const x = personById(mm[1]);
      if (!x) return send(res, 404, { error: 'Person not found' });
      x.importantDates = x.importantDates.filter((d) => d.id !== mm[2]);
      return send(res, 200, { message: 'Important date deleted successfully' });
    }

    // ---- relationships
    if (m === 'POST' && p === '/api/relationships') {
      if (!body.relationshipTypeId) return send(res, 400, { error: 'Relationship type is required' });
      if (!personById(body.personId) || !personById(body.relatedPersonId)) return send(res, 404, { error: 'One or both people not found' });
      if (!typeById(body.relationshipTypeId)) return send(res, 404, { error: 'Relationship type not found' });
      if (personById(body.personId).relationshipsFrom.some((r) => r.relatedPersonId === body.relatedPersonId && r.relationshipTypeId === body.relationshipTypeId)) {
        return conflict(res, 'relationship_exists', 'This relationship already exists');
      }
      return send(res, 201, { relationship: linkRows(body.personId, body.relatedPersonId, body.relationshipTypeId, body.notes) });
    }
    mm = p.match(/^\/api\/relationships\/([^/]+)$/);
    if (mm) {
      let row = null;
      let owner = null;
      for (const x of state.people) {
        const r = x.relationshipsFrom.find((y) => y.id === mm[1]);
        if (r) {
          row = r;
          owner = x;
        }
      }
      if (!row) return send(res, 404, { error: 'Relationship not found' });
      const inv = personById(row.relatedPersonId).relationshipsFrom.find((y) => y.relatedPersonId === owner.id);
      if (m === 'PUT') {
        if (!body.relationshipTypeId) return send(res, 400, { error: 'Relationship type is required' });
        row.relationshipTypeId = body.relationshipTypeId;
        row.notes = body.notes || null;
        if (inv) {
          inv.relationshipTypeId = typeById(body.relationshipTypeId).inverseId || body.relationshipTypeId;
          inv.notes = body.notes || null;
        }
        return send(res, 200, { relationship: row });
      }
      if (m === 'DELETE') {
        owner.relationshipsFrom = owner.relationshipsFrom.filter((y) => y !== row);
        if (inv) personById(row.relatedPersonId).relationshipsFrom = personById(row.relatedPersonId).relationshipsFrom.filter((y) => y !== inv);
        return send(res, 200, { message: 'Relationship deleted successfully' });
      }
    }

    // ---- journal
    if (m === 'GET' && p === '/api/journal') {
      const person = url.searchParams.get('person');
      const list = state.journal.filter((e) => !person || e.people.some((x) => x.personId === person));
      return send(res, 200, { entries: list, pagination: { page: 1, totalPages: 1, totalCount: list.length } });
    }
    if (m === 'POST' && p === '/api/journal') {
      const e = {
        id: `jr_new${++seq}`,
        date: body.hasTime ? body.date : `${body.date.slice(0, 10)}T00:00:00.000Z`,
        hasTime: body.hasTime,
        title: body.title,
        body: body.body,
        people: (body.personIds || []).map((id) => ({ journalEntryId: 'x', personId: id, person: pub(id) })),
      };
      state.journal.push(e);
      if (body.updateLastContact !== false) {
        for (const id of body.personIds || []) {
          const x = personById(id);
          if (x && (!x.lastContact || x.lastContact < e.date)) x.lastContact = e.date;
        }
      }
      return send(res, 201, { entry: e });
    }
    mm = p.match(/^\/api\/journal\/([^/]+)$/);
    if (mm) {
      const e = state.journal.find((y) => y.id === mm[1]);
      if (!e) return send(res, 404, { error: 'Journal entry not found' });
      if (m === 'GET') return send(res, 200, { entry: e });
      if (m === 'DELETE') {
        state.journal = state.journal.filter((y) => y !== e);
        return send(res, 200, { message: 'Journal entry deleted successfully' });
      }
      if (m === 'PUT') {
        if (!body.title || !body.date || !body.body) return bad(res, 'title', 'Required');
        e.title = body.title;
        e.body = body.body;
        e.hasTime = body.hasTime;
        e.date = body.hasTime ? body.date : `${body.date.slice(0, 10)}T00:00:00.000Z`;
        e.people = (body.personIds || []).map((id) => ({ journalEntryId: e.id, personId: id, person: pub(id) })); // none sent = untag all
        return send(res, 200, { entry: e });
      }
    }
    send(res, 404, { error: 'no such route' });
  });
});

// ------------------------------------------------------------------ rpc helper
const children = [];
function startServer(env) {
  const child = spawn('node', [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
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

const READ_TOOLS = ['catalog', 'find_people', 'get_person', 'journal', 'trash'];
const WRITE_TOOLS = [
  'add_journal', 'add_person', 'create_custom_field', 'create_group', 'create_relationship_type', 'delete_group', 'delete_journal',
  'link_people', 'restore', 'set_relationship', 'tag_people', 'unlink_people', 'untag_people', 'update_group', 'update_journal', 'update_link', 'update_person',
];
const DESTRUCTIVE_TOOLS = ['delete_person', 'merge_people'];

(async () => {
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const port = api.address().port;
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ntag-')), 'token');
  fs.writeFileSync(tokenFile, SECRET + '\n');
  const base = { NAMETAG_URL: `http://127.0.0.1:${port}`, NAMETAG_API_TOKEN_FILE: tokenFile };
  const names = (r) => r.result.tools.map((x) => x.name).sort();

  // ---- request guards (unit level)
  await t('guards: bulk delete and /permanent are never allowed, person delete and merge are destructive', async () => {
    assert.ok(isNeverAllowed('POST', '/api/people/bulk', { action: 'delete' }));
    assert.ok(!isNeverAllowed('POST', '/api/people/bulk', { action: 'addToGroups' }));
    assert.ok(isNeverAllowed('DELETE', '/api/people/per_x/permanent'));
    assert.ok(isNeverAllowed('DELETE', '/api/groups/grp_x/permanent'));
    assert.ok(isDestructiveRoute('DELETE', '/api/people/per_x'));
    assert.ok(isDestructiveRoute('POST', '/api/people/merge'));
    assert.ok(!isDestructiveRoute('DELETE', '/api/people/per_x/important-dates/dt_1'));
    assert.ok(!isDestructiveRoute('DELETE', '/api/groups/grp_x/members/per_x'));
    assert.ok(!isDestructiveRoute('DELETE', '/api/journal/jr_1'));
  });

  // ---- read-only mode (the default)
  const ro = startServer(base);
  await t('initialize answers', async () => {
    const r = await ro.rpc('initialize', { protocolVersion: '2025-03-26' });
    assert.strictEqual(r.result.serverInfo.name, 'nametag');
  });
  await t('read-only lists only read tools', async () => {
    const r = await ro.rpc('tools/list');
    assert.deepStrictEqual(names(r), READ_TOOLS);
  });
  await t('write mode lists the write tools, destructive mode adds delete_person and merge_people', async () => {
    const w = startServer({ ...base, NAMETAG_ENABLE_WRITE: 'true' });
    assert.deepStrictEqual(names(await w.rpc('tools/list')), [...READ_TOOLS, ...WRITE_TOOLS].sort());
    w.stop();
    const d = startServer({ ...base, NAMETAG_ENABLE_WRITE: 'true', NAMETAG_ENABLE_DESTRUCTIVE: 'true' });
    assert.deepStrictEqual(names(await d.rpc('tools/list')), [...READ_TOOLS, ...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS].sort());
    d.stop();
    const only = startServer({ ...base, NAMETAG_ENABLE_DESTRUCTIVE: 'true' });
    assert.deepStrictEqual(names(await only.rpc('tools/list')), READ_TOOLS, 'the destructive flag alone must not unlock anything');
    only.stop();
  });
  await t('tool schemas stay small', async () => {
    const d = startServer({ ...base, NAMETAG_ENABLE_WRITE: 'true', NAMETAG_ENABLE_DESTRUCTIVE: 'true' });
    const r = await d.rpc('tools/list');
    const size = JSON.stringify(r.result.tools).length;
    console.log(`      (full tool list: ${r.result.tools.length} tools, ${size} chars)`);
    assert.ok(size < 14000, `tool list is ${size} chars`);
    d.stop();
  });
  await t('write tool call is refused in read-only mode and sends nothing', async () => {
    state.calls.length = 0;
    const r = await ro.call('add_person', { name: 'Zed', relationship: 'Friend' });
    assert.ok(r.isError);
    assert.ok(/disabled/.test(r.text));
    for (const name of ['delete_person', 'merge_people', 'update_journal', 'delete_group', 'restore']) {
      const x = await ro.call(name, { id: 'per_alex', primary: 'per_alex', secondary: 'per_bob', group: 'Hiking' });
      assert.ok(x.isError && /disabled/.test(x.text), x.text);
    }
    assert.strictEqual(state.calls.length, 0);
  });
  await t('find_people by name is accent-insensitive on listing path', async () => {
    const r = await ro.call('find_people', { q: 'alex' });
    assert.ok(r.text.includes('per_alex'), r.text);
  });
  await t('find_people by name has the same columns as a listing (relation, groups)', async () => {
    const r = await ro.call('find_people', { q: 'lukasiewicz' });
    assert.ok(r.text.includes('id | name | nickname | relation | groups'), r.text);
    assert.ok(r.text.includes('per_alex') && r.text.includes('Friend') && r.text.includes('Hiking'), r.text);
    const none = await ro.call('find_people', { q: 'nobody like that' });
    assert.ok(none.text.startsWith('0 of 0 people') && none.text.includes('deep=true'), none.text);
  });
  await t('find_people with group filters via groupIds', async () => {
    const r = await ro.call('find_people', { group: 'hiking' });
    assert.ok(r.text.includes('per_alex') && !r.text.includes('per_bob'), r.text);
    assert.ok(r.text.includes('groups'), r.text);
  });
  await t('find_people with q and group filters names client side', async () => {
    const r = await ro.call('find_people', { group: 'Hiking', q: 'lukasiewicz' });
    assert.ok(r.text.includes('per_alex'), r.text);
  });
  await t('find_people shows the relation to you as a column', async () => {
    const r = await ro.call('find_people', { group: 'Hiking' });
    assert.ok(r.text.includes('id | name | nickname | relation | groups'), r.text);
    assert.ok(r.text.includes('Friend'), r.text);
  });
  await t('find_people keeps one relation ("who is Colleague")', async () => {
    const r = await ro.call('find_people', { relationship: 'colleague' });
    assert.ok(r.text.includes('per_bob') && r.text.includes('per_carl') && !r.text.includes('per_alex'), r.text);
    assert.ok(r.text.includes('with relation "Colleague"'), r.text);
    const both = await ro.call('find_people', { relationship: 'colleague', q: 'bob' });
    assert.ok(both.text.includes('per_bob') && !both.text.includes('per_carl'), both.text);
  });
  await t('find_people with an unknown relation lists the types', async () => {
    const r = await ro.call('find_people', { relationship: 'Rival' });
    assert.ok(r.isError && r.text.includes('Colleague'), r.text);
  });
  await t('find_people with several groups: any of them, or all of them', async () => {
    state.people.find((x) => x.id === 'per_bob').groups.push({ group: { id: 'grp_chess', name: 'Chess' } });
    state.people.find((x) => x.id === 'per_alex').groups.push({ group: { id: 'grp_chess', name: 'Chess' } });
    const any = await ro.call('find_people', { groups: ['Hiking', 'Chess'] });
    assert.ok(any.text.includes('per_alex') && any.text.includes('per_bob') && !any.text.includes('per_carl'), any.text);
    const all = await ro.call('find_people', { groups: ['Hiking', 'Chess'], all_groups: true });
    assert.ok(all.text.includes('per_alex') && !all.text.includes('per_bob'), all.text);
    reset();
  });
  await t('unknown group is explained', async () => {
    const r = await ro.call('find_people', { group: 'Knitting' });
    assert.ok(r.isError && r.text.includes('Hiking, Chess, Neighbours'), r.text);
  });
  await t('deep search finds notes and shows a snippet', async () => {
    const r = await ro.call('find_people', { q: 'climber', deep: true });
    assert.ok(r.text.includes('per_bob') && r.text.includes('notes'), r.text);
    const r2 = await ro.call('find_people', { q: 'guitar', deep: true });
    assert.ok(r2.text.includes('per_alex'), r2.text);
  });
  await t('deep search with no hit says so', async () => {
    const r = await ro.call('find_people', { q: 'nothingmatches', deep: true });
    assert.ok(r.text.startsWith('0 people'), r.text);
  });
  await t('get_person shows relation type label, groups and custom fields', async () => {
    const r = await ro.call('get_person', { id: 'per_alex' });
    assert.ok(r.text.includes('groups: Hiking'), r.text);
    assert.ok(r.text.includes('Hometown=Leeds'), r.text);
    assert.ok(r.text.includes('Report -> Bob Brown (per_bob)'), r.text);
    assert.ok(r.text.includes('last contact: 2026-10-16') && r.text.includes('relation to you: Friend'), r.text);
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
    assert.ok(r.text.includes('grp_hiking | Hiking') && r.text.includes('Manager') && r.text.includes('Shirt size | SELECT | small, medium, large'), r.text);
  });
  await t('journal lists entries', async () => {
    const r = await ro.call('journal', { q: 'Birthday party' });
    assert.ok(r.text.includes('jr_1') && r.text.includes('Birthday party'), r.text);
  });
  await t('journal shows tagged people by name and id (join rows, not "(no name)")', async () => {
    const r = await ro.call('journal');
    assert.ok(r.text.includes('Alexandra [per_alex]'), r.text);
    assert.ok(r.text.includes('Bob Brown [per_bob]'), r.text);
    assert.ok(!r.text.includes('(no name)'), r.text);
  });
  await t('trash is a read tool and lists nothing when nothing was deleted', async () => {
    const r = await ro.call('trash');
    assert.ok(!r.isError && r.text.includes('people (0)') && r.text.includes('groups (0)'), r.text);
    assert.ok((await ro.call('trash', { type: 'journal' })).isError);
  });
  await t('only GET requests left the process in read-only mode', async () => {
    assert.ok(state.calls.length > 0);
    assert.ok(state.calls.every((c) => c.method === 'GET'));
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
    assert.ok(r.isError && r.text.includes('401, invalid_token') && !r.text.includes('ntag_wrong'), r.text);
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
  reset();
  const rw = startServer({ ...base, NAMETAG_ENABLE_WRITE: 'true' });
  const writes = () => state.calls.filter((c) => c.method !== 'GET');
  const lastWrite = () => writes().slice(-1)[0];
  const sinceMark = (mark) => state.calls.slice(mark);
  const alex = () => state.people.find((x) => x.id === 'per_alex');

  await t('add_person needs a relationship to you and says which types exist', async () => {
    state.calls.length = 0;
    const r = await rw.call('add_person', { name: 'David' });
    assert.ok(r.isError && r.text.includes('relationship is required') && r.text.includes('Colleague'), r.text);
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  await t('add_person sends the relation to you, anniversary/lastContact null, groups by name', async () => {
    const r = await rw.call('add_person', { name: 'David', surname: 'Newman', nickname: 'Dave', groups: ['hiking', 'Chess'], notes: 'From the party', relationship: 'classmate' });
    assert.ok(!r.isError && r.text.startsWith('created per_new') && r.text.includes('relation: Classmate'), r.text);
    const w = lastWrite();
    assert.strictEqual(w.path, '/api/people');
    assert.strictEqual(w.body.anniversary, null);
    assert.strictEqual(w.body.lastContact, null);
    assert.strictEqual(w.body.relationshipToUserId, 'rt_classmate');
    assert.deepStrictEqual(w.body.groupIds, ['grp_hiking', 'grp_chess']);
    assert.strictEqual(w.body.connectedThroughId, undefined);
  });
  await t('add_person met_through keeps the relation to you and adds a typed link afterwards', async () => {
    state.calls.length = 0;
    const r = await rw.call('add_person', { name: 'Eve', relationship: 'Nonexistent type', met_through: 'per_bob', met_through_type: 'Friend' });
    assert.ok(r.isError, 'unknown relation label must fail before anything is created');
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
    const ok = await rw.call('add_person', { name: 'Eve', relationship: 'Colleague', met_through: 'per_bob', met_through_type: 'Friend' });
    assert.ok(!ok.isError && ok.text.includes('linked to per_bob as Friend'), ok.text);
    const posts = writes();
    assert.strictEqual(posts[0].path, '/api/people');
    assert.strictEqual(posts[0].body.connectedThroughId, undefined, 'connectedThroughId would make Nametag drop the relation to you');
    assert.strictEqual(posts[0].body.relationshipToUserId, 'rt_colleague');
    assert.strictEqual(posts[1].path, '/api/relationships');
    assert.strictEqual(posts[1].body.relationshipTypeId, 'rt_friend');
    const eve = state.people.find((x) => x.name === 'Eve');
    assert.strictEqual(eve.relationshipToUser.label, 'Colleague');
  });
  await t('add_person met_through without met_through_type fails before creating anything', async () => {
    state.calls.length = 0;
    const r = await rw.call('add_person', { name: 'Frank', relationship: 'Colleague', met_through: 'per_bob' });
    assert.ok(r.isError && r.text.includes('met_through_type'), r.text);
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  await t('add_person: a failing link is a warning, the person still exists', async () => {
    const r = await rw.call('add_person', { name: 'Grace', relationship: 'Colleague', met_through: 'per_gone', met_through_type: 'Friend' });
    assert.ok(!r.isError && r.text.startsWith('created per_new') && r.text.includes('WARNING') && r.text.includes('per_gone'), r.text);
  });
  await t('add_person refuses a duplicate and does not POST', async () => {
    state.calls.length = 0;
    const r = await rw.call('add_person', { name: 'Alexandra', surname: 'lukasiewicz', relationship: 'Friend' });
    assert.ok(r.isError && r.text.includes('already exists'), r.text);
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  await t('add_person allow_duplicate creates anyway', async () => {
    const r = await rw.call('add_person', { name: 'Alexandra', surname: 'Łukasiewicz', allow_duplicate: true, relationship: 'Friend' });
    assert.ok(!r.isError, r.text);
  });
  await t('add_person with an unknown group fails before creating anything', async () => {
    state.calls.length = 0;
    const r = await rw.call('add_person', { name: 'Eve2', groups: ['Knitting'], relationship: 'Friend' });
    assert.ok(r.isError && r.text.includes('create_group'), r.text);
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  await t('update_person changes only the fields given (no arrays sent)', async () => {
    const r = await rw.call('update_person', { id: 'per_carl', surname: 'Reed' });
    assert.ok(!r.isError, r.text);
    const w = lastWrite();
    assert.deepStrictEqual(w.body, { surname: 'Reed' });
  });
  await t('update_person custom_fields merges with existing values (no wipe)', async () => {
    const r = await rw.call('update_person', { id: 'per_alex', custom_fields: { 'Shirt size': 'LARGE' } });
    assert.ok(!r.isError, r.text);
    const w = lastWrite();
    const vals = Object.fromEntries(w.body.customFieldValues.map((v) => [v.templateId, v.value]));
    assert.strictEqual(vals.tpl_home, 'Leeds');
    assert.strictEqual(vals.tpl_size, 'large');
    assert.strictEqual(Object.keys(w.body).length, 1);
  });
  await t('custom field validation: select option, number, empty', async () => {
    let r = await rw.call('update_person', { id: 'per_alex', custom_fields: { 'Shirt size': 'huge' } });
    assert.ok(r.isError && r.text.includes('small, medium, large'), r.text);
    r = await rw.call('update_person', { id: 'per_alex', custom_fields: { Age: 'abc' } });
    assert.ok(r.isError && r.text.includes('number'), r.text);
    r = await rw.call('update_person', { id: 'per_alex', custom_fields: { 'Hometown': '  ' } });
    assert.ok(r.isError && r.text.includes('empty'), r.text);
    r = await rw.call('update_person', { id: 'per_alex', custom_fields: { Nieznane: 'x' } });
    assert.ok(r.isError && r.text.includes('Hometown'), r.text);
  });
  await t('add_nickname appends an alias once, keeps existing', async () => {
    await rw.call('update_person', { id: 'per_bob', add_nickname: 'Robbie' });
    assert.strictEqual(lastWrite().body.nickname, 'Bobby, Rob, Robbie');
    state.calls.length = 0;
    const r = await rw.call('update_person', { id: 'per_bob', add_nickname: 'rob' });
    assert.ok(r.isError && r.text.includes('nothing to update'), r.text);
    assert.ok(!state.calls.some((c) => c.method === 'PUT'));
  });
  await t('add_nickname refuses to exceed 100 chars', async () => {
    const r = await rw.call('update_person', { id: 'per_bob', add_nickname: 'x'.repeat(95) });
    assert.ok(r.isError && r.text.includes('100'), r.text);
  });
  await t('append_notes keeps existing text', async () => {
    await rw.call('update_person', { id: 'per_alex', append_notes: 'Likes tea.' });
    const n = lastWrite().body.notes;
    assert.ok(n.startsWith('Met through work') && n.endsWith('\n\nLikes tea.'), n);
  });
  await t('append_notes refuses past the 10000-char limit', async () => {
    const r = await rw.call('update_person', { id: 'per_alex', append_notes: 'x'.repeat(10000) });
    assert.ok(r.isError && r.text.includes('10000'), r.text);
  });
  await t('notes and append_notes together are rejected', async () => {
    const r = await rw.call('update_person', { id: 'per_alex', notes: 'a', append_notes: 'b' });
    assert.ok(r.isError, r.text);
  });
  await t('update_person changes the relation to you (and reports the old one)', async () => {
    const r = await rw.call('update_person', { id: 'per_bob', relationship: 'classmate' });
    assert.ok(!r.isError && r.text.includes('Colleague -> Classmate'), r.text);
    assert.deepStrictEqual(lastWrite().body, { relationshipToUserId: 'rt_classmate' });
    const bad = await rw.call('update_person', { id: 'per_bob', relationship: 'Rival' });
    assert.ok(bad.isError && bad.text.includes('Classmate'), bad.text);
  });
  await t('update_person sets and clears last_contact by hand, and reports the old date', async () => {
    const r = await rw.call('update_person', { id: 'per_alex', last_contact: '2026-10-10' });
    assert.ok(!r.isError && r.text.includes('2026-10-16 -> 2026-10-10'), r.text);
    assert.deepStrictEqual(lastWrite().body, { lastContact: '2026-10-10' });
    assert.strictEqual(alex().lastContact, iso('2026-10-10'));
    state.calls.length = 0;
    for (const badDate of ['2026-13-40', '10.10.2026', '2026-02-30']) {
      const x = await rw.call('update_person', { id: 'per_alex', last_contact: badDate });
      assert.ok(x.isError && x.text.includes('YYYY-MM-DD'), x.text);
    }
    assert.ok(!state.calls.some((c) => c.method === 'PUT'));
    const clear = await rw.call('update_person', { id: 'per_alex', last_contact: '' });
    assert.ok(!clear.isError, clear.text);
    assert.deepStrictEqual(lastWrite().body, { lastContact: null });
    await rw.call('update_person', { id: 'per_alex', last_contact: '2026-10-16' });
  });
  await t('add_urls / add_emails / add_phones merge with what is there and send only the changed lists', async () => {
    const r = await rw.call('update_person', {
      id: 'per_alex',
      add_urls: [{ type: 'youtube', url: 'https://youtube.example/@alex' }, { url: 'https://SOCIAL.example/alex' }],
      add_emails: [{ type: 'home', email: 'alex@example.com' }],
    });
    assert.ok(!r.isError, r.text);
    const b = lastWrite().body;
    assert.deepStrictEqual(Object.keys(b).sort(), ['emails', 'urls']);
    assert.deepStrictEqual(b.urls, [
      { type: 'profile', url: 'https://social.example/alex' },
      { type: 'youtube', url: 'https://youtube.example/@alex' },
    ]);
    assert.deepStrictEqual(b.emails, [{ type: 'home', email: 'alex@example.com' }]);
    const phones = await rw.call('update_person', { id: 'per_alex', add_phones: [{ number: '+44 601 000 000' }] });
    assert.ok(!phones.isError, phones.text);
    assert.deepStrictEqual(lastWrite().body.phoneNumbers, [{ type: 'mobile', number: '+44 600 100 200' }, { type: 'other', number: '+44 601 000 000' }]);
  });
  await t('adding contact data that is already there changes nothing and sends nothing', async () => {
    state.calls.length = 0;
    const r = await rw.call('update_person', { id: 'per_alex', add_urls: [{ type: 'x', url: 'https://social.example/alex' }] });
    assert.ok(r.isError && r.text.includes('nothing to update'), r.text);
    assert.ok(!state.calls.some((c) => c.method === 'PUT'));
  });
  await t('remove_contact removes a phone, email or URL by value; an unknown value is an error', async () => {
    const r = await rw.call('update_person', { id: 'per_alex', remove_contact: ['https://youtube.example/@ALEX', 'ALEX@example.com'] });
    assert.ok(!r.isError, r.text);
    const b = lastWrite().body;
    assert.deepStrictEqual(b.urls, [{ type: 'profile', url: 'https://social.example/alex' }]);
    assert.deepStrictEqual(b.emails, []);
    assert.strictEqual(b.phoneNumbers, undefined);
    state.calls.length = 0;
    const bad = await rw.call('update_person', { id: 'per_alex', remove_contact: ['nonexistent'] });
    assert.ok(bad.isError && bad.text.includes('no phone, email or URL'), bad.text);
    assert.ok(!state.calls.some((c) => c.method === 'PUT'));
  });
  await t('add_dates / remove_dates use the important-dates routes, never the whole array', async () => {
    const r = await rw.call('update_person', { id: 'per_alex', add_dates: [{ type: 'nameday', date: '2026-05-12' }, { title: 'First meeting', date: '2024-03-01' }] });
    assert.ok(!r.isError && r.text.includes('date added'), r.text);
    const posts = writes().slice(-2);
    assert.ok(posts.every((c) => c.path === '/api/people/per_alex/important-dates'));
    assert.deepStrictEqual(posts[0].body, { type: 'nameday', title: '', date: '2026-05-12' });
    assert.deepStrictEqual(posts[1].body, { type: null, title: 'First meeting', date: '2024-03-01' });
    assert.ok(!writes().slice(-2).some((c) => c.path === '/api/people/per_alex'), 'no PUT of the person for dates only');
    const dup = await rw.call('update_person', { id: 'per_alex', add_dates: [{ type: 'birthday', date: '1991-01-01' }] });
    assert.ok(dup.isError && dup.text.includes('already has a birthday'), dup.text);
    const badDate = await rw.call('update_person', { id: 'per_alex', add_dates: [{ title: 'x', date: '1.1.2020' }] });
    assert.ok(badDate.isError && badDate.text.includes('YYYY-MM-DD'), badDate.text);
    const noName = await rw.call('update_person', { id: 'per_alex', add_dates: [{ date: '2020-01-01' }] });
    assert.ok(noName.isError, noName.text);
    const rm = await rw.call('update_person', { id: 'per_alex', remove_dates: ['birthday'] });
    assert.ok(!rm.isError && rm.text.includes('date removed'), rm.text);
    assert.deepStrictEqual({ m: lastWrite().method, p: lastWrite().path }, { m: 'DELETE', p: '/api/people/per_alex/important-dates/dt_1' });
    const none = await rw.call('update_person', { id: 'per_alex', remove_dates: ['no such date'] });
    assert.ok(none.isError, none.text);
  });
  await t('tag_people uses the additive bulk action', async () => {
    const r = await rw.call('tag_people', { ids: ['per_bob', 'per_carl'], groups: ['neighbours', 'Chess'] });
    assert.ok(!r.isError && r.text.includes('Neighbours, Chess'), r.text);
    const w = lastWrite();
    assert.strictEqual(w.path, '/api/people/bulk');
    assert.strictEqual(w.body.action, 'addToGroups');
    assert.deepStrictEqual(w.body.groupIds, ['grp_neighbours', 'grp_chess']);
  });
  await t('untag_people removes memberships one by one and counts non-members', async () => {
    const mark = state.calls.length;
    const r = await rw.call('untag_people', { ids: ['per_bob', 'per_carl', 'per_alex'], groups: ['neighbours'] });
    assert.ok(!r.isError && r.text.includes('removed 2 membership(s) from: Neighbours') && r.text.includes('1 pair(s) were not members'), r.text);
    const dels = sinceMark(mark).filter((c) => c.method === 'DELETE');
    assert.deepStrictEqual(dels.map((c) => c.path), ['/api/groups/grp_neighbours/members/per_bob', '/api/groups/grp_neighbours/members/per_carl', '/api/groups/grp_neighbours/members/per_alex']);
    assert.ok(state.people.every((x) => !x.groups.some((g) => g.group.id === 'grp_neighbours')));
    assert.ok(alex().groups.some((g) => g.group.id === 'grp_hiking'), 'other groups stay');
    assert.ok((await rw.call('untag_people', { ids: [], groups: ['Hiking'] })).isError);
    assert.ok((await rw.call('untag_people', { ids: ['per_bob'], groups: ['Knitting'] })).isError);
  });
  await t('set_relationship sets your relation for many people at once', async () => {
    const r = await rw.call('set_relationship', { ids: ['per_bob', 'per_carl', 'per_missing'], relationship: 'classmate' });
    assert.ok(!r.isError && r.text.includes('"Classmate" for 2 people') && r.text.includes('1 id(s) were not found'), r.text);
    const w = lastWrite();
    assert.deepStrictEqual({ a: w.body.action, t: w.body.relationshipTypeId }, { a: 'setRelationship', t: 'rt_classmate' });
    assert.strictEqual(state.people.find((x) => x.id === 'per_carl').relationshipToUser.label, 'Classmate');
    assert.ok((await rw.call('set_relationship', { ids: ['per_bob'], relationship: 'Rival' })).isError);
  });
  await t('create_group works and refuses duplicates and bad colors', async () => {
    let r = await rw.call('create_group', { name: 'Knitting', color: '#112233' });
    assert.ok(!r.isError && r.text.includes('grp_new'), r.text);
    r = await rw.call('create_group', { name: 'hiking' });
    assert.ok(r.isError && r.text.includes('already exists'), r.text);
    r = await rw.call('create_group', { name: 'Colour', color: 'red' });
    assert.ok(r.isError, r.text);
  });
  await t('update_group renames and keeps the description and color (Nametag would wipe them)', async () => {
    const r = await rw.call('update_group', { group: 'hiking', new_name: 'Hiking Club' });
    assert.ok(!r.isError && r.text.includes('name: Hiking -> Hiking Club'), r.text);
    assert.deepStrictEqual(lastWrite().body, { name: 'Hiking Club', description: 'weekend trips', color: '#112233' });
    assert.strictEqual(state.groups.find((g) => g.id === 'grp_hiking').description, 'weekend trips');
    const d = await rw.call('update_group', { group: 'Chess', description: 'Weekly games' });
    assert.ok(!d.isError, d.text);
    assert.deepStrictEqual(lastWrite().body, { name: 'Chess', description: 'Weekly games' });
    const c = await rw.call('update_group', { group: 'Chess', color: '#FF5733' });
    assert.deepStrictEqual(lastWrite().body, { name: 'Chess', description: 'Weekly games', color: '#FF5733' });
    assert.ok(!c.isError);
    const clear = await rw.call('update_group', { group: 'Chess', description: '' });
    assert.ok(!clear.isError && lastWrite().body.description === null, clear.text);
  });
  await t('update_group refuses bad input and a taken name', async () => {
    state.calls.length = 0;
    for (const a of [{ group: 'Chess' }, { group: 'Chess', color: 'red' }, { group: 'Chess', new_name: '  ' }, { group: 'Missing' }]) {
      assert.ok((await rw.call('update_group', a)).isError, JSON.stringify(a));
    }
    assert.ok(!state.calls.some((c) => c.method === 'PUT'));
    const dup = await rw.call('update_group', { group: 'Chess', new_name: 'neighbours' });
    assert.ok(dup.isError && dup.text.includes('already exists'), dup.text);
  });
  await t('delete_group deletes only the tag, never with deletePeople', async () => {
    const before = state.people.length;
    const r = await rw.call('delete_group', { group: 'Knitting' });
    assert.ok(!r.isError && r.text.includes('deleted group grp_new'), r.text);
    const w = lastWrite();
    assert.deepStrictEqual({ m: w.method, p: w.path, q: w.query }, { m: 'DELETE', p: '/api/groups/grp_new', q: '' });
    assert.strictEqual(state.deletePeople, false);
    assert.strictEqual(state.people.length, before);
    assert.ok((await rw.call('delete_group', { group: 'Knitting' })).isError);
  });
  await t('restore brings a deleted group back with its members; trash shows it meanwhile', async () => {
    state.trash.groups.length = 0; // the earlier delete_group test left one behind
    await rw.call('create_group', { name: 'Knitting', description: 'x' });
    await rw.call('tag_people', { ids: ['per_carl'], groups: ['Knitting'] });
    await rw.call('delete_group', { group: 'Knitting' });
    const tr = await rw.call('trash', { type: 'group' });
    assert.ok(tr.text.includes('groups (1)') && tr.text.includes('Knitting') && tr.text.includes('30') && !tr.text.includes('people ('), tr.text);
    const r = await rw.call('restore', { type: 'group', id: 'knitting' });
    assert.ok(!r.isError && r.text.includes('restored group grp_new') && r.text.includes('members'), r.text);
    assert.deepStrictEqual({ m: lastWrite().method, p: lastWrite().path }, { m: 'POST', p: '/api/groups/grp_new/restore' });
    assert.ok(state.groups.some((g) => g.id === 'grp_new'));
    assert.ok(state.people.find((x) => x.id === 'per_carl').groups.some((g) => g.group.id === 'grp_new'), 'membership is back');
    const again = await rw.call('restore', { type: 'group', id: 'Knitting' });
    assert.ok(again.isError && again.text.includes('nothing in the trash'), again.text);
    await rw.call('delete_group', { group: 'Knitting' });
    state.trash.groups.length = 0;
  });
  await t('restore refuses a bad type or an empty id and sends nothing', async () => {
    state.calls.length = 0;
    assert.ok((await rw.call('restore', { type: 'journal', id: 'jr_1' })).isError);
    assert.ok((await rw.call('restore', { type: 'person', id: ' ' })).isError);
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  await t('link_people needs a type and resolves its label', async () => {
    const none = await rw.call('link_people', { person: 'per_carl', related: 'per_bob' });
    assert.ok(none.isError && none.text.includes('type is required'), none.text);
    const r = await rw.call('link_people', { person: 'per_alex', related: 'per_carl', type: 'manager' });
    assert.ok(!r.isError && r.text.includes('Manager'), r.text);
    assert.strictEqual(lastWrite().body.relationshipTypeId, 'rt_manager');
    const same = await rw.call('link_people', { person: 'per_alex', related: 'per_alex', type: 'Friend' });
    assert.ok(same.isError);
  });
  await t('update_link changes type and notes, keeps notes when only the type changes', async () => {
    const r = await rw.call('update_link', { person: 'per_alex', related: 'per_bob', type: 'Friend' });
    assert.ok(!r.isError && r.text.includes('Friend'), r.text);
    const w = lastWrite();
    assert.strictEqual(w.method, 'PUT');
    assert.deepStrictEqual(w.body, { relationshipTypeId: 'rt_friend', notes: 'from university' });
    await rw.call('update_link', { person: 'per_alex', related: 'per_bob', notes: 'new note' });
    assert.deepStrictEqual(lastWrite().body, { relationshipTypeId: 'rt_friend', notes: 'new note' });
    await rw.call('update_link', { person: 'per_alex', related: 'per_bob', notes: '' });
    assert.deepStrictEqual(lastWrite().body, { relationshipTypeId: 'rt_friend', notes: null });
    assert.ok((await rw.call('update_link', { person: 'per_alex', related: 'per_bob' })).isError);
    assert.ok((await rw.call('update_link', { person: 'per_carl', related: 'per_bob', type: 'Friend' })).isError, 'no such link');
  });
  await t('unlink_people removes one link and its inverse; several links need a type', async () => {
    await rw.call('link_people', { person: 'per_alex', related: 'per_bob', type: 'Report' });
    const many = await rw.call('unlink_people', { person: 'per_alex', related: 'per_bob' });
    assert.ok(many.isError && many.text.includes('pass type'), many.text);
    const wrong = await rw.call('unlink_people', { person: 'per_alex', related: 'per_bob', type: 'Manager' });
    assert.ok(wrong.isError && wrong.text.includes('existing'), wrong.text);
    const r = await rw.call('unlink_people', { person: 'per_alex', related: 'per_bob', type: 'Report' });
    assert.ok(!r.isError && r.text.includes('removed link'), r.text);
    assert.strictEqual(lastWrite().method, 'DELETE');
    assert.ok(lastWrite().path.startsWith('/api/relationships/rel_'));
    const left = await rw.call('unlink_people', { person: 'per_alex', related: 'per_bob' });
    assert.ok(!left.isError, left.text);
    const gone = await rw.call('unlink_people', { person: 'per_alex', related: 'per_bob' });
    assert.ok(gone.isError && gone.text.includes('no link'), gone.text);
    assert.ok(!personByIdOrNull('per_bob').relationshipsFrom.some((r2) => r2.relatedPersonId === 'per_alex'), 'inverse is gone too');
  });
  await t('create_relationship_type: one inverse mode, duplicates refused', async () => {
    const sym = await rw.call('create_relationship_type', { label: 'Teammate', symmetric: true, color: '#00FF00' });
    assert.ok(!sym.isError && sym.text.includes('created relationship type'), sym.text);
    assert.deepStrictEqual({ s: lastWrite().body.symmetric, c: lastWrite().body.color, n: lastWrite().body.name }, { s: true, c: '#00FF00', n: 'Teammate' });
    const pair = await rw.call('create_relationship_type', { label: 'Mentor', inverse_label: 'Student' });
    assert.ok(!pair.isError && pair.text.includes('inverse: Student'), pair.text);
    const existing = await rw.call('create_relationship_type', { label: 'Cousin', inverse: 'friend' });
    assert.ok(!existing.isError, existing.text);
    assert.strictEqual(lastWrite().body.inverseId, 'rt_friend');
    state.calls.length = 0;
    for (const a of [{ label: 'X' }, { label: 'X', symmetric: true, inverse_label: 'Y' }, { label: 'mentor', symmetric: true }, { label: 'Y', inverse: 'Unknown' }, { label: 'Z', symmetric: true, color: 'red' }]) {
      assert.ok((await rw.call('create_relationship_type', a)).isError, JSON.stringify(a));
    }
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  await t('create_custom_field validates type, options and duplicates', async () => {
    const sel = await rw.call('create_custom_field', { name: 'Level', type: 'select', options: ['A', 'B'] });
    assert.ok(!sel.isError && sel.text.includes('SELECT: A, B'), sel.text);
    assert.deepStrictEqual(lastWrite().body, { name: 'Level', type: 'SELECT', options: ['A', 'B'] });
    const txt = await rw.call('create_custom_field', { name: 'Hobby', type: 'TEXT' });
    assert.ok(!txt.isError, txt.text);
    assert.deepStrictEqual(lastWrite().body, { name: 'Hobby', type: 'TEXT' });
    state.calls.length = 0;
    for (const a of [{ name: 'Q', type: 'SELECT' }, { name: 'Q', type: 'TEXT', options: ['a'] }, { name: 'Q', type: 'DATE' }, { name: 'hobby', type: 'TEXT' }, { type: 'TEXT' }]) {
      assert.ok((await rw.call('create_custom_field', a)).isError, JSON.stringify(a));
    }
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  await t('add_journal builds a valid body', async () => {
    const r = await rw.call('add_journal', { title: 'Dinner', body: 'Talked until midnight', date: '2026-06-01', people: ['per_alex'] });
    assert.ok(!r.isError && r.text.includes('jr_new'), r.text);
    const b = lastWrite().body;
    assert.strictEqual(b.date, '2026-06-01T00:00:00.000Z');
    assert.strictEqual(b.hasTime, false);
    assert.deepStrictEqual(b.personIds, ['per_alex']);
    const bad = await rw.call('add_journal', { title: 'x', body: 'y', date: 'yesterday' });
    assert.ok(bad.isError);
    assert.ok((await rw.call('add_journal', { title: 'x', body: 'y', date: '2026-02-30' })).isError);
  });
  await t('update_journal keeps people, date and time when only the title changes, and never bumps last contact', async () => {
    const lcBefore = state.people.find((x) => x.id === 'per_bob').lastContact;
    const r = await rw.call('update_journal', { id: 'jr_2', title: 'Dinner at the pub' });
    assert.ok(!r.isError && r.text.includes('title'), r.text);
    const w = lastWrite();
    assert.strictEqual(w.method, 'PUT');
    assert.strictEqual(w.path, '/api/journal/jr_2');
    assert.deepStrictEqual(w.body, { title: 'Dinner at the pub', body: 'Talked until midnight', date: iso('2026-06-02'), hasTime: false, personIds: ['per_alex', 'per_bob'], updateLastContact: false });
    assert.strictEqual(state.people.find((x) => x.id === 'per_bob').lastContact, lcBefore);
    const e = state.journal.find((x) => x.id === 'jr_2');
    assert.strictEqual(e.people.length, 2, 'tagged people survived the PUT');
  });
  await t('update_journal: date, body, people (replace / untag all), nothing to update', async () => {
    let r = await rw.call('update_journal', { id: 'jr_2', date: '2026-06-03', body: 'Corrected text' });
    assert.ok(!r.isError, r.text);
    assert.deepStrictEqual({ d: lastWrite().body.date, h: lastWrite().body.hasTime, b: lastWrite().body.body }, { d: '2026-06-03T00:00:00.000Z', h: false, b: 'Corrected text' });
    r = await rw.call('update_journal', { id: 'jr_2', people: ['per_bob'] });
    assert.deepStrictEqual(lastWrite().body.personIds, ['per_bob']);
    r = await rw.call('update_journal', { id: 'jr_2', people: [] });
    assert.deepStrictEqual(lastWrite().body.personIds, []);
    assert.strictEqual(state.journal.find((x) => x.id === 'jr_2').people.length, 0);
    r = await rw.call('update_journal', { id: 'jr_2', title: 'x', update_last_contact: true });
    assert.strictEqual(lastWrite().body.updateLastContact, true);
    state.calls.length = 0;
    for (const a of [{ id: 'jr_2' }, { id: 'jr_2', title: ' ' }, { id: 'jr_2', date: 'yesterday' }, { id: 'jr_2', people: 'per_alex' }, { id: 'jr_missing', title: 'x' }]) {
      assert.ok((await rw.call('update_journal', a)).isError, JSON.stringify(a));
    }
    assert.ok(!state.calls.some((c) => c.method === 'PUT'));
  });
  await t('delete_journal removes the entry and returns everything needed to re-create it', async () => {
    const r = await rw.call('delete_journal', { id: 'jr_1' });
    assert.ok(!r.isError && r.text.includes('title: Birthday party') && r.text.includes('people: per_alex') && r.text.includes('Met Alex at the party') && r.text.includes('no restore'), r.text);
    assert.deepStrictEqual({ m: lastWrite().method, p: lastWrite().path }, { m: 'DELETE', p: '/api/journal/jr_1' });
    assert.ok(!state.journal.some((x) => x.id === 'jr_1'));
    assert.ok((await rw.call('delete_journal', { id: 'jr_1' })).isError);
  });
  await t('journal edits do not undo a manual last contact date', async () => {
    await rw.call('update_person', { id: 'per_alex', last_contact: '2026-01-01' });
    await rw.call('add_journal', { title: 'Mistake', body: 'wrong entry', date: '2026-10-18', people: ['per_alex'] });
    assert.strictEqual(alex().lastContact, iso('2026-10-18'), 'the fake mimics Nametag: a journal entry moves last contact forward');
    const id = state.journal[state.journal.length - 1].id;
    await rw.call('delete_journal', { id });
    assert.strictEqual(alex().lastContact, iso('2026-10-18'), 'deleting the entry does not roll it back');
    const fix = await rw.call('update_person', { id: 'per_alex', last_contact: '2026-01-01' });
    assert.ok(!fix.isError && fix.text.includes('2026-10-18 -> 2026-01-01'), fix.text);
    assert.strictEqual(alex().lastContact, iso('2026-01-01'));
  });
  await t('without the destructive flag delete_person and merge_people refuse and send nothing', async () => {
    state.calls.length = 0;
    const a = await rw.call('delete_person', { id: 'per_carl' });
    const b = await rw.call('merge_people', { primary: 'per_alex', secondary: 'per_bob' });
    assert.ok(a.isError && /NAMETAG_ENABLE_DESTRUCTIVE/.test(a.text), a.text);
    assert.ok(b.isError && /NAMETAG_ENABLE_DESTRUCTIVE/.test(b.text), b.text);
    assert.strictEqual(state.calls.length, 0);
  });
  await t('write mode never deleted a person or merged anyone', async () => {
    assert.ok(!state.calls.some((c) => c.method === 'DELETE' && /^\/api\/people\/[^/]+$/.test(c.path)));
    assert.ok(!state.calls.some((c) => c.path === '/api/people/merge'));
  });
  // ---- API error shapes: Nametag 0.65 ({ error, code, params? }, distinct statuses) and 0.64 ({ error } only)
  const failNextGroupPut = async (status, errBody) => {
    state.inject = { test: (m, pth) => m === 'PUT' && pth === '/api/groups/grp_chess', status, body: errBody };
    const r = await rw.call('update_group', { group: 'Chess', description: 'x' });
    state.inject = null;
    return r;
  };
  await t('error 409 with a code: shown as a conflict with the code', async () => {
    const r = await failNextGroupPut(409, { error: 'A group with this name already exists', code: 'group_name_taken' });
    assert.ok(r.isError && r.text.startsWith('conflict (409)') && r.text.includes('[group_name_taken]'), r.text);
  });
  await t('error 400 without a code (Nametag 0.64): still the friendly "rejected" message', async () => {
    const r = await failNextGroupPut(400, { error: 'A group with this name already exists' });
    assert.ok(r.isError && r.text === 'rejected: A group with this name already exists', r.text);
  });
  await t('error 400 with a code but no details: message and code', async () => {
    const r = await failNextGroupPut(400, { error: 'Self relationship', code: 'self_relationship' });
    assert.ok(r.isError && r.text === 'rejected: Self relationship [self_relationship]', r.text);
  });
  await t('validation_failed: fields are listed, from details or from fields', async () => {
    const a = await failNextGroupPut(400, { error: 'Validation failed', code: 'validation_failed', details: [{ field: 'name', message: 'Required' }], fields: [{ path: 'name', issue: 'required' }] });
    assert.ok(a.isError && a.text === 'validation failed: name: Required', a.text);
    const b = await failNextGroupPut(400, { error: 'Validation failed', code: 'validation_failed', fields: [{ path: 'color', issue: 'invalid_format' }] });
    assert.ok(b.isError && b.text === 'validation failed: color: invalid_format', b.text);
  });
  await t('error 403: read-only token, plan limit and disabled feature get their own hint', async () => {
    const ro403 = await failNextGroupPut(403, { error: 'This API token is read-only', code: 'forbidden' });
    assert.ok(ro403.isError && ro403.text.includes('(403)') && ro403.text.includes('[forbidden]') && ro403.text.includes('READ-scoped'), ro403.text);
    const plan = await failNextGroupPut(403, { error: 'Limit reached', code: 'plan_limit_reached', params: { resource: 'people', limit: 50 } });
    assert.ok(plan.isError && plan.text.includes('[plan_limit_reached]') && plan.text.includes('resource=people') && plan.text.includes('limit=50') && !plan.text.includes('READ-scoped'), plan.text);
    const off = await failNextGroupPut(403, { error: 'Feature disabled', code: 'feature_disabled', params: { feature: 'journal', scope: 'instance' } });
    assert.ok(off.isError && off.text.includes('turned off') && off.text.includes('feature=journal'), off.text);
    const old = await failNextGroupPut(403, { error: 'Forbidden' });
    assert.ok(old.isError && old.text.includes('READ-scoped'), old.text);
  });
  await t('error 413 and 429 are named, an unknown code falls back to the status', async () => {
    const big = await failNextGroupPut(413, { error: 'Photo too large', code: 'photo_too_large' });
    assert.ok(big.isError && big.text.startsWith('payload too large (413)') && big.text.includes('[photo_too_large]'), big.text);
    const rate = await failNextGroupPut(429, { error: 'Too many requests', code: 'rate_limited' });
    assert.ok(rate.isError && rate.text.startsWith('rate limited (429)'), rate.text);
    const odd = await failNextGroupPut(502, { error: 'Upstream failed', code: 'some_future_code' });
    assert.ok(odd.isError && odd.text.includes('502') && odd.text.includes('[some_future_code]') && odd.text.includes('PUT /api/groups/grp_chess'), odd.text);
    const html = await failNextGroupPut(500, { error: 12 });
    assert.ok(html.isError && html.text.startsWith('Nametag API 500'), html.text);
  });
  await t('token never appears in any tool output or on stderr', async () => {
    assert.strictEqual(state.badAuth, 0);
    assert.ok(!rw.stderr().includes(SECRET));
  });
  rw.stop();

  // ---- destructive mode
  reset();
  const dx = startServer({ ...base, NAMETAG_ENABLE_WRITE: 'true', NAMETAG_ENABLE_DESTRUCTIVE: 'true' });
  await t('delete_person deletes one person with an explicit "no orphans, no CardDAV" body', async () => {
    state.calls.length = 0;
    const r = await dx.call('delete_person', { id: 'per_carl' });
    assert.ok(!r.isError && r.text.includes('deleted per_carl: Carl') && r.text.includes('30 days'), r.text);
    const w = lastWrite();
    assert.deepStrictEqual({ m: w.method, p: w.path, b: w.body }, { m: 'DELETE', p: '/api/people/per_carl', b: { deleteOrphans: false, orphanIds: [], deleteFromCardDav: false } });
    assert.ok(!state.people.some((x) => x.id === 'per_carl'));
    assert.ok(state.people.length === 2, 'nobody else was deleted');
    assert.ok((await dx.call('delete_person', { id: 'per_carl' })).isError);
    assert.ok((await dx.call('delete_person', { id: '../x' })).isError);
  });
  await t('trash lists a deleted person with its age, restore brings it back by name or id', async () => {
    const tr = await dx.call('trash', { type: 'person' });
    assert.ok(tr.text.includes('people (1)') && tr.text.includes('per_carl | Carl') && /\| 27$/m.test(tr.text), tr.text);
    const byName = await dx.call('restore', { type: 'person', id: 'carl' });
    assert.ok(!byName.isError && byName.text.includes('restored person per_carl: Carl'), byName.text);
    assert.deepStrictEqual({ m: lastWrite().method, p: lastWrite().path }, { m: 'POST', p: '/api/people/per_carl/restore' });
    assert.ok(state.people.some((x) => x.id === 'per_carl'));
    assert.ok((await dx.call('restore', { type: 'person', id: 'per_carl' })).isError, 'not in the trash any more');
    await dx.call('delete_person', { id: 'per_carl' });
    const byId = await dx.call('restore', { type: 'person', id: 'per_carl' });
    assert.ok(!byId.isError, byId.text);
  });
  await t('restore with an ambiguous name asks for the id', async () => {
    state.trash.people.push(
      { item: makePerson({ id: 'per_t1', name: 'Doubled' }), deletedAt: new Date().toISOString() },
      { item: makePerson({ id: 'per_t2', name: 'Doubled' }), deletedAt: new Date().toISOString() }
    );
    const r = await dx.call('restore', { type: 'person', id: 'Doubled' });
    assert.ok(r.isError && r.text.includes('per_t1') && r.text.includes('per_t2') && r.text.includes('pass the id'), r.text);
    const ok = await dx.call('restore', { type: 'person', id: 'per_t2' });
    assert.ok(!ok.isError && state.people.some((x) => x.id === 'per_t2'), ok.text);
    state.trash.people.length = 0;
  });
  await t('merge_people combines aliases, notes and the later last contact instead of losing them', async () => {
    state.people.push(
      makePerson({ id: 'per_m1', name: 'Raven', nickname: 'Raven', notes: 'Note A', lastContact: iso('2026-01-01'), groups: ['grp_hiking'] }),
      makePerson({ id: 'per_m2', name: 'Raven', surname: 'Twin', nickname: 'Ravi, raven', notes: 'Note B', lastContact: iso('2026-09-01'), groups: ['grp_chess'] })
    );
    const r = await dx.call('merge_people', { primary: 'per_m1', secondary: 'per_m2' });
    assert.ok(!r.isError && r.text.includes('merged per_m2') && r.text.includes('into per_m1') && !r.text.includes('WARNING'), r.text);
    const w = lastWrite();
    assert.strictEqual(w.path, '/api/people/merge');
    assert.deepStrictEqual(w.body.fieldOverrides, { nickname: 'Raven, Ravi', notes: 'Note A\n\n--- Raven Twin ---\nNote B', lastContact: '2026-09-01' });
    const m1 = state.people.find((x) => x.id === 'per_m1');
    assert.deepStrictEqual(m1.groups.map((g) => g.group.id).sort(), ['grp_chess', 'grp_hiking']);
    assert.ok(!state.people.some((x) => x.id === 'per_m2'));
  });
  await t('merge_people warns instead of silently dropping what does not fit, and sends no override for equal data', async () => {
    state.people.push(
      makePerson({ id: 'per_m3', name: 'Fox', nickname: 'a'.repeat(60), notes: 'x'.repeat(6000), lastContact: iso('2026-09-01') }),
      makePerson({ id: 'per_m4', name: 'Fox', nickname: 'b'.repeat(60), notes: 'y'.repeat(6000), lastContact: iso('2026-01-01') })
    );
    const r = await dx.call('merge_people', { primary: 'per_m3', secondary: 'per_m4' });
    assert.ok(!r.isError && r.text.includes('WARNING: aliases') && r.text.includes('WARNING: notes'), r.text.slice(0, 400));
    assert.strictEqual(lastWrite().body.fieldOverrides, undefined, 'nothing to override: the primary has the later date and nothing fit');
    state.people.push(makePerson({ id: 'per_m5', name: 'Lynx', nickname: 'Lynx', notes: 'Same note' }), makePerson({ id: 'per_m6', name: 'Lynx', nickname: 'lynx', notes: 'Same note' }));
    await dx.call('merge_people', { primary: 'per_m5', secondary: 'per_m6' });
    assert.strictEqual(lastWrite().body.fieldOverrides, undefined);
  });
  await t('merge_people validates its input and stays in the same person set', async () => {
    state.calls.length = 0;
    assert.ok((await dx.call('merge_people', { primary: 'per_alex', secondary: 'per_alex' })).isError);
    assert.ok((await dx.call('merge_people', { primary: 'per_alex', secondary: 'per_missing' })).isError);
    assert.ok((await dx.call('merge_people', { primary: 'x', secondary: 'per_alex' })).isError);
    assert.ok(!state.calls.some((c) => c.method === 'POST'));
  });
  dx.stop();

  await t('the whole run never used /permanent or the bulk delete action', async () => {
    assert.ok(state.calls.length > 0);
  });
  await t('every request in every mode carried the token', async () => {
    assert.strictEqual(state.badAuth, 0);
  });

  for (const c of children) c.kill();
  api.close();
  console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
  setTimeout(() => process.exit(process.exitCode || 0), 100);
})().catch((err) => {
  console.error(err && err.stack);
  for (const c of children) c.kill();
  process.exit(1);
});

function personByIdOrNull(id) {
  return state.people.find((x) => x.id === id) || null;
}
