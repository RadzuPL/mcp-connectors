'use strict';
// nametag: a deliberately small MCP server for Nametag (https://github.com/mattogodoy/nametag),
// the self-hosted personal relationships manager.
//
// Design, in the spirit of docker-lite:
//   * short plain-text answers instead of raw API objects (less context sent to the model),
//   * read-only unless NAMETAG_ENABLE_WRITE=true. Write mode can add and edit people, groups,
//     links, relationship types, custom fields and journal entries, and can remove a journal
//     entry, a group, a link, or a person from a group. There is no import/export and no
//     account or token endpoint,
//   * deleting a PERSON and merging two people exist only with NAMETAG_ENABLE_DESTRUCTIVE=true
//     (on top of write mode). Even then the request layer refuses bulk delete and every
//     `/permanent` route, so nothing can be erased for good from here,
//   * the Nametag API token only ever goes to NAMETAG_URL and never appears in any output.
//
// Notes that shaped the write tools (checked against the Nametag source, 0.64):
//   * PUT /api/people/{id} only writes the fields it is sent, BUT arrays replace the whole set.
//     `customFieldValues`, phone numbers, emails and URLs are full replaces (an empty list wipes
//     everything). update_person therefore always reads the current values, merges, and sends
//     the complete list back. Group membership is added through the additive bulk action and
//     removed through DELETE /api/groups/{id}/members/{personId}, never through PUT `groupIds`,
//     which would replace the whole set.
//   * Important dates have their own routes (POST/DELETE per date), used instead of the array.
//   * POST /api/people with `connectedThroughId` IGNORES the relationship to you and uses the
//     given type between the two people instead. add_person therefore never sends it: the
//     person is created with the relation to you, and the "met through" link is made
//     afterwards with POST /api/relationships (which requires a relationship type).
//   * PUT /api/groups/{id} needs `name` and drops a description that is not sent; PUT
//     /api/journal/{id} needs title, date and body and drops the tagged people when `personIds`
//     is empty. The edit tools read the current record and send it back complete.
//   * `nickname` is a single field (max 100 chars). Several aliases are kept comma separated.
//   * Notes are Markdown, max 10000 chars.
//   * Deletes in Nametag are soft deletes (30 days). Journal entries are the exception: there is
//     no restore route for them, so delete_journal returns the full entry for re-creating it.
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

// Deleting a person and merging people. Needs write mode as well.
function destructiveEnabled() {
  return writeEnabled() && /^(true|1|yes)$/i.test(process.env.NAMETAG_ENABLE_DESTRUCTIVE || '');
}

// Routes that remove or fold together whole people. Only reachable with the destructive flag.
function isDestructiveRoute(method, route) {
  return (method === 'DELETE' && /^\/api\/people\/[^/]+$/.test(route)) || (method === 'POST' && route === '/api/people/merge');
}

// Routes that can never be called, whatever the flags say: permanent deletion and bulk delete.
function isNeverAllowed(method, route, body) {
  if (/\/permanent(\/|$)/.test(route)) return true;
  return method === 'POST' && route === '/api/people/bulk' && Boolean(body) && body.action === 'delete';
}

