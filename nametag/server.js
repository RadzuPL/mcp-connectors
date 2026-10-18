'use strict';
// nametag: a deliberately small MCP server for Nametag (https://github.com/mattogodoy/nametag),
// the self-hosted personal relationships manager.
//
// Design, in the spirit of docker-lite:
//   * short plain-text answers instead of raw API objects (less context sent to the model),
//   * read-only unless NAMETAG_ENABLE_WRITE=true; even then there is no delete, no merge, no
//     import/export and no account or token endpoint, so the worst a write token can do is add
//     or edit people, groups, links and journal entries (all of it undoable from the Nametag UI),
//   * the Nametag API token only ever goes to NAMETAG_URL and never appears in any output.
//
// Notes that shaped the write tools (checked against the Nametag source, 0.64):
//   * PUT /api/people/{id} only writes the fields it is sent, BUT arrays replace the whole set.
//     `customFieldValues` is a full replace (templates not in the request are deleted, an empty
//     list wipes everything). update_person therefore always reads the current values, merges,
//     and sends the complete list back. Group membership is added through the additive bulk
//     action instead of PUT `groupIds`, which would replace it.
//   * `nickname` is a single field (max 100 chars). Several aliases are kept comma separated.
//   * Notes are Markdown, max 10000 chars.
//
// No dependencies: Node core modules only; MCP over stdio (line-delimited JSON-RPC), wrapped by
// supergateway like every other gateway image in this repo.

const http = require('http');
const https = require('https');
const fs = require('fs');
const readline = require('readline');

const MAX_API_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20000; // absolute ceiling for any single tool result
const NOTES_LIMIT = 10000; // Nametag's own limit for a person's notes
const NICKNAME_LIMIT = 100;
const JOURNAL_BODY_LIMIT = 50000;
const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

class ToolError extends Error {}

// ------------------------------------------------------------------ config