// --------------------------------------------------------------- Nametag API

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    // Last line of defence: in read-only mode nothing but GET ever leaves this process.
    if (method !== 'GET' && !writeEnabled()) {
      return reject(new ToolError('write tools are disabled (NAMETAG_ENABLE_WRITE is not true)'));
    }
    const route = path.split('?')[0];
    if (isNeverAllowed(method, route, body)) {
      return reject(new ToolError('this operation is not available through the connector'));
    }
    if (isDestructiveRoute(method, route) && !destructiveEnabled()) {
      return reject(new ToolError('deleting or merging people is disabled (NAMETAG_ENABLE_DESTRUCTIVE is not true)'));
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

// Nametag >= 0.65.0 answers errors as { error, code, params? } with distinct statuses (409 for
// duplicates, 413 for oversized uploads, ...). Older versions send { error } only, with 400 for
// duplicates. Both shapes are handled: `code` is shown when present, never required.
const FORBIDDEN_HINTS = {
  plan_limit_reached: 'the plan limit for this resource is reached',
  subscription_required: 'an active subscription is required',
  feature_disabled: 'this feature is turned off in Nametag',
  interactive_session_required: 'this action needs a browser session, not an API token',
};

function paramsText(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return '';
  const parts = Object.entries(params)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 4)
    .map(([k, v]) => `${oneLine(k, 30)}=${oneLine(String(v), 60)}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function apiFailure(method, path, status, text) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = null;
  }
  const msg = data && typeof data.error === 'string' ? data.error : '';
  const code = data && typeof data.code === 'string' ? oneLine(data.code, 60) : '';
  const tag = code ? ` [${code}]` : '';
  const extra = paramsText(data && data.params);
  const detail = msg ? oneLine(msg, 200) + tag + extra : '';
  const route = path.split('?')[0];
  if (status === 401) {
    return new ToolError(`Nametag rejected the API token (401${code ? `, ${code}` : ''}): check NAMETAG_API_TOKEN_FILE`);
  }
  if (status === 403) {
    const hint = FORBIDDEN_HINTS[code] || 'a READ-scoped token cannot write, or a plan limit was hit';
    return new ToolError(`forbidden (403)${msg ? `: ${oneLine(msg, 160)}${tag}${extra}` : tag}; ${hint}`);
  }
  if (status === 404) return new ToolError(`not found: ${msg ? oneLine(msg, 160) + tag : route}`);
  if (status === 409) return new ToolError(`conflict (409): ${detail || route}`);
  if (status === 413) return new ToolError(`payload too large (413): ${detail || route}`);
  if (status === 429) return new ToolError(`rate limited (429), try again later: ${detail || route}`);
  if (status === 400 && data) {
    const items = Array.isArray(data.details) && data.details.length
      ? data.details.map((d) => `${d.field}: ${d.message}`)
      : Array.isArray(data.fields) && data.fields.length
        ? data.fields.map((f) => `${f.path}: ${f.issue}`)
        : [];
    if (items.length) return new ToolError('validation failed: ' + items.slice(0, 6).join('; '));
  }
  if (status === 400 && msg) return new ToolError(`rejected: ${detail}`);
  return new ToolError(`Nametag API ${status}${detail ? `: ${detail}` : ''} (${method} ${route})`);
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

const enc = encodeURIComponent;

// A list of person ids for the bulk tools: at least one, at most 100.
function idList(v, what = 'ids') {
  const ids = Array.isArray(v) ? v.map((x) => checkId(x, `${what}[]`)) : [];
  if (!ids.length) throw new ToolError(`${what} must list at least one person id`);
  if (ids.length > 100) throw new ToolError('at most 100 people per call');
  return ids;
}

function displayName(p) {
  const n = [p && p.name, p && p.surname].filter(Boolean).join(' ');
  return n || '(no name)';
}

// A journal entry's `people` are join rows ({ personId, person: {...} }), not people.
function journalPersons(e) {
  return ((e && e.people) || []).map((x) => {
    const p = (x && x.person) || x || {};
    return { id: p.id || (x && x.personId) || '', person: p };
  });
}

function journalPeople(e) {
  return journalPersons(e)
    .map(({ id, person }) => `${displayName(person)}${id ? ` [${id}]` : ''}`)
    .join(', ');
}

function groupNames(p) {
  return ((p && p.groups) || [])
    .map((g) => (g && g.group && g.group.name) || (g && g.name))
    .filter(Boolean);
}

function day(iso) {
  return iso ? String(iso).slice(0, 10) : '';
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

// Every person of a listing, page after page (the server caps the page size on its own).
async function listAllPeople(groupIds) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const r = await get(`/api/people${qs({ limit: 500, offset, includeDetails: 'false', groupIds })}`);
    const rows = r.people || [];
    out.push(...rows);
    if (!rows.length || !(r.pagination && r.pagination.hasMore)) break;
    offset += rows.length;
  }
  return out;
}

function memberGroupIds(p) {
  return ((p && p.groups) || []).map((g) => (g && g.group && g.group.id) || (g && g.groupId) || (g && g.id)).filter(Boolean);
}

function relationLabel(p) {
  return (p && p.relationshipToUser && p.relationshipToUser.label) || '';
}

async function toolFindPeople(args) {
  const q = str(args.q).trim();
  const groupInputs = [str(args.group).trim(), ...(Array.isArray(args.groups) ? args.groups.map((x) => str(x).trim()) : [])].filter(Boolean);
  const relArg = str(args.relationship).trim();
  const everyGroup = args.all_groups === true;
  const limit = clampInt(args.limit, 30, 1, 100);
  const offset = clampInt(args.offset, 0, 0, 100000);

  if (args.deep === true) {
    if (!q) throw new ToolError('deep search needs q');
    if (groupInputs.length || relArg) throw new ToolError('deep cannot be combined with group or relationship; list those first, or drop them');
    return deepSearch(q, limit);
  }

  const groupLookup = groupInputs.length ? await resolveGroupIds(groupInputs) : null;
  const groupIds = groupLookup ? groupLookup.ids : [];
  const groupLabel = groupLookup ? groupIds.map((gid) => (groupLookup.groups.find((g) => g.id === gid) || {}).name || gid).join(everyGroup ? ' + ' : ' | ') : '';
  const relType = relArg ? await resolveRelType(relArg) : null;

  // Listing, narrowed by group (any of them, or all of them) and relation, and by name when q is given.
  // Only the groups are filtered by the server (any-of); the rest is filtered here. A name search
  // goes through the same path, so every result has the same columns.
  const local = Boolean(q || relType || (everyGroup && groupIds.length > 1));
  let rows;
  let total;
  let more;
  if (!local) {
    const r = await get(`/api/people${qs({ limit, offset, includeDetails: 'false', groupIds: groupIds.join(',') })}`);
    rows = r.people || [];
    total = r.pagination && Number.isFinite(r.pagination.total) ? r.pagination.total : rows.length;
    more = Boolean(r.pagination && r.pagination.hasMore);
  } else {
    rows = await listAllPeople(groupIds.join(','));
    if (q) {
      const nq = norm(q);
      rows = rows.filter((p) => norm([p.name, p.surname, p.middleName, p.secondLastName, p.nickname].filter(Boolean).join(' ')).includes(nq));
    }
    if (relType) rows = rows.filter((p) => (p.relationshipToUserId || (p.relationshipToUser && p.relationshipToUser.id)) === relType.id);
    if (everyGroup && groupIds.length > 1) rows = rows.filter((p) => groupIds.every((gid) => memberGroupIds(p).includes(gid)));
    total = rows.length;
    more = rows.length > offset + limit;
    rows = rows.slice(offset, offset + limit);
  }
  const filters = [
    groupLabel ? `in group${groupIds.length > 1 ? 's' : ''} "${groupLabel}"` : '',
    relType ? `with relation "${relType.label}"` : '',
    q ? `matching "${q}"` : '',
  ].filter(Boolean);
  const head = `${rows.length} of ${total} people${filters.length ? ` ${filters.join(', ')}` : ''}` + (more ? `; more: offset=${offset + rows.length}` : '');
  if (!rows.length) return q && !groupIds.length && !relType ? `${head}. Try deep=true to search notes, groups and custom fields.` : head;
  return cap(
    `${head}\nid | name | nickname | relation | groups\n` +
      rows.map((p) => [p.id, displayName(p), p.nickname ? `"${oneLine(p.nickname, 60)}"` : '', relationLabel(p), groupNames(p).join(', ')].join(' | ')).join('\n')
  );
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
        .map((e) => [e.id, day(e.date), oneLine(e.title, 80), journalPeople(e), oneLine(e.body, 160)].join(' | '))
        .join('\n')
  );
}

// ---------------------------------------------------------------- write tools

async function loadPerson(id) {
  const r = await get(`/api/people/${enc(id)}`);
  if (!r.person) throw new ToolError('unexpected answer from Nametag (no person in it)');
  return r.person;
}

async function toolAddPerson(args) {
  const name = str(args.name).trim();
  if (!name) throw new ToolError('name is required');
  const surname = str(args.surname).trim();

  // Nametag insists on a relationship to you, and with `connectedThroughId` it would ignore it and
  // use the type between the two people instead. So: relation to you is always set here, and the
  // "met through" link is a separate, typed one made afterwards.
  if (!str(args.relationship).trim()) {
    const types = await loadRelTypes();
    throw new ToolError(`relationship is required: your relationship to this person (types: ${types.map((x) => x.label).join(', ') || 'none'})`);
  }
  const metThrough = args.met_through ? checkId(args.met_through, 'met_through') : '';
  if (metThrough && !str(args.met_through_type).trim()) {
    throw new ToolError('met_through needs met_through_type: the relationship type between the two people (see catalog); relationship is only your own relation to the new person');
  }
  const relType = await resolveRelType(args.relationship);
  const linkType = metThrough ? await resolveRelType(args.met_through_type) : null;

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

  const body = { name, anniversary: null, lastContact: null, relationshipToUserId: relType.id };
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
  if (args.custom_fields && typeof args.custom_fields === 'object') {
    const values = await customFieldPayload(args.custom_fields, []);
    if (values.length) body.customFieldValues = values;
  }
  const r = await request('POST', '/api/people', body);
  const p = r.person || {};
  const extras = [`relation: ${relType.label}`];
  if (body.groupIds) extras.push(`groups: ${groupNames(p).join(', ') || `${body.groupIds.length} added`}`);
  if (body.customFieldValues) extras.push(`${body.customFieldValues.length} custom field(s)`);
  let note = '';
  if (metThrough) {
    try {
      await request('POST', '/api/relationships', { personId: p.id, relatedPersonId: metThrough, relationshipTypeId: linkType.id });
      extras.push(`linked to ${metThrough} as ${linkType.label}`);
    } catch (err) {
      note = `; WARNING: the person exists but the link to ${metThrough} failed (${describeError(err)}); use link_people`;
    }
  }
  return `created ${p.id}: ${displayName(p)} (${extras.join('; ')})${note}`;
}

const CONTACT_TYPE_DEFAULT = 'other';
const DATE_TYPES = ['birthday', 'anniversary', 'nameday', 'memorial'];

function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// New phone/email/URL lists for a PUT: the current ones, plus additions (no duplicates), minus removals.
// Nametag replaces each list as a whole, so a list is only returned when it really changed.
function contactLists(cur, args, changed) {
  const lists = {
    phoneNumbers: { arg: 'add_phones', field: 'number', label: 'phone', rows: (cur.phoneNumbers || []).map((x) => ({ type: x.type, number: x.number })), dirty: false },
    emails: { arg: 'add_emails', field: 'email', label: 'email', rows: (cur.emails || []).map((x) => ({ type: x.type, email: x.email })), dirty: false },
    urls: { arg: 'add_urls', field: 'url', label: 'url', rows: (cur.urls || []).map((x) => ({ type: x.type, url: x.url })), dirty: false },
  };
  for (const [key, l] of Object.entries(lists)) {
    const add = args[l.arg];
    if (add === undefined) continue;
    if (!Array.isArray(add) || !add.length) throw new ToolError(`${l.arg} must be a list of {type, ${l.field}}`);
    for (const item of add) {
      const value = str(item && item[l.field]).trim();
      if (!value) throw new ToolError(`${l.arg}: every item needs a ${l.field}`);
      const type = str(item.type).trim() || CONTACT_TYPE_DEFAULT;
      if (type.length > 50) throw new ToolError(`${l.arg}: type is longer than 50 chars`);
      if (value.length > (l.label === 'url' ? 500 : 50)) throw new ToolError(`${l.arg}: ${l.field} is too long`);
      if (l.rows.some((x) => norm(x[l.field]) === norm(value))) continue;
      l.rows.push({ type, [l.field]: value });
      l.dirty = true;
      changed.push(`${l.label} added: ${oneLine(value, 80)}`);
    }
  }
  if (args.remove_contact !== undefined) {
    if (!Array.isArray(args.remove_contact) || !args.remove_contact.length) throw new ToolError('remove_contact must list phone numbers, emails or URLs to remove');
    for (const raw of args.remove_contact) {
      const want = norm(str(raw).trim());
      if (!want) throw new ToolError('remove_contact: empty value');
      let hit = 0;
      for (const l of Object.values(lists)) {
        const keep = l.rows.filter((x) => norm(x[l.field]) !== want);
        if (keep.length !== l.rows.length) {
          hit += l.rows.length - keep.length;
          l.rows = keep;
          l.dirty = true;
        }
      }
      if (!hit) throw new ToolError(`no phone, email or URL equal to "${oneLine(raw, 80)}" (see get_person)`);
      changed.push(`contact removed: ${oneLine(raw, 80)}`);
    }
  }
  const out = {};
  for (const [key, l] of Object.entries(lists)) if (l.dirty) out[key] = l.rows;
  return out;
}

// Dates go through their own routes; this only checks them and works out what to send.
function dateOperations(cur, args, changed) {
  const ops = [];
  const existing = cur.importantDates || [];
  if (args.add_dates !== undefined) {
    if (!Array.isArray(args.add_dates) || !args.add_dates.length) throw new ToolError('add_dates must be a list of {type or title, date}');
    const types = new Set(existing.map((d) => d.type).filter(Boolean));
    for (const item of args.add_dates) {
      const type = item && item.type ? str(item.type).trim().toLowerCase() : '';
      const title = str(item && item.title).trim();
      const date = str(item && item.date).trim();
      if (type && !DATE_TYPES.includes(type)) throw new ToolError(`add_dates: type must be one of ${DATE_TYPES.join(', ')} (or give a title instead)`);
      if (!type && !title) throw new ToolError('add_dates: give a type or a title');
      if (title.length > 100) throw new ToolError('add_dates: title is longer than 100 chars');
      if (!isRealDate(date)) throw new ToolError(`add_dates: date must be YYYY-MM-DD, got "${oneLine(date, 40)}"`);
      if (type && types.has(type)) throw new ToolError(`add_dates: this person already has a ${type} date`);
      if (type) types.add(type);
      ops.push({ method: 'POST', body: { type: type || null, title, date }, label: `date added: ${type || title} ${date}` });
    }
  }
  if (args.remove_dates !== undefined) {
    if (!Array.isArray(args.remove_dates) || !args.remove_dates.length) throw new ToolError('remove_dates must list date ids, types or titles');
    for (const raw of args.remove_dates) {
      const want = norm(str(raw).trim());
      const hits = existing.filter((d) => norm(d.id) === want || norm(d.type) === want || norm(d.title) === want);
      if (!hits.length) throw new ToolError(`no date matches "${oneLine(raw, 60)}" (see get_person)`);
      if (hits.length > 1) throw new ToolError(`"${oneLine(raw, 60)}" matches ${hits.length} dates; use the id (${hits.map((d) => d.id).join(', ')})`);
      ops.push({ method: 'DELETE', dateId: hits[0].id, label: `date removed: ${hits[0].title || hits[0].type} ${day(hits[0].date)}` });
    }
  }
  for (const o of ops) changed.push(o.label);
  return ops;
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

  let lastContact;
  if (args.last_contact !== undefined) {
    const s = str(args.last_contact).trim();
    if (s !== '' && !isRealDate(s)) throw new ToolError('last_contact must be YYYY-MM-DD (empty clears it)');
    lastContact = s;
  }
  const relType = args.relationship !== undefined ? await resolveRelType(args.relationship) : null;
  const contactArgs = ['add_phones', 'add_emails', 'add_urls', 'remove_contact'].some((k) => args[k] !== undefined);
  const dateArgs = args.add_dates !== undefined || args.remove_dates !== undefined;

  const needCurrent =
    args.add_nickname !== undefined ||
    args.append_notes !== undefined ||
    lastContact !== undefined ||
    relType !== null ||
    contactArgs ||
    dateArgs ||
    (args.custom_fields && Object.keys(args.custom_fields).length);
  let cur = null;
  if (needCurrent) cur = await loadPerson(id);

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

  if (relType) {
    body.relationshipToUserId = relType.id;
    changed.push(`relation to you: ${relationLabel(cur) || '(none)'} -> ${relType.label}`);
  }
  if (lastContact !== undefined) {
    body.lastContact = lastContact === '' ? null : lastContact;
    changed.push(`last contact: ${day(cur.lastContact) || '(none)'} -> ${lastContact || '(cleared)'}`);
  }
  if (contactArgs) Object.assign(body, contactLists(cur, args, changed));
  const dateOps = dateArgs ? dateOperations(cur, args, changed) : [];

  if (!Object.keys(body).length && !dateOps.length) throw new ToolError('nothing to update: pass at least one field');
  let p = cur || { id };
  if (Object.keys(body).length) {
    const r = await request('PUT', `/api/people/${enc(id)}`, body);
    p = r.person || p;
  }
  for (const op of dateOps) {
    if (op.method === 'POST') await request('POST', `/api/people/${enc(id)}/important-dates`, op.body);
    else await request('DELETE', `/api/people/${enc(id)}/important-dates/${enc(op.dateId)}`);
  }
  return `updated ${id}: ${displayName(p.name ? p : cur || p)}; changed: ${changed.join(', ')}`;
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
  if (!str(args.type).trim()) throw new ToolError('type is required: Nametag refuses a link without a relationship type (see catalog)');
  const t = await resolveRelType(args.type);
  const body = { personId, relatedPersonId, relationshipTypeId: t.id };
  if (str(args.notes).trim()) body.notes = str(args.notes).trim().slice(0, 1000);
  const r = await request('POST', '/api/relationships', body);
  return `linked ${personId} -> ${relatedPersonId} as ${t.label} (relationship ${(r.relationship || {}).id || '?'}; Nametag also created the inverse)`;
}

// A date for a journal entry: nothing = now, YYYY-MM-DD = that day (no time), or an ISO timestamp.
function parseEntryDate(input) {
  const given = str(input).trim();
  if (!given) return { date: new Date().toISOString(), hasTime: true };
  if (/^\d{4}-\d{2}-\d{2}$/.test(given)) {
    if (!isRealDate(given)) throw new ToolError('date must be YYYY-MM-DD or an ISO timestamp');
    return { date: `${given}T00:00:00.000Z`, hasTime: false };
  }
  const t = Date.parse(given);
  if (Number.isNaN(t)) throw new ToolError('date must be YYYY-MM-DD or an ISO timestamp');
  return { date: new Date(t).toISOString(), hasTime: true };
}

function entryTitle(v) {
  const title = str(v).trim();
  if (!title) throw new ToolError('title is required');
  if (title.length > 200) throw new ToolError('title is longer than 200 chars');
  return title;
}

function entryBody(v) {
  const text = str(v).trim();
  if (!text) throw new ToolError('body is required');
  if (text.length > JOURNAL_BODY_LIMIT) throw new ToolError(`body is longer than ${JOURNAL_BODY_LIMIT} chars`);
  return text;
}

async function toolAddJournal(args) {
  const title = entryTitle(args.title);
  const text = entryBody(args.body);
  const { date, hasTime } = parseEntryDate(args.date);
  const personIds = Array.isArray(args.people) ? args.people.map((x) => checkId(x, 'people[]')) : [];
  const body = { title, date, hasTime, body: text, personIds };
  if (args.update_last_contact === false) body.updateLastContact = false;
  const r = await request('POST', '/api/journal', body);
  const e = r.entry || {};
  return `journal entry ${e.id || '?'} saved (${day(date)}${personIds.length ? `, ${personIds.length} people tagged` : ''})`;
}

async function loadEntry(id) {
  const r = await get(`/api/journal/${enc(id)}`);
  if (!r.entry) throw new ToolError('unexpected answer from Nametag (no entry in it)');
  return r.entry;
}

async function toolUpdateJournal(args) {
  const id = checkId(args.id);
  const cur = await loadEntry(id);
  const changed = [];
  const next = {
    title: cur.title,
    body: cur.body,
    date: cur.date,
    hasTime: typeof cur.hasTime === 'boolean' ? cur.hasTime : false,
    personIds: journalPersons(cur).map((x) => x.id).filter(Boolean),
  };
  if (args.title !== undefined) {
    next.title = entryTitle(args.title);
    changed.push('title');
  }
  if (args.body !== undefined) {
    next.body = entryBody(args.body);
    changed.push('body');
  }
  if (args.date !== undefined) {
    if (!str(args.date).trim()) throw new ToolError('date cannot be empty');
    Object.assign(next, parseEntryDate(args.date));
    changed.push('date');
  }
  if (args.people !== undefined) {
    if (!Array.isArray(args.people)) throw new ToolError('people must be a list of person ids (empty list removes all tags)');
    next.personIds = args.people.map((x) => checkId(x, 'people[]'));
    changed.push(`people (${next.personIds.length} tagged)`);
  }
  if (!changed.length) throw new ToolError('nothing to update: pass title, body, date or people');
  // The edit never touches anyone's last contact unless asked to: it only moves it forward.
  await request('PUT', `/api/journal/${enc(id)}`, { ...next, updateLastContact: args.update_last_contact === true });
  return `updated journal entry ${id}; changed: ${changed.join(', ')}`;
}

async function toolDeleteJournal(args) {
  const id = checkId(args.id);
  const cur = await loadEntry(id);
  await request('DELETE', `/api/journal/${enc(id)}`);
  const ids = journalPersons(cur).map((x) => x.id).filter(Boolean);
  return cap(
    `deleted journal entry ${id}. Nametag has no restore for journal entries and does not roll back last contact dates. ` +
      `To bring it back, call add_journal with:\ntitle: ${cur.title}\ndate: ${day(cur.date)}\npeople: ${ids.join(', ') || '(none)'}\nbody:\n${cap(str(cur.body), 3000)}`
  );
}

async function toolUntagPeople(args) {
  const ids = idList(args.ids);
  if (!Array.isArray(args.groups) || !args.groups.length) throw new ToolError('groups must list at least one group name or id');
  const { ids: groupIds, groups } = await resolveGroupIds(args.groups);
  let removed = 0;
  let notMember = 0;
  for (const gid of groupIds) {
    for (const pid of ids) {
      try {
        await request('DELETE', `/api/groups/${enc(gid)}/members/${enc(pid)}`);
        removed++;
      } catch (err) {
        if (err instanceof ToolError && /^not found/.test(err.message)) notMember++;
        else throw err;
      }
    }
  }
  const names = groupIds.map((gid) => (groups.find((g) => g.id === gid) || {}).name || gid).join(', ');
  return `removed ${removed} membership(s) from: ${names}` + (notMember ? `; ${notMember} pair(s) were not members (or the person was not found)` : '');
}

async function toolSetRelationship(args) {
  const ids = idList(args.ids);
  if (!str(args.relationship).trim()) throw new ToolError('relationship is required (a relationship type label, see catalog)');
  const t = await resolveRelType(args.relationship);
  const r = await request('POST', '/api/people/bulk', { action: 'setRelationship', personIds: ids, relationshipTypeId: t.id });
  const affected = Number.isFinite(r.affectedCount) ? r.affectedCount : ids.length;
  const missing = ids.length - affected;
  return `relation to you set to "${t.label}" for ${affected} people` + (missing > 0 ? `; ${missing} id(s) were not found` : '');
}

async function toolUpdateGroup(args) {
  const g = await resolveGroup(str(args.group).trim());
  const cur = (await get(`/api/groups/${enc(g.id)}`)).group || g;
  const changed = [];
  let name = cur.name;
  let description = cur.description || null;
  let color = COLOR_RE.test(str(cur.color)) ? cur.color : undefined;
  if (args.new_name !== undefined) {
    name = str(args.new_name).trim();
    if (!name) throw new ToolError('new_name cannot be empty');
    if (name.length > 100) throw new ToolError('new_name is longer than 100 chars');
    changed.push(`name: ${cur.name} -> ${name}`);
  }
  if (args.description !== undefined) {
    description = str(args.description).trim();
    if (description.length > 500) throw new ToolError('description is longer than 500 chars');
    description = description || null;
    changed.push(description ? 'description' : 'description (cleared)');
  }
  if (args.color !== undefined) {
    const c = str(args.color).trim();
    if (!COLOR_RE.test(c)) throw new ToolError('color must look like #FF5733');
    color = c;
    changed.push('color');
  }
  if (!changed.length) throw new ToolError('nothing to update: pass new_name, description or color');
  // Nametag needs the name every time and drops a description that is not sent, so all of it goes back.
  const body = { name, description };
  if (color) body.color = color;
  await request('PUT', `/api/groups/${enc(g.id)}`, body);
  return `updated group ${g.id}: ${name}; changed: ${changed.join(', ')}`;
}

async function toolDeleteGroup(args) {
  const g = await resolveGroup(str(args.group).trim());
  const cur = (await get(`/api/groups/${enc(g.id)}`)).group || {};
  const members = (cur.people || []).length;
  // Never with deletePeople: the people stay, only the tag goes.
  await request('DELETE', `/api/groups/${enc(g.id)}`);
  return `deleted group ${g.id} "${g.name}"; its ${members} member(s) keep their records and only lose this tag (Nametag keeps deleted groups for 30 days; see trash, bring back with restore)`;
}

// Finds the link(s) between two people from the first person's side.
async function findLinks(personId, relatedId) {
  const [p, types] = await Promise.all([loadPerson(personId), loadRelTypes()]);
  const labels = new Map(types.map((t) => [t.id, t.label]));
  const rows = (p.relationshipsFrom || []).filter((r) => r.relatedPersonId === relatedId);
  if (!rows.length) throw new ToolError(`no link from ${personId} to ${relatedId} (see get_person: related)`);
  return { rows, labels };
}

function pickLink(rows, labels, typeId) {
  const hits = typeId ? rows.filter((r) => r.relationshipTypeId === typeId) : rows;
  if (!hits.length) throw new ToolError(`no link of that type; existing: ${rows.map((r) => labels.get(r.relationshipTypeId) || 'untyped').join(', ')}`);
  if (hits.length > 1) {
    throw new ToolError(`${hits.length} links between these two people (${hits.map((r) => labels.get(r.relationshipTypeId) || 'untyped').join(', ')}); pass type to pick one`);
  }
  return hits[0];
}

async function toolUnlinkPeople(args) {
  const personId = checkId(args.person, 'person');
  const relatedId = checkId(args.related, 'related');
  const { rows, labels } = await findLinks(personId, relatedId);
  const t = str(args.type).trim() ? await resolveRelType(args.type) : null;
  const link = pickLink(rows, labels, t && t.id);
  await request('DELETE', `/api/relationships/${enc(link.id)}`);
  return `removed link ${personId} -> ${relatedId} (${labels.get(link.relationshipTypeId) || 'untyped'}); Nametag also removed the inverse`;
}

async function toolUpdateLink(args) {
  const personId = checkId(args.person, 'person');
  const relatedId = checkId(args.related, 'related');
  if (args.type === undefined && args.notes === undefined) throw new ToolError('nothing to update: pass type or notes');
  const { rows, labels } = await findLinks(personId, relatedId);
  const link = pickLink(rows, labels, null);
  let typeId = link.relationshipTypeId;
  let label = labels.get(typeId) || 'untyped';
  if (args.type !== undefined) {
    const t = await resolveRelType(args.type);
    typeId = t.id;
    label = t.label;
  }
  if (!typeId) throw new ToolError('this link has no type yet; pass type');
  const notes = args.notes !== undefined ? str(args.notes).trim().slice(0, 1000) : link.notes || '';
  await request('PUT', `/api/relationships/${enc(link.id)}`, { relationshipTypeId: typeId, notes: notes || null });
  return `updated link ${personId} -> ${relatedId}: ${label}${notes ? ` [${oneLine(notes, 80)}]` : ''}; Nametag updated the inverse too`;
}

async function toolCreateRelationshipType(args) {
  const label = str(args.label).trim();
  if (!label) throw new ToolError('label is required');
  if (label.length > 50) throw new ToolError('label is longer than 50 chars');
  const modes = [args.symmetric === true, Boolean(str(args.inverse_label).trim()), Boolean(str(args.inverse).trim())].filter(Boolean).length;
  if (modes !== 1) throw new ToolError('pass exactly one of: symmetric=true (it is its own inverse), inverse_label (a new inverse type to create), inverse (an existing type label)');
  const types = await loadRelTypes();
  if (types.some((x) => norm(x.label) === norm(label))) throw new ToolError(`relationship type "${label}" already exists`);
  const body = { name: str(args.name).trim() || label, label };
  if (str(args.color).trim()) {
    if (!COLOR_RE.test(str(args.color).trim())) throw new ToolError('color must look like #FF5733');
    body.color = str(args.color).trim();
  }
  if (args.symmetric === true) body.symmetric = true;
  else if (str(args.inverse_label).trim()) body.inverseLabel = str(args.inverse_label).trim();
  else body.inverseId = (await resolveRelType(args.inverse)).id;
  const r = await request('POST', '/api/relationship-types', body);
  const t = r.relationshipType || {};
  const inv = t.inverse && t.inverse.label ? `; inverse: ${t.inverse.label}` : '';
  return `created relationship type ${t.id || '?'}: ${t.label || label}${inv}`;
}

async function toolCreateCustomField(args) {
  const name = str(args.name).trim();
  if (!name) throw new ToolError('name is required');
  if (name.length > 60) throw new ToolError('name is longer than 60 chars');
  const type = str(args.type).trim().toUpperCase();
  if (!['TEXT', 'NUMBER', 'BOOLEAN', 'SELECT'].includes(type)) throw new ToolError('type must be TEXT, NUMBER, BOOLEAN or SELECT');
  const options = Array.isArray(args.options) ? args.options.map((o) => str(o).trim()).filter(Boolean) : [];
  if (type === 'SELECT' && !options.length) throw new ToolError('a SELECT field needs options');
  if (type !== 'SELECT' && options.length) throw new ToolError('options are only for SELECT fields');
  if (options.length > 50 || options.some((o) => o.length > 100)) throw new ToolError('at most 50 options, each up to 100 chars');
  const existing = await get('/api/custom-field-templates');
  if ((existing.templates || []).some((t) => norm(t.name) === norm(name))) throw new ToolError(`custom field "${name}" already exists`);
  const body = { name, type };
  if (type === 'SELECT') body.options = options;
  const r = await request('POST', '/api/custom-field-templates', body);
  const t = r.template || {};
  return `created custom field ${t.id || '?'}: ${t.name || name} (${type}${options.length ? `: ${options.join(', ')}` : ''})`;
}

// ------------------------------------------------------------------- trash

const TRASH_KINDS = {
  person: { api: 'people', label: 'people', route: (id) => `/api/people/${enc(id)}/restore`, name: displayName },
  group: { api: 'groups', label: 'groups', route: (id) => `/api/groups/${enc(id)}/restore`, name: (g) => str(g && g.name) || '(no name)' },
};

async function loadTrash(kind) {
  const r = await get(`/api/deleted${qs({ type: TRASH_KINDS[kind].api })}`);
  return { items: r.deleted || [], days: Number.isFinite(r.retentionDays) ? r.retentionDays : 30 };
}

function daysLeft(item, days) {
  const t = Date.parse(item && item.deletedAt);
  if (!Number.isFinite(t)) return '?';
  return String(Math.max(0, days - Math.floor((Date.now() - t) / 86400000)));
}

async function toolTrash(args) {
  const t = norm(str(args.type).trim());
  const kinds = !t ? ['person', 'group'] : t.startsWith('person') || t === 'people' ? ['person'] : t.startsWith('group') ? ['group'] : null;
  if (!kinds) throw new ToolError('type must be person or group (or omitted for both)');
  const parts = [];
  let days = 30;
  for (const kind of kinds) {
    const k = TRASH_KINDS[kind];
    const tr = await loadTrash(kind);
    days = tr.days;
    const rows = tr.items.map((x) => {
      const nick = kind === 'person' && x.nickname ? ` "${oneLine(x.nickname, 60)}"` : '';
      return `${x.id} | ${k.name(x)}${nick} | ${day(x.deletedAt)} | ${daysLeft(x, tr.days)}`;
    });
    parts.push(`${k.label} (${rows.length})` + (rows.length ? '\nid | name | deleted | days left\n' + rows.join('\n') : ''));
  }
  return cap(`trash (Nametag keeps deleted items ${days} days)\n` + parts.join('\n'));
}

async function toolRestore(args) {
  const type = norm(str(args.type).trim());
  const kind = type.startsWith('person') || type === 'people' ? 'person' : type.startsWith('group') ? 'group' : null;
  if (!kind) throw new ToolError('type must be person or group');
  const want = str(args.id).trim();
  if (!want) throw new ToolError('id is required: an id or the exact name, both from trash');
  const k = TRASH_KINDS[kind];
  const { items } = await loadTrash(kind);
  let hit = items.filter((x) => x.id === want);
  if (!hit.length) hit = items.filter((x) => norm(k.name(x)) === norm(want));
  if (!hit.length) throw new ToolError(`nothing in the trash (${k.label}) matches "${oneLine(want, 80)}"; see trash`);
  if (hit.length > 1) {
    throw new ToolError(`${hit.length} ${k.label} in the trash have that name (${hit.map((x) => `${x.id} deleted ${day(x.deletedAt)}`).join('; ')}); pass the id`);
  }
  const item = hit[0];
  await request('POST', k.route(item.id));
  const extra =
    kind === 'person'
      ? 'it is back as it was when deleted. If it was merged into another person, the data that moved stays on that person'
      : 'it is back with the members it had when deleted';
  return `restored ${kind} ${item.id}: ${k.name(item)}; ${extra}`;
}

// ------------------------------------------------------- destructive tools

async function toolDeletePerson(args) {
  const id = checkId(args.id);
  const p = await loadPerson(id);
  // Explicit body: people only connected through this one are left alone, CardDAV is not touched.
  await request('DELETE', `/api/people/${enc(id)}`, { deleteOrphans: false, orphanIds: [], deleteFromCardDav: false });
  return `deleted ${id}: ${displayName(p)}. Nametag keeps deleted people for 30 days (see trash, bring back with restore); nobody else was deleted, journal entries stay`;
}

function aliasList(s) {
  return str(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

async function toolMergePeople(args) {
  const primaryId = checkId(args.primary, 'primary');
  const secondaryId = checkId(args.secondary, 'secondary');
  if (primaryId === secondaryId) throw new ToolError('primary and secondary must differ');
  const [a, b] = await Promise.all([loadPerson(primaryId), loadPerson(secondaryId)]);
  const warnings = [];
  const overrides = {};

  // Nametag keeps the primary's value and only fills gaps, so aliases, notes and the
  // later contact date are combined here instead of being lost.
  const mine = aliasList(a.nickname);
  const union = [...mine];
  for (const x of aliasList(b.nickname)) if (!union.some((y) => norm(y) === norm(x))) union.push(x);
  if (union.length > mine.length) {
    const joined = union.join(', ');
    if (joined.length <= NICKNAME_LIMIT) overrides.nickname = joined;
    else warnings.push(`aliases of ${displayName(b)} not merged (over ${NICKNAME_LIMIT} chars): ${b.nickname}`);
  }
  if (str(b.notes).trim() && str(a.notes).trim() && norm(a.notes) !== norm(b.notes)) {
    const joined = `${a.notes}\n\n--- ${displayName(b)} ---\n${b.notes}`;
    if (joined.length <= NOTES_LIMIT) overrides.notes = joined;
    else warnings.push(`notes of ${displayName(b)} NOT merged (over ${NOTES_LIMIT} chars), they are lost unless saved:\n${cap(str(b.notes), 3000)}`);
  }
  if (b.lastContact && (!a.lastContact || day(b.lastContact) > day(a.lastContact))) overrides.lastContact = day(b.lastContact);

  const body = { primaryId, secondaryId };
  if (Object.keys(overrides).length) body.fieldOverrides = overrides;
  await request('POST', '/api/people/merge', body);
  return cap(
    `merged ${secondaryId} (${displayName(b)}) into ${primaryId} (${displayName(a)}): groups, links, journal entries and contact data moved over; ` +
      `the secondary is in Nametag's trash for 30 days` +
      (warnings.length ? `\nWARNING: ${warnings.join('\nWARNING: ')}` : '')
  );
}