function baseUrl() {
  const raw = process.env.NAMETAG_URL;
  if (!raw) throw new ToolError('NAMETAG_URL is not set (for example http://nametag:3000)');
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw new ToolError('NAMETAG_URL is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ToolError('NAMETAG_URL must start with http:// or https://');
  return u;
}

function apiToken() {
  const file = process.env.NAMETAG_API_TOKEN_FILE;
  let t = '';
  if (file) {
    try {
      t = fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new ToolError(`cannot read NAMETAG_API_TOKEN_FILE (${(err && err.code) || 'error'})`);
    }
  } else {
    t = (process.env.NAMETAG_API_TOKEN || '').trim();
  }
  if (!t) throw new ToolError('no Nametag API token: set NAMETAG_API_TOKEN_FILE (or NAMETAG_API_TOKEN)');
  return t;
}

function writeEnabled() {
  return /^(true|1|yes)$/i.test(process.env.NAMETAG_ENABLE_WRITE || '');
}

// --------------------------------------------------------------- Nametag API

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    // Last line of defence: in read-only mode nothing but GET ever leaves this process.
    if (method !== 'GET' && !writeEnabled()) {
      return reject(new ToolError('write tools are disabled (NAMETAG_ENABLE_WRITE is not true)'));
    }
    let base;
    let token;
    try {
      base = baseUrl();
      token = apiToken();
    } catch (err) {
      return reject(err);
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const lib = base.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: base.pathname.replace(/\/+$/, '') + path,
        method,
        headers,
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_API_BYTES) {
            req.destroy(new ToolError('Nametag response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            if (!text.trim()) return resolve({});
            try {
              return resolve(JSON.parse(text));
            } catch (_) {
              return reject(new ToolError(`Nametag answered ${status} but not with JSON (is NAMETAG_URL the app, not a proxy page?)`));
            }
          }
          reject(apiFailure(method, path, status, text));
        });
      }
    );
    req.on('timeout', () => req.destroy(new ToolError('Nametag API timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (path) => request('GET', path);

function apiFailure(method, path, status, text) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = null;
  }
  const msg = data && typeof data.error === 'string' ? data.error : '';
  const route = path.split('?')[0];
  if (status === 401) return new ToolError('Nametag rejected the API token (401): check NAMETAG_API_TOKEN_FILE');
  if (status === 403) {
    return new ToolError(`forbidden (403)${msg ? `: ${oneLine(msg, 160)}` : ''}; a READ-scoped token cannot write, or a plan limit was hit`);
  }
  if (status === 404) return new ToolError(`not found: ${msg ? oneLine(msg, 160) : route}`);
  if (status === 400 && data && Array.isArray(data.details) && data.details.length) {
    return new ToolError(
      'validation failed: ' +
        data.details
          .slice(0, 6)
          .map((d) => `${d.field}: ${d.message}`)
          .join('; ')
    );
  }
  if (status === 400 && msg) return new ToolError(`rejected: ${oneLine(msg, 200)}`);
  return new ToolError(`Nametag API ${status}${msg ? `: ${oneLine(msg, 200)}` : ''} (${method} ${route})`);
}

// --------------------------------------------------------------- formatting

const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function cap(text, max = MAX_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n[output cut at ${max} chars]`;
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Case- and accent-insensitive comparison ("Łukasz" matches "lukasz").
function norm(s) {
  return String(s === undefined || s === null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase();
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '' && v !== false) u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

function checkId(id, what = 'id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new ToolError(`${what} must be a Nametag id (take it from find_people)`);
  }
  return id;
}

function displayName(p) {
  const n = [p && p.name, p && p.surname].filter(Boolean).join(' ');
  return n || '(no name)';
}

function groupNames(p) {
  return ((p && p.groups) || [])
    .map((g) => (g && g.group && g.group.name) || (g && g.name))
    .filter(Boolean);
}

function day(iso) {
  return iso ? String(iso).slice(0, 10) : '';
}

function personRow(p, extra) {
  return [p.id, displayName(p), p.nickname ? `"${oneLine(p.nickname, 60)}"` : '', extra || ''].join(' | ');
}

// -------------------------------------------------------------- resolvers

async function loadGroups() {
  const r = await get('/api/groups');
  return r.groups || [];
}

function groupsHint(groups) {
  return groups.length ? groups.map((g) => g.name).join(', ') : 'none yet';
}

async function resolveGroup(input) {
  const groups = await loadGroups();
  const want = norm(String(input).trim());
  const g = groups.find((x) => x.id === input || norm(x.name) === want);
  if (!g) throw new ToolError(`unknown group "${input}" (groups: ${groupsHint(groups)}); create it with create_group`);
  return g;
}

async function resolveGroupIds(inputs) {
  const groups = await loadGroups();
  const ids = [];
  for (const input of inputs) {
    const want = norm(String(input).trim());
    const g = groups.find((x) => x.id === input || norm(x.name) === want);
    if (!g) throw new ToolError(`unknown group "${input}" (groups: ${groupsHint(groups)}); create it with create_group`);
    if (!ids.includes(g.id)) ids.push(g.id);
  }
  return { ids, groups };
}

async function loadRelTypes() {
  const r = await get('/api/relationship-types');
  return r.relationshipTypes || [];
}

async function resolveRelType(input) {
  const types = await loadRelTypes();
  const want = norm(String(input).trim());
  const t = types.find((x) => x.id === input || norm(x.label) === want || norm(x.name) === want);
  if (!t) throw new ToolError(`unknown relationship type "${input}" (types: ${types.map((x) => x.label).join(', ') || 'none'})`);
  return t;
}

// Builds the COMPLETE customFieldValues list for a PUT/POST. Nametag replaces the whole set, so
// existing values are carried over and only the requested ones are added or changed.
async function customFieldPayload(requested, existing) {
  const merged = new Map();
  for (const v of existing || []) {
    if (v && v.templateId && v.value !== undefined && v.value !== null && String(v.value).trim() !== '') {
      merged.set(v.templateId, String(v.value));
    }
  }
  const entries = Object.entries(requested || {});
  if (entries.length) {
    const r = await get('/api/custom-field-templates');
    const templates = r.templates || [];
    const known = templates.map((t) => t.name).join(', ') || 'none';
    for (const [key, raw] of entries) {
      const t = templates.find((x) => x.id === key || norm(x.slug) === norm(key) || norm(x.name) === norm(key));
      if (!t) throw new ToolError(`unknown custom field "${key}" (fields: ${known}); create it in Nametag under Settings > Custom Fields`);
      let value = typeof raw === 'boolean' || typeof raw === 'number' ? String(raw) : str(raw).trim();
      if (value === '') throw new ToolError(`custom field "${t.name}": empty values are not accepted; clear a field in the Nametag UI`);
      if (t.type === 'NUMBER' && !Number.isFinite(Number(value))) throw new ToolError(`custom field "${t.name}" must be a number`);
      if (t.type === 'BOOLEAN') {
        value = value.toLowerCase();
        if (value !== 'true' && value !== 'false') throw new ToolError(`custom field "${t.name}" must be true or false`);
      }
      if (t.type === 'SELECT') {
        const opts = t.options || [];
        const opt = opts.find((o) => norm(o) === norm(value));
        if (!opt) throw new ToolError(`custom field "${t.name}" must be one of: ${opts.join(', ')}`);
        value = opt;
      }
      if (value.length > 2000) throw new ToolError(`custom field "${t.name}" is longer than 2000 chars`);
      merged.set(t.id, value);
    }
  }
  return [...merged].map(([templateId, value]) => ({ templateId, value }));
}

// ----------------------------------------------------------------- read tools

async function toolFindPeople(args) {
  const q = str(args.q).trim();
  const groupArg = str(args.group).trim();
  const limit = clampInt(args.limit, 30, 1, 100);
  const offset = clampInt(args.offset, 0, 0, 100000);

  if (args.deep === true) {
    if (!q) throw new ToolError('deep search needs q');
    if (groupArg) throw new ToolError('deep cannot be combined with group; list the group first, or drop group');
    return deepSearch(q, limit);
  }

  const group = groupArg ? await resolveGroup(groupArg) : null;

  // Plain name/nickname search through the API.
  if (q && !group) {
    const r = await get(`/api/people/search${qs({ q })}`);
    const rows = (r.people || []).slice(0, limit);
    if (!rows.length) return `0 people match "${q}" in names or nicknames. Try deep=true to search notes, groups and custom fields.`;
    return cap(`${rows.length} match(es) for "${q}" in names/nicknames\nid | name | nickname\n` + rows.map((p) => personRow(p)).join('\n'));
  }

  // Listing, optionally narrowed by group; with both q and group the names are filtered here.
  const r = await get(
    `/api/people${qs({ limit: q ? 500 : limit, offset: q ? 0 : offset, includeDetails: 'false', groupIds: group && group.id })}`
  );
  let rows = r.people || [];
  let total = r.pagination && Number.isFinite(r.pagination.total) ? r.pagination.total : rows.length;
  let more = Boolean(r.pagination && r.pagination.hasMore);
  if (q) {
    const nq = norm(q);
    rows = rows.filter((p) => norm([p.name, p.surname, p.middleName, p.secondLastName, p.nickname].filter(Boolean).join(' ')).includes(nq));
    total = rows.length;
    more = rows.length > offset + limit;
    rows = rows.slice(offset, offset + limit);
  }
  const head =
    `${rows.length} of ${total} people${group ? ` in group "${group.name}"` : ''}${q ? ` matching "${q}"` : ''}` +
    (more ? `; more: offset=${offset + rows.length}` : '');
  if (!rows.length) return head;
  return cap(`${head}\nid | name | nickname | groups\n` + rows.map((p) => personRow(p, groupNames(p).join(', '))).join('\n'));
}

async function deepSearch(q, limit) {
  const r = await get('/api/people/search-index');
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const FIELDS = ['name', 'surname', 'middleName', 'secondLastName', 'nickname', 'organization', 'jobTitle', 'notes', 'groups', 'customFields'];
  const hits = [];
  for (const p of r.people || []) {
    const normed = {};
    for (const f of FIELDS) normed[f] = norm(p[f]);
    const all = FIELDS.map((f) => normed[f]).join(' \n ');
    if (!terms.every((t) => all.includes(t))) continue;
    const matched = FIELDS.filter((f) => terms.some((t) => normed[f].includes(t)));
    let snippet = '';
    for (const f of ['notes', 'customFields']) {
      if (!matched.includes(f)) continue;
      const idx = terms.map((t) => normed[f].indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      const orig = str(p[f]);
      snippet = ` "…${oneLine(orig.slice(Math.max(0, idx - 30), idx + 60), 90)}…"`;
      break;
    }
    hits.push(`${p.id} | ${displayName(p)} | ${p.nickname ? `"${oneLine(p.nickname, 60)}"` : ''} | matched: ${matched.join(', ')}${snippet}`);
  }
  if (!hits.length) return `0 people match "${q}" in names, notes, groups or custom fields`;
  const shown = hits.slice(0, limit);
  return cap(
    `${hits.length} match(es) for "${q}" in names, notes, groups, custom fields${hits.length > shown.length ? `; showing ${shown.length}` : ''}\n` +
      'id | name | nickname | matched\n' +
      shown.join('\n')
  );
}

function renderPerson(p, typeLabels) {
  const out = [];
  out.push(`id: ${p.id}`);
  const full = [p.prefix, p.name, p.middleName, p.surname, p.secondLastName, p.suffix].filter(Boolean).join(' ');
  out.push(`name: ${full || '(no name)'}`);
  if (p.nickname) out.push(`nickname: ${p.nickname}`);
  const work = [p.organization, p.jobTitle].filter(Boolean).join(' / ');
  if (work) out.push(`work: ${work}`);
  const groups = groupNames(p);
  if (groups.length) out.push(`groups: ${groups.join(', ')}`);
  if (p.relationshipToUser && p.relationshipToUser.label) out.push(`relation to you: ${p.relationshipToUser.label}`);
  if (p.lastContact) out.push(`last contact: ${day(p.lastContact)}`);
  const cfv = (p.customFieldValues || [])
    .map((v) => `${(v.template && v.template.name) || v.templateId}=${oneLine(v.value, 120)}`)
    .slice(0, 30);
  if (cfv.length) out.push(`custom fields: ${cfv.join('; ')}`);
  const raw = (p.customFields || []).map((f) => `${f.key}=${oneLine(f.value, 80)}`).slice(0, 10);
  if (raw.length) out.push(`other fields: ${raw.join('; ')}`);
  const contact = [];
  for (const x of p.phoneNumbers || []) contact.push(`${x.type} ${x.number}`);
  for (const x of p.emails || []) contact.push(`${x.type} ${x.email}`);
  for (const x of p.urls || []) contact.push(`${x.type} ${x.url}`);
  for (const x of p.imHandles || []) contact.push(`${x.protocol} ${x.handle}`);
  if (contact.length) out.push(`contact: ${contact.slice(0, 20).join('; ')}`);
  const dates = (p.importantDates || []).map((d) => `${d.title || d.type || 'date'} ${day(d.date)}`);
  if (p.anniversary) dates.push(`anniversary ${day(p.anniversary)}`);
  if (dates.length) out.push(`dates: ${dates.join('; ')}`);
  const rels = (p.relationshipsFrom || []).map((r) => {
    const label = (typeLabels && typeLabels.get(r.relationshipTypeId)) || (r.relationshipTypeId ? '?' : 'linked');
    return `${label} -> ${r.relatedPerson ? displayName(r.relatedPerson) : '?'} (${r.relatedPersonId})${r.notes ? ` [${oneLine(r.notes, 80)}]` : ''}`;
  });
  if (rels.length) out.push(`related: ${rels.slice(0, 40).join('; ')}`);
  out.push(`notes: ${p.notes ? `\n${p.notes}` : '(none)'}`);
  return out.join('\n');
}

async function toolGetPerson(args) {
  const id = checkId(args.id);
  const [pr, types] = await Promise.all([get(`/api/people/${encodeURIComponent(id)}`), get('/api/relationship-types').catch(() => null)]);
  const p = pr.person;
  if (!p) throw new ToolError('unexpected answer from Nametag (no person in it)');
  const labels = new Map(((types && types.relationshipTypes) || []).map((t) => [t.id, t.label]));
  return cap(renderPerson(p, labels));
}

async function toolCatalog() {
  const [g, t, c] = await Promise.all([
    get('/api/groups'),
    get('/api/relationship-types'),
    get('/api/custom-field-templates').catch((err) => ({ error: describeError(err) })),
  ]);
  const out = [];
  const groups = g.groups || [];
  out.push(`groups (${groups.length}): id | name | description`);
  for (const x of groups) out.push([x.id, x.name, oneLine(x.description, 80)].join(' | '));
  const types = t.relationshipTypes || [];
  out.push(`relationship types (${types.length}): id | label | inverse`);
  const byId = new Map(types.map((x) => [x.id, x.label]));
  for (const x of types) out.push([x.id, x.label, (x.inverseId && byId.get(x.inverseId)) || (x.inverse && x.inverse.label) || ''].join(' | '));
  if (c.error) {
    out.push(`custom fields: unavailable (${c.error})`);
  } else {
    const fields = c.templates || [];
    out.push(`custom fields (${fields.length}): id | name | type | options`);
    for (const x of fields) out.push([x.id, x.name, x.type, (x.options || []).join(', ')].join(' | '));
  }
  return cap(out.join('\n'));
}

async function toolJournal(args) {
  const page = clampInt(args.page, 1, 1, 10000);
  const person = args.person ? checkId(args.person, 'person') : '';
  const q = str(args.q).trim();
  const r = await get(`/api/journal${qs({ page, person, q })}`);
  const entries = r.entries || [];
  const pg = r.pagination;
  const head = `${entries.length} entries${pg ? ` (page ${pg.page}/${pg.totalPages}, ${pg.totalCount} total)` : ''}`;
  if (!entries.length) return head;
  return cap(
    `${head}\nid | date | title | people | start of text\n` +
      entries
        .map((e) =>
          [e.id, day(e.date), oneLine(e.title, 80), (e.people || []).map(displayName).join(', '), oneLine(e.body, 160)].join(' | ')
        )
        .join('\n')
  );
}

// ---------------------------------------------------------------- write tools

async function toolAddPerson(args) {
  const name = str(args.name).trim();
  if (!name) throw new ToolError('name is required');
  const surname = str(args.surname).trim();

  // Guard against creating the same person twice.
  if (args.allow_duplicate !== true) {
    const found = await get(`/api/people/search${qs({ q: name })}`);
    const wanted = norm([name, surname].filter(Boolean).join(' '));
    const same = (found.people || []).find((p) => norm(displayName(p)) === wanted);
    if (same) {
      throw new ToolError(
        `"${displayName(same)}" already exists (id ${same.id}); use update_person, or pass allow_duplicate=true to create another one`
      );
    }
  }

  const body = { name, anniversary: null, lastContact: null };
  const opt = (key, v) => {
    const s = str(v).trim();
    if (s) body[key] = s;
  };
  opt('surname', args.surname);
  opt('nickname', args.nickname);
  opt('organization', args.organization);
  opt('jobTitle', args.job_title);
  if (args.notes !== undefined && str(args.notes).trim()) {
    if (str(args.notes).length > NOTES_LIMIT) throw new ToolError(`notes are longer than ${NOTES_LIMIT} chars`);
    body.notes = str(args.notes);
  }
  if (Array.isArray(args.groups) && args.groups.length) body.groupIds = (await resolveGroupIds(args.groups)).ids;
  if (args.met_through) body.connectedThroughId = checkId(args.met_through, 'met_through');
  if (args.relationship) body.relationshipToUserId = (await resolveRelType(args.relationship)).id;
  if (args.custom_fields && typeof args.custom_fields === 'object') {
    const values = await customFieldPayload(args.custom_fields, []);
    if (values.length) body.customFieldValues = values;
  }
  const r = await request('POST', '/api/people', body);
  const p = r.person || {};
  const extras = [];
  if (body.groupIds) extras.push(`groups: ${groupNames(p).join(', ') || `${body.groupIds.length} added`}`);
  if (body.customFieldValues) extras.push(`${body.customFieldValues.length} custom field(s)`);
  return `created ${p.id}: ${displayName(p)}${extras.length ? ` (${extras.join('; ')})` : ''}`;
}

async function toolUpdatePerson(args) {
  const id = checkId(args.id);
  const body = {};
  const changed = [];
  const scalar = (arg, key, label, { required = false, max = 100 } = {}) => {
    if (args[arg] === undefined) return;
    const s = str(args[arg]).trim();
    if (required && !s) throw new ToolError(`${label} cannot be empty`);
    if (s.length > max) throw new ToolError(`${label} is longer than ${max} chars`);
    body[key] = s === '' ? null : s;
    changed.push(label);
  };
  scalar('name', 'name', 'name', { required: true });
  scalar('surname', 'surname', 'surname');
  scalar('nickname', 'nickname', 'nickname', { max: NICKNAME_LIMIT });
  scalar('organization', 'organization', 'organization', { max: 200 });
  scalar('job_title', 'jobTitle', 'job title', { max: 200 });

  if (args.notes !== undefined) {
    if (str(args.notes).length > NOTES_LIMIT) throw new ToolError(`notes are longer than ${NOTES_LIMIT} chars`);
    if (args.append_notes !== undefined) throw new ToolError('use either notes (replace) or append_notes, not both');
    body.notes = str(args.notes).trim() === '' ? null : str(args.notes);
    changed.push('notes (replaced)');
  }
  if (args.add_nickname !== undefined && args.nickname !== undefined) throw new ToolError('use either nickname (replace) or add_nickname, not both');

  const needCurrent = args.add_nickname !== undefined || args.append_notes !== undefined || (args.custom_fields && Object.keys(args.custom_fields).length);
  let cur = null;
  if (needCurrent) {
    const r = await get(`/api/people/${encodeURIComponent(id)}`);
    cur = r.person;
    if (!cur) throw new ToolError('unexpected answer from Nametag (no person in it)');
  }

  if (args.add_nickname !== undefined) {
    const add = str(args.add_nickname).trim();
    if (!add) throw new ToolError('add_nickname is empty');
    const aliases = str(cur.nickname)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!aliases.some((a) => norm(a) === norm(add))) aliases.push(add);
    const joined = aliases.join(', ');
    if (joined.length > NICKNAME_LIMIT) {
      throw new ToolError(`nicknames would be ${joined.length} chars; Nametag allows ${NICKNAME_LIMIT}. Current: ${cur.nickname}. Put the extra alias in the notes instead`);
    }
    if (joined !== str(cur.nickname)) {
      body.nickname = joined;
      changed.push('nickname (alias added)');
    }
  }

  if (args.append_notes !== undefined) {
    const text = str(args.append_notes).trim();
    if (!text) throw new ToolError('append_notes is empty');
    const existing = str(cur.notes);
    const next = existing ? `${existing}\n\n${text}` : text;
    if (next.length > NOTES_LIMIT) {
      throw new ToolError(`notes would be ${next.length} chars; Nametag allows ${NOTES_LIMIT} (now ${existing.length}). Put long text into a journal entry (add_journal)`);
    }
    body.notes = next;
    changed.push('notes (appended)');
  }

  if (args.custom_fields && typeof args.custom_fields === 'object' && Object.keys(args.custom_fields).length) {
    body.customFieldValues = await customFieldPayload(args.custom_fields, cur.customFieldValues);
    changed.push('custom fields');
  }

  if (!Object.keys(body).length) throw new ToolError('nothing to update: pass at least one field');
  const r = await request('PUT', `/api/people/${encodeURIComponent(id)}`, body);
  const p = r.person || { id };
  return `updated ${id}: ${displayName(p)}; changed: ${changed.join(', ')}`;
}

async function toolTagPeople(args) {
  const ids = Array.isArray(args.ids) ? args.ids.map((x) => checkId(x, 'ids[]')) : [];
  if (!ids.length) throw new ToolError('ids must list at least one person id');
  if (ids.length > 100) throw new ToolError('at most 100 people per call');
  if (!Array.isArray(args.groups) || !args.groups.length) throw new ToolError('groups must list at least one group name or id');
  const { ids: groupIds, groups } = await resolveGroupIds(args.groups);
  const r = await request('POST', '/api/people/bulk', { action: 'addToGroups', personIds: ids, groupIds });
  const names = groupIds.map((gid) => (groups.find((g) => g.id === gid) || {}).name || gid).join(', ');
  const affected = Number.isFinite(r.affectedCount) ? r.affectedCount : ids.length;
  const missing = ids.length - affected;
  return `added ${affected} people to: ${names} (existing memberships are kept, nobody is removed)` + (missing > 0 ? `; ${missing} id(s) were not found` : '');
}

async function toolCreateGroup(args) {
  const name = str(args.name).trim();
  if (!name) throw new ToolError('name is required');
  if (name.length > 100) throw new ToolError('name is longer than 100 chars');
  const groups = await loadGroups();
  const same = groups.find((g) => norm(g.name) === norm(name));
  if (same) throw new ToolError(`group "${same.name}" already exists (id ${same.id})`);
  const body = { name };
  if (str(args.description).trim()) body.description = str(args.description).trim().slice(0, 500);
  if (args.color !== undefined && str(args.color).trim()) {
    if (!COLOR_RE.test(str(args.color).trim())) throw new ToolError('color must look like #FF5733');
    body.color = str(args.color).trim();
  }
  const r = await request('POST', '/api/groups', body);
  const g = r.group || {};
  return `created group ${g.id}: ${g.name || name}`;
}

async function toolLinkPeople(args) {
  const personId = checkId(args.person, 'person');
  const relatedPersonId = checkId(args.related, 'related');
  if (personId === relatedPersonId) throw new ToolError('person and related must differ');
  const body = { personId, relatedPersonId };
  let label = '';
  if (args.type) {
    const t = await resolveRelType(args.type);
    body.relationshipTypeId = t.id;
    label = t.label;
  }
  if (str(args.notes).trim()) body.notes = str(args.notes).trim().slice(0, 1000);
  const r = await request('POST', '/api/relationships', body);
  return `linked ${personId} -> ${relatedPersonId}${label ? ` as ${label}` : ''} (relationship ${(r.relationship || {}).id || '?'}; Nametag also created the inverse)`;
}

async function toolAddJournal(args) {
  const title = str(args.title).trim();
  const text = str(args.body).trim();
  if (!title) throw new ToolError('title is required');
  if (title.length > 200) throw new ToolError('title is longer than 200 chars');
  if (!text) throw new ToolError('body is required');
  if (text.length > JOURNAL_BODY_LIMIT) throw new ToolError(`body is longer than ${JOURNAL_BODY_LIMIT} chars`);
  let date;
  let hasTime = true;
  const given = str(args.date).trim();
  if (!given) {
    date = new Date().toISOString();
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(given)) {
    date = `${given}T00:00:00.000Z`;
    hasTime = false;
  } else {
    const t = Date.parse(given);
    if (Number.isNaN(t)) throw new ToolError('date must be YYYY-MM-DD or an ISO timestamp');
    date = new Date(t).toISOString();
  }
  const personIds = Array.isArray(args.people) ? args.people.map((x) => checkId(x, 'people[]')) : [];
  const body = { title, date, hasTime, body: text, personIds };
  if (args.update_last_contact === false) body.updateLastContact = false;
  const r = await request('POST', '/api/journal', body);
  const e = r.entry || {};
  return `journal entry ${e.id || '?'} saved (${day(date)}${personIds.length ? `, ${personIds.length} people tagged` : ''})`;
}

// ------------------------------------------------------------------ tools

const idArray = { type: 'array', items: { type: 'string' } };

const TOOLS = [
  {
    name: 'find_people',
    description:
      'Find or list people. q searches names and nicknames (accent-insensitive); deep=true also searches notes, groups and custom fields; group narrows a listing. Returns id | name | nickname lines.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'text to look for; omit to list' },
        deep: { type: 'boolean', description: 'also search notes, groups, custom fields (cannot combine with group)' },
        group: { type: 'string', description: 'group name or id' },
        limit: { type: 'integer', description: 'default 30, max 100' },
        offset: { type: 'integer', description: 'for listings' },
      },
    },
    run: toolFindPeople,
  },
  {
    name: 'get_person',
    description: 'One person in full: names, nickname, groups, custom fields, contact info, dates, relations, notes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: toolGetPerson,
  },
  {
    name: 'catalog',
    description: 'Existing groups, relationship types and custom field templates, with ids. Use it to see what tags and fields exist.',
    inputSchema: { type: 'object', properties: {} },
    run: toolCatalog,
  },
  {
    name: 'journal',
    description: 'Journal entries (newest first), optionally for one person or containing text. 50 per page.',
    inputSchema: {
      type: 'object',
      properties: { person: { type: 'string', description: 'person id' }, q: { type: 'string' }, page: { type: 'integer' } },
    },
    run: toolJournal,
  },
  {
    name: 'add_person',
    description: 'Create a person. Refuses a name that already exists unless allow_duplicate=true. Groups are existing group names or ids.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'first name' },
        surname: { type: 'string' },
        nickname: { type: 'string', description: 'several aliases: comma separated' },
        organization: { type: 'string' },
        job_title: { type: 'string' },
        notes: { type: 'string', description: 'Markdown, max 10000 chars' },
        groups: { ...idArray, description: 'group names or ids' },
        custom_fields: { type: 'object', description: '{field name: value}', additionalProperties: true },
        met_through: { type: 'string', description: 'id of the person you know them through' },
        relationship: { type: 'string', description: 'relationship type label' },
        allow_duplicate: { type: 'boolean' },
      },
      required: ['name'],
    },
    run: toolAddPerson,
  },
  {
    name: 'update_person',
    description:
      'Edit a person; only the fields you pass change. add_nickname adds an alias, append_notes adds text after the existing notes, notes replaces them. custom_fields only sets the fields you name. An empty string clears surname, nickname, organization or job_title.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        surname: { type: 'string' },
        nickname: { type: 'string', description: 'replaces all nicknames' },
        add_nickname: { type: 'string', description: 'adds one alias' },
        organization: { type: 'string' },
        job_title: { type: 'string' },
        notes: { type: 'string', description: 'REPLACES all notes' },
        append_notes: { type: 'string' },
        custom_fields: { type: 'object', description: '{field name: value}', additionalProperties: true },
      },
      required: ['id'],
    },
    run: toolUpdatePerson,
  },
  {
    name: 'tag_people',
    description: 'Add people to groups (tags like RPG, LARP). Only adds; existing memberships stay.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { ids: { ...idArray, description: 'person ids, max 100' }, groups: { ...idArray, description: 'group names or ids' } },
      required: ['ids', 'groups'],
    },
    run: toolTagPeople,
  },
  {
    name: 'create_group',
    description: 'Create a group (a tag). Refuses an existing name.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, color: { type: 'string', description: '#RRGGBB' } },
      required: ['name'],
    },
    run: toolCreateGroup,
  },
  {
    name: 'link_people',
    description: 'Connect two people, optionally with a relationship type label (see catalog). Nametag adds the inverse itself.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { person: { type: 'string' }, related: { type: 'string' }, type: { type: 'string' }, notes: { type: 'string' } },
      required: ['person', 'related'],
    },
    run: toolLinkPeople,
  },
  {
    name: 'add_journal',
    description: 'Add a journal entry, optionally tagging people (their last contact date is bumped unless update_last_contact=false).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown' },
        date: { type: 'string', description: 'YYYY-MM-DD or ISO timestamp; default now' },
        people: { ...idArray, description: 'person ids' },
        update_last_contact: { type: 'boolean' },
      },
      required: ['title', 'body'],
    },
    run: toolAddJournal,
  },
];

// -------------------------------------------------------------------- MCP

function describeError(err) {
  if (err instanceof ToolError) return err.message;
  const code = (err && (err.code || err.message)) || 'error';
  let host = 'Nametag';
  try {
    host = baseUrl().host;
  } catch (_) {
    host = 'Nametag';
  }
  return `cannot reach Nametag at ${host} (${code})`;
}

function visibleTools() {
  return TOOLS.filter((t) => !t.write || writeEnabled());
}

async function handleRequest(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'nametag', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: visibleTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const p = msg.params || {};
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) {
        const e = new Error(`unknown tool: ${p.name}`);
        e.rpcCode = -32602;
        throw e;
      }
      if (tool.write && !writeEnabled()) {
        return { content: [{ type: 'text', text: 'write tools are disabled on this connector (NAMETAG_ENABLE_WRITE is not true)' }], isError: true };
      }
      try {
        const text = await tool.run(p.arguments || {});
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: describeError(err) }], isError: true };
      }
    }
    default: {
      const e = new Error(`method not found: ${msg.method}`);
      e.rpcCode = -32601;
      throw e;
    }
  }
}

function main() {
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (!msg || msg.id === undefined || msg.id === null) return; // notification
    const job = handleRequest(msg)
      .then((result) => send({ jsonrpc: '2.0', id: msg.id, result }))
      .catch((err) => send({ jsonrpc: '2.0', id: msg.id, error: { code: err.rpcCode || -32603, message: err.message } }))
      .finally(() => pending.delete(job));
    pending.add(job);
  });
  rl.on('close', () => {
    Promise.all([...pending]).then(() => process.exit(0));
  });
}

module.exports = { norm, renderPerson, customFieldPayload, handleRequest, TOOLS, ToolError };

if (require.main === module) main();