// ------------------------------------------------------------------ tools

const idArray = { type: 'array', items: { type: 'string' } };
const s = (description) => (description ? { type: 'string', description } : { type: 'string' });
const personIds = { ...idArray, description: 'person ids, max 100' };
const contactItems = (field) => ({
  type: 'array',
  items: { type: 'object', properties: { type: s(), [field]: s() }, required: [field] },
});

const TOOLS = [
  {
    name: 'find_people',
    description:
      'Find or list people. q searches names and nicknames (accent-insensitive); deep=true also searches notes, groups and custom fields. group/groups narrow a listing (any of them, or all with all_groups); relationship keeps one relation to you. Returns id | name | nickname | relation | groups lines.',
    inputSchema: {
      type: 'object',
      properties: {
        q: s('text to look for; omit to list'),
        deep: { type: 'boolean', description: 'also search notes, groups, custom fields (cannot combine with group or relationship)' },
        group: s('group name or id'),
        groups: { ...idArray, description: 'several group names or ids' },
        all_groups: { type: 'boolean', description: 'with several groups: only people in all of them' },
        relationship: s('relationship type label, e.g. only "Colleague"'),
        limit: { type: 'integer', description: 'default 30, max 100' },
        offset: { type: 'integer', description: 'for listings' },
      },
    },
    run: toolFindPeople,
  },
  {
    name: 'get_person',
    description: 'One person in full: names, nickname, groups, custom fields, contact info, dates, relations, notes.',
    inputSchema: { type: 'object', properties: { id: s() }, required: ['id'] },
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
    description: 'Journal entries (newest first), optionally for one person or containing text. 50 per page. People come as name [id].',
    inputSchema: {
      type: 'object',
      properties: { person: s('person id'), q: s(), page: { type: 'integer' } },
    },
    run: toolJournal,
  },
  {
    name: 'trash',
    description: 'Deleted people and groups still in Nametag\'s trash (kept 30 days), with ids and days left. Use restore to bring one back.',
    inputSchema: { type: 'object', properties: { type: s('person or group; default both') } },
    run: toolTrash,
  },
  {
    name: 'add_person',
    description:
      'Create a person. relationship is YOUR relation to them (required). met_through (a person id) also needs met_through_type, the relationship type between the two people. Refuses an existing name unless allow_duplicate=true.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: s('first name'),
        surname: s(),
        nickname: s('several aliases: comma separated'),
        organization: s(),
        job_title: s(),
        notes: s('Markdown, max 10000 chars'),
        groups: { ...idArray, description: 'group names or ids' },
        custom_fields: { type: 'object', description: '{field name: value}', additionalProperties: true },
        relationship: s('relationship type label (your relation to the person)'),
        met_through: s('id of the person you know them through'),
        met_through_type: s('relationship type label between the two people'),
        allow_duplicate: { type: 'boolean' },
      },
      required: ['name', 'relationship'],
    },
    run: toolAddPerson,
  },
  {
    name: 'update_person',
    description:
      'Edit a person; only the fields you pass change. add_nickname adds an alias, append_notes adds text after the notes, notes replaces them, custom_fields sets only the fields you name. relationship changes your relation to them, last_contact sets the date by hand (empty clears). add_phones/add_emails/add_urls add contact data, remove_contact removes a phone, email or URL by value, add_dates/remove_dates handle important dates. An empty string clears surname, nickname, organization or job_title.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: s(),
        name: s(),
        surname: s(),
        nickname: s('replaces all nicknames'),
        add_nickname: s('adds one alias'),
        organization: s(),
        job_title: s(),
        notes: s('REPLACES all notes'),
        append_notes: s(),
        custom_fields: { type: 'object', description: '{field name: value}', additionalProperties: true },
        relationship: s('relationship type label'),
        last_contact: s('YYYY-MM-DD; empty clears'),
        add_phones: contactItems('number'),
        add_emails: contactItems('email'),
        add_urls: contactItems('url'),
        remove_contact: { ...idArray, description: 'phone numbers, emails or URLs to remove' },
        add_dates: {
          type: 'array',
          items: { type: 'object', properties: { type: s('birthday, anniversary, nameday or memorial'), title: s('for other dates'), date: s('YYYY-MM-DD') }, required: ['date'] },
        },
        remove_dates: { ...idArray, description: 'date ids, types or titles' },
      },
      required: ['id'],
    },
    run: toolUpdatePerson,
  },
  {
    name: 'tag_people',
    description: 'Add people to groups (tags like Family, Work). Only adds; existing memberships stay.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { ids: personIds, groups: { ...idArray, description: 'group names or ids' } },
      required: ['ids', 'groups'],
    },
    run: toolTagPeople,
  },
  {
    name: 'untag_people',
    description: 'Remove people from groups. Only the memberships go; people and groups stay.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { ids: personIds, groups: { ...idArray, description: 'group names or ids' } },
      required: ['ids', 'groups'],
    },
    run: toolUntagPeople,
  },
  {
    name: 'set_relationship',
    description: 'Set YOUR relationship type (e.g. Colleague, Friend) for up to 100 people at once.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { ids: personIds, relationship: s('relationship type label') },
      required: ['ids', 'relationship'],
    },
    run: toolSetRelationship,
  },
  {
    name: 'create_group',
    description: 'Create a group (a tag). Refuses an existing name.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { name: s(), description: s(), color: s('#RRGGBB') },
      required: ['name'],
    },
    run: toolCreateGroup,
  },
  {
    name: 'update_group',
    description: 'Rename a group or change its description (empty clears) or color.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { group: s('group name or id'), new_name: s(), description: s(), color: s('#RRGGBB') },
      required: ['group'],
    },
    run: toolUpdateGroup,
  },
  {
    name: 'delete_group',
    description: 'Delete a group (the tag only; its members stay). Nametag keeps it for 30 days.',
    write: true,
    inputSchema: { type: 'object', properties: { group: s('group name or id') }, required: ['group'] },
    run: toolDeleteGroup,
  },
  {
    name: 'restore',
    description: 'Bring a deleted person or group back from the trash (see trash). Journal entries cannot be restored.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { type: s('person or group'), id: s('id or exact name, from trash') },
      required: ['type', 'id'],
    },
    run: toolRestore,
  },
  {
    name: 'link_people',
    description: 'Connect two people with a relationship type label (required, see catalog). Nametag adds the inverse itself.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { person: s(), related: s(), type: s('relationship type label'), notes: s() },
      required: ['person', 'related', 'type'],
    },
    run: toolLinkPeople,
  },
  {
    name: 'update_link',
    description: 'Change the type or notes of the link between two people (the inverse follows).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { person: s(), related: s(), type: s('new relationship type label'), notes: s('empty clears') },
      required: ['person', 'related'],
    },
    run: toolUpdateLink,
  },
  {
    name: 'unlink_people',
    description: 'Remove the link between two people (and its inverse). type picks one when there are several.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { person: s(), related: s(), type: s('relationship type label') },
      required: ['person', 'related'],
    },
    run: toolUnlinkPeople,
  },
  {
    name: 'create_relationship_type',
    description: 'Create a relationship type. Pass exactly one of symmetric (its own inverse), inverse_label (creates the inverse too) or inverse (an existing type label).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        label: s(),
        name: s('internal name; default: the label'),
        symmetric: { type: 'boolean' },
        inverse_label: s(),
        inverse: s(),
        color: s('#RRGGBB'),
      },
      required: ['label'],
    },
    run: toolCreateRelationshipType,
  },
  {
    name: 'create_custom_field',
    description: 'Create a custom field template (TEXT, NUMBER, BOOLEAN or SELECT with options); then set it with update_person custom_fields.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { name: s(), type: s('TEXT, NUMBER, BOOLEAN or SELECT'), options: { ...idArray, description: 'for SELECT' } },
      required: ['name', 'type'],
    },
    run: toolCreateCustomField,
  },
  {
    name: 'add_journal',
    description: 'Add a journal entry, optionally tagging people (their last contact date is bumped unless update_last_contact=false).',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        title: s(),
        body: s('Markdown'),
        date: s('YYYY-MM-DD or ISO timestamp; default now'),
        people: { ...idArray, description: 'person ids' },
        update_last_contact: { type: 'boolean' },
      },
      required: ['title', 'body'],
    },
    run: toolAddJournal,
  },
  {
    name: 'update_journal',
    description: 'Edit a journal entry: only the fields you pass change. people REPLACES the tagged people (empty list untags all). Last contact dates are not touched unless update_last_contact=true.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: s('entry id, from journal'),
        title: s(),
        body: s('Markdown'),
        date: s('YYYY-MM-DD or ISO timestamp'),
        people: { ...idArray, description: 'person ids; replaces the current tags' },
        update_last_contact: { type: 'boolean' },
      },
      required: ['id'],
    },
    run: toolUpdateJournal,
  },
  {
    name: 'delete_journal',
    description: 'Delete a journal entry. Nametag cannot restore it and keeps last contact dates; the reply holds the whole entry for add_journal.',
    write: true,
    inputSchema: { type: 'object', properties: { id: s('entry id, from journal') }, required: ['id'] },
    run: toolDeleteJournal,
  },
  {
    name: 'delete_person',
    description: 'Delete a person (soft delete, 30 days in Nametag trash). Nobody else is deleted; journal entries stay.',
    write: true,
    destructive: true,
    inputSchema: { type: 'object', properties: { id: s() }, required: ['id'] },
    run: toolDeletePerson,
  },
  {
    name: 'merge_people',
    description: 'Merge secondary into primary: groups, links, journal and contact data move over, aliases and notes are combined, the secondary goes to the trash.',
    write: true,
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: { primary: s('id of the person to keep'), secondary: s('id of the duplicate') },
      required: ['primary', 'secondary'],
    },
    run: toolMergePeople,
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
  return TOOLS.filter((t) => (!t.write || writeEnabled()) && (!t.destructive || destructiveEnabled()));
}

async function handleRequest(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'nametag', version: '1.2.0' },
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
      if (tool.destructive && !destructiveEnabled()) {
        return { content: [{ type: 'text', text: 'deleting or merging people is disabled on this connector (NAMETAG_ENABLE_DESTRUCTIVE is not true)' }], isError: true };
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

module.exports = { norm, renderPerson, customFieldPayload, handleRequest, TOOLS, ToolError, isNeverAllowed, isDestructiveRoute };

if (require.main === module) main();
