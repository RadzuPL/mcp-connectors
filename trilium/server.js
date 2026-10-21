'use strict';
// trilium: a deliberately small MCP server for TriliumNext (https://github.com/TriliumNext/Trilium),
// built on its ETAPI REST API and written for planning and writing together with an AI: notes in a
// tree, links between notes, labels and relations.
//
// Design, in the spirit of docker-lite and nametag:
//   * short plain-text answers instead of raw API objects (less context sent to the model),
//   * read-only unless TRILIUM_ENABLE_WRITE=true. Write mode can create, edit, move and clone notes,
//     set and remove labels and relations, open day notes, undelete and create a database backup,
//   * deleting a note exists only with TRILIUM_ENABLE_DESTRUCTIVE=true (on top of write mode). It is
//     still a soft delete: undelete_note brings the note back until Trilium erases it for good,
//   * no import, no export and no auth routes are reachable, whatever the flags say,
//   * the ETAPI token only ever goes to TRILIUM_URL and never appears in any output.
//
// What this server cannot do for you: an ETAPI token has no scopes, so unlike the Nametag connector
// there is no read-only credential to lean on underneath. The read-only switch lives in this
// process. The safety nets that do exist: every content change first saves a note revision (and is
// refused if that fails), deletes are soft, and create_backup writes a database backup.
//
// Content of a text note is HTML. So that links between notes are easy to write, the connector
// understands one small syntax inside text notes and converts it both ways:
//   [[noteId]]        a reference link (shows the current title of the note, with its icon)
//   [[noteId|label]]  a plain internal link with your own text
// Unknown ids are refused, so a link never dangles. get_note shows links the same way and lists
// the titles of what they point to. Markdown notes (format=markdown) are stored as typed, because
// Trilium's own [[noteId]] syntax is native there.
//
// No dependencies: Node core modules only; MCP over stdio (line-delimited JSON-RPC), wrapped by
// supergateway like every other gateway image in this repo.

const http = require('http');
const https = require('https');
const fs = require('fs');
const readline = require('readline');

const MAX_API_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20000; // absolute ceiling for any single tool result
const MAX_CONTENT_CHARS = 2000000; // what one write may put into a note
const ID_RE = /^[A-Za-z0-9_]{4,32}$/;
const NAME_RE = /^[^\s]{1,100}$/;
const TEXT_TYPES = new Set(['text', 'code', 'render', 'search', 'mermaid', 'webView']);
const CREATE_TYPES = ['text', 'code', 'book', 'search', 'render'];
const HIDDEN_LABELS = new Set(['iconClass']);
// The one place that decides what an internal link looks like inside a text note.
const REF_PREFIX = '#root/';

class ToolError extends Error {}

// ------------------------------------------------------------------ config

function baseUrl() {
  const raw = process.env.TRILIUM_URL;
  if (!raw) throw new ToolError('TRILIUM_URL is not set (for example http://triliumnext:8080)');
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw new ToolError('TRILIUM_URL is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ToolError('TRILIUM_URL must start with http:// or https://');
  return u;
}

function apiPrefix(u) {
  const p = u.pathname.replace(/\/+$/, '');
  return /\/etapi$/.test(p) ? p : p + '/etapi';
}

function apiToken() {
  const file = process.env.TRILIUM_TOKEN_FILE;
  let t = '';
  if (file) {
    try {
      t = fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new ToolError(`cannot read TRILIUM_TOKEN_FILE (${(err && err.code) || 'error'})`);
    }
  } else {
    t = (process.env.TRILIUM_TOKEN || '').trim();
  }
  if (!t) throw new ToolError('no ETAPI token: set TRILIUM_TOKEN_FILE (or TRILIUM_TOKEN)');
  return t;
}

const flag = (name) => /^(true|1|yes)$/i.test(process.env[name] || '');
const writeEnabled = () => flag('TRILIUM_ENABLE_WRITE');
// Deleting notes. Needs write mode as well.
const destructiveEnabled = () => writeEnabled() && flag('TRILIUM_ENABLE_DESTRUCTIVE');

// Routes that can never be called, whatever the flags say: auth, import and export.
function isNeverAllowed(method, route) {
  return /^\/auth(\/|$)/.test(route) || /\/import$/.test(route) || /\/export$/.test(route);
}

// Deleting a note (and with it its subtree). Only reachable with the destructive flag.
function isDestructiveRoute(method, route) {
  return method === 'DELETE' && /^\/notes\/[^/]+$/.test(route);
}

// --------------------------------------------------------------- Trilium API

function request(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const route = path.split('?')[0];
    // Last line of defence: in read-only mode nothing but GET ever leaves this process.
    if (method !== 'GET' && !writeEnabled()) {
      return reject(new ToolError('write tools are disabled (TRILIUM_ENABLE_WRITE is not true)'));
    }
    if (isNeverAllowed(method, route)) return reject(new ToolError('this operation is not available through the connector'));
    if (isDestructiveRoute(method, route) && !destructiveEnabled()) {
      return reject(new ToolError('deleting notes is disabled (TRILIUM_ENABLE_DESTRUCTIVE is not true)'));
    }
    let base;
    let token;
    try {
      base = baseUrl();
      token = apiToken();
    } catch (err) {
      return reject(err);
    }
    const headers = { Authorization: token, Accept: 'application/json, text/*;q=0.9, */*;q=0.5' };
    let payload = null;
    if (opts.json !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.json), 'utf8');
      headers['Content-Type'] = 'application/json';
    } else if (opts.text !== undefined) {
      payload = Buffer.from(String(opts.text), 'utf8');
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    }
    if (payload) headers['Content-Length'] = payload.length;
    const lib = base.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        path: apiPrefix(base) + path,
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
            req.destroy(new ToolError('Trilium response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          const type = String(res.headers['content-type'] || '');
          if (status >= 200 && status < 300) {
            let json = null;
            if (/json/i.test(type) && text.trim()) {
              try {
                json = JSON.parse(text);
              } catch (_) {
                return reject(new ToolError(`Trilium answered ${status} with broken JSON (is TRILIUM_URL the app, not a proxy page?)`));
              }
            }
            return resolve({ status, type, text, json });
          }
          reject(apiFailure(method, route, status, text));
        });
      }
    );
    req.on('timeout', () => req.destroy(new ToolError('Trilium API timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ETAPI errors come as { status, code, message }. The code is a stable constant.
function apiFailure(method, route, status, text) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = null;
  }
  const msg = data && typeof data.message === 'string' ? data.message : '';
  const code = data && typeof data.code === 'string' ? oneLine(data.code, 60) : '';
  const tag = code ? ` [${code}]` : '';
  if (code === 'NOTE_IS_PROTECTED') return new ToolError('this note is protected; ETAPI cannot read or change protected notes');
  if (status === 401) return new ToolError(`Trilium rejected the ETAPI token (401${code ? `, ${code}` : ''}): check TRILIUM_TOKEN_FILE (token from Options > ETAPI)`);
  if (status === 403) return new ToolError(`forbidden (403)${msg ? `: ${oneLine(msg, 160)}${tag}` : tag}`);
  if (status === 404) return new ToolError(`not found: ${msg ? oneLine(msg, 160) + tag : route}`);
  if (status === 429) return new ToolError('rate limited (429), try again later');
  if (status === 400 && msg) return new ToolError(`rejected: ${oneLine(msg, 200)}${tag}`);
  return new ToolError(`Trilium API ${status}${tag}${msg ? `: ${oneLine(msg, 200)}` : ''} (${method} ${route})`);
}

// --------------------------------------------------------------- formatting

const str = (v) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const enc = encodeURIComponent;

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
    throw new ToolError(`${what} must be a Trilium note id (take it from search_notes or get_tree)`);
  }
  return id;
}

function day(iso) {
  return iso ? String(iso).slice(0, 10) : '';
}

// Runs fn over items with a small cap on parallel requests. A failure becomes null, not an exception.
async function pmap(items, fn, limit = 6) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (_) {
        out[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeHtml(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ------------------------------------------------------------- note links
//
// [[noteId]] and [[noteId|label]] <-> HTML anchors inside text notes.

const WIKI_RE = /\[\[([A-Za-z0-9_]{4,32})(?:\|([^\]\n]*))?\]\]/g;
const ANCHOR_RE = /<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
// Matches what Trilium writes for an internal link: "#root/<noteId>" or the full path "#root/a/b/<noteId>".
const INTERNAL_HREF_RE = /^[^#]*#(?:root\/)?(?:[A-Za-z0-9_]+\/)*([A-Za-z0-9_]{4,32})\/?$/;

function wikiIds(text) {
  const ids = [];
  for (const m of String(text).matchAll(WIKI_RE)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

async function noteTitles(ids) {
  const out = new Map();
  const rows = await pmap(ids, (id) => getNote(id));
  ids.forEach((id, i) => out.set(id, rows[i] ? rows[i].title : null));
  return out;
}

// Wiki-style text -> the HTML Trilium stores. Every linked note must exist.
async function toHtml(text) {
  const ids = wikiIds(text);
  if (!ids.length) return text;
  if (ids.length > 50) throw new ToolError('at most 50 different linked notes in one text');
  const titles = await noteTitles(ids);
  const missing = ids.filter((id) => titles.get(id) === null);
  if (missing.length) throw new ToolError(`linked note(s) not found: ${missing.join(', ')}; nothing was written`);
  return text.replace(WIKI_RE, (_, id, label) => {
    if (label === undefined) return `<a class="reference-link" href="${REF_PREFIX}${id}">${escHtml(titles.get(id))}</a>`;
    return `<a href="${REF_PREFIX}${id}">${escHtml(label)}</a>`;
  });
}

// Stored HTML -> wiki-style text. Only internal links are touched, everything else stays as it is.
function fromHtml(html) {
  return String(html).replace(ANCHOR_RE, (m, href, inner) => {
    const mm = INTERNAL_HREF_RE.exec(decodeHtml(href));
    if (!mm) return m;
    const openTag = m.slice(0, m.indexOf('>') + 1);
    if (/\bclass="[^"]*\breference-link\b/i.test(openTag)) return `[[${mm[1]}]]`;
    const label = decodeHtml(inner.replace(/<[^>]*>/g, '')).replace(/[\]\n|]/g, ' ').trim();
    return label ? `[[${mm[1]}|${label}]]` : `[[${mm[1]}]]`;
  });
}

function isMarkdownMime(mime) {
  return /markdown|gfm/i.test(str(mime));
}

// A text note holds HTML; a markdown note (type code, markdown mime) holds what was typed.
const holdsHtml = (note) => note.type === 'text' && !isMarkdownMime(note.mime);

// ----------------------------------------------------------------- helpers

async function getNote(id) {
  const r = await request('GET', `/notes/${enc(id)}`);
  const n = r.json;
  if (!n || !n.noteId) throw new ToolError('unexpected answer from Trilium (no note in it)');
  return n;
}

async function readContent(note) {
  const r = await request('GET', `/notes/${enc(note.noteId)}/content`);
  return r.text;
}

function attrText(attrs, max = 8) {
  const out = [];
  for (const a of attrs || []) {
    if (a.type === 'label') {
      if (HIDDEN_LABELS.has(a.name)) continue;
      out.push(a.value ? `#${a.name}=${oneLine(a.value, 40)}` : `#${a.name}`);
    } else if (a.type === 'relation') {
      out.push(`~${a.name}->${a.value}`);
    }
  }
  const shown = out.slice(0, max);
  if (out.length > max) shown.push(`+${out.length - max} more`);
  return shown.join(' ');
}

function noteType(n) {
  return n.type === 'code' && isMarkdownMime(n.mime) ? 'markdown' : n.type;
}

async function addAttribute(noteId, type, name, value, inheritable = false) {
  if (!NAME_RE.test(name)) throw new ToolError(`attribute name "${oneLine(name, 40)}" is not valid (no spaces, up to 100 chars)`);
  const body = { noteId, type, name, value: str(value), isInheritable: inheritable === true };
  const r = await request('POST', '/attributes', { json: body });
  return r.json || {};
}

// ----------------------------------------------------------------- read tools

async function toolStatus() {
  const r = await request('GET', '/app-info');
  const a = r.json || {};
  return [
    `Trilium ${a.appVersion || '?'} (db ${a.dbVersion || '?'}), reachable`,
    `write tools: ${writeEnabled() ? 'on' : 'off'}; delete: ${destructiveEnabled() ? 'on' : 'off'}`,
  ].join('\n');
}

async function toolSearchNotes(args) {
  const q = str(args.q).trim();
  if (!q) throw new ToolError('q is required (Trilium search syntax, for example: towers #book)');
  const limit = clampInt(args.limit, 20, 1, 100);
  const depth = str(args.depth).trim();
  if (depth && !/^(eq|lt|gt)\d{1,2}$/.test(depth)) throw new ToolError('depth must look like eq1, lt3 or gt2');
  const dir = str(args.order_dir).trim().toLowerCase();
  if (dir && dir !== 'asc' && dir !== 'desc') throw new ToolError('order_dir must be asc or desc');
  const orderBy = str(args.order_by).trim();
  if (orderBy && !/^[#A-Za-z0-9_.]{1,60}$/.test(orderBy)) throw new ToolError('order_by is not a valid property or label name');
  const r = await request(
    'GET',
    '/notes' +
      qs({
        search: q,
        limit,
        fastSearch: args.fast === true,
        includeArchivedNotes: args.archived === true,
        ancestorNoteId: args.ancestor ? checkId(str(args.ancestor), 'ancestor') : '',
        ancestorDepth: depth,
        orderBy,
        orderDirection: dir,
      })
  );
  const rows = (r.json && r.json.results) || [];
  const head = `${rows.length} result(s) for "${oneLine(q, 80)}"` + (rows.length >= limit ? ` (limit ${limit} reached: narrow the query or raise limit)` : '');
  if (!rows.length) return `${head}. Syntax: words, "exact phrase", #label, #label=value, ~relation, note.title *=* part`;
  return cap(`${head}\nid | title | type | labels and relations\n` + rows.map((n) => [n.noteId, oneLine(n.title, 100), noteType(n), attrText(n.attributes)].join(' | ')).join('\n'));
}

async function toolGetNote(args) {
  const id = checkId(args.id);
  const wantContent = args.content !== false;
  const maxChars = clampInt(args.max_chars, 8000, 500, 40000);
  const n = await getNote(id);
  const out = [];
  out.push(`id: ${n.noteId}`);
  out.push(`title: ${n.title}`);
  out.push(`type: ${noteType(n)}${n.mime ? ` (${n.mime})` : ''}${n.isProtected ? ', protected' : ''}`);
  const parents = n.parentNoteIds || [];
  if (parents.length) out.push(`parents: ${parents.slice(0, 6).join(', ')}${parents.length > 6 ? ', …' : ''}`);
  out.push(`created: ${day(n.dateCreated)}; modified: ${day(n.dateModified)}`);

  const attrs = n.attributes || [];
  if (attrs.length) {
    const targets = [...new Set(attrs.filter((a) => a.type === 'relation' && ID_RE.test(str(a.value))).map((a) => a.value))].slice(0, 12);
    const names = await noteTitles(targets);
    const parts = attrs
      .filter((a) => !(a.type === 'label' && HIDDEN_LABELS.has(a.name)))
      .slice(0, 40)
      .map((a) => {
        if (a.type === 'label') return a.value ? `#${a.name}=${oneLine(a.value, 80)}` : `#${a.name}`;
        const t = names.get(a.value);
        return `~${a.name}->${a.value}${t ? ` (${oneLine(t, 60)})` : ''}`;
      });
    if (parts.length) out.push(`attributes: ${parts.join('; ')}`);
  }

  const children = n.childNoteIds || [];
  if (children.length) {
    const shown = children.slice(0, 40);
    const rows = await pmap(shown, (cid) => getNote(cid));
    out.push(`children (${children.length}): id | title | type | its children`);
    shown.forEach((cid, i) => {
      const c = rows[i];
      out.push(c ? [c.noteId, oneLine(c.title, 100), noteType(c), (c.childNoteIds || []).length || ''].join(' | ') : `${cid} | (unreadable)`);
    });
    if (children.length > shown.length) out.push(`… ${children.length - shown.length} more (use get_tree or search_notes with ancestor)`);
  }

  if (wantContent) {
    if (!TEXT_TYPES.has(n.type)) {
      out.push(`content: (${n.type} note, not text; nothing to show)`);
    } else if (n.isProtected) {
      out.push('content: (protected note; ETAPI cannot read it)');
    } else {
      let text = await readContent(n);
      if (holdsHtml(n)) text = fromHtml(text);
      const cut = text.length > maxChars;
      out.push(`content (${text.length} chars${cut ? `, first ${maxChars} shown; raise max_chars` : ''}):`);
      out.push(cut ? text.slice(0, maxChars) : text || '(empty)');
      const ids = wikiIds(text.slice(0, maxChars)).filter((x) => x !== id).slice(0, 30);
      if (ids.length) {
        const titles = await noteTitles(ids);
        out.push('links: ' + ids.map((x) => `${x} = ${titles.get(x) ? oneLine(titles.get(x), 60) : '(not found)'}`).join('; '));
      }
    }
  }
  return cap(out.join('\n'));
}

async function toolGetTree(args) {
  const rootId = args.id ? checkId(str(args.id)) : 'root';
  const depth = clampInt(args.depth, 2, 1, 4);
  const maxItems = clampInt(args.max_items, 80, 10, 200);
  const lines = [];
  let used = 0;
  let cutShort = false;
  const label = (n, indent, note) => `${'  '.repeat(indent)}${oneLine(n.title, 80)} [${n.noteId}]${noteType(n) !== 'text' ? ` (${noteType(n)})` : ''}${note || ''}`;

  async function visit(n, indent, levelsLeft) {
    let ids = n.childNoteIds || [];
    if (n.noteId === 'root') ids = ids.filter((x) => !x.startsWith('_')); // system subtrees (_hidden and friends)
    if (!levelsLeft) {
      lines.push(label(n, indent, ids.length ? ` (+${ids.length})` : ''));
      return;
    }
    lines.push(label(n, indent));
    const room = maxItems - used;
    if (room <= 0) {
      cutShort = cutShort || ids.length > 0;
      return;
    }
    const take = ids.slice(0, room);
    if (ids.length > take.length) cutShort = true;
    used += take.length;
    const kids = await pmap(take, (cid) => getNote(cid));
    for (let i = 0; i < take.length; i++) {
      if (!kids[i]) lines.push(`${'  '.repeat(indent + 1)}${take[i]} (unreadable)`);
      else await visit(kids[i], indent + 1, levelsLeft - 1);
    }
  }

  const top = await getNote(rootId);
  await visit(top, 0, depth);
  return cap(lines.join('\n') + (cutShort ? `\n[cut at ${maxItems} notes: ask for a deeper subtree with id]` : ''));
}

async function toolRecentChanges(args) {
  const limit = clampInt(args.limit, 30, 1, 100);
  const r = await request('GET', '/notes/history' + qs({ ancestorNoteId: args.ancestor ? checkId(str(args.ancestor), 'ancestor') : '' }));
  const rows = Array.isArray(r.json) ? r.json : [];
  if (!rows.length) return 'no recent changes';
  const shown = rows.slice(0, limit);
  return cap(
    `${shown.length} of ${rows.length} recent changes\nwhen (UTC) | id | title | state\n` +
      shown.map((c) => [str(c.utcDate).slice(0, 19), c.noteId, oneLine(c.current_title || c.title, 80), c.current_isDeleted ? `deleted${c.canBeUndeleted ? ' (can undelete)' : ''}` : ''].join(' | ')).join('\n')
  );
}

// ---------------------------------------------------------------- write tools

async function toolCreateNote(args) {
  const parent = checkId(str(args.parent), 'parent');
  const title = str(args.title).trim();
  if (!title) throw new ToolError('title is required');
  if (title.length > 300) throw new ToolError('title is longer than 300 chars');
  const format = str(args.format).trim().toLowerCase() || 'html';
  if (format !== 'html' && format !== 'markdown') throw new ToolError('format must be html or markdown');
  let type = str(args.type).trim() || 'text';
  if (!CREATE_TYPES.includes(type)) throw new ToolError(`type must be one of: ${CREATE_TYPES.join(', ')}`);
  if (format === 'markdown' && type !== 'text') throw new ToolError('format=markdown only applies to type text');
  let content = str(args.content);
  if (content.length > MAX_CONTENT_CHARS) throw new ToolError('content is too long');
  let mime;
  if (type === 'text' && format === 'markdown') {
    // Trilium stores a Markdown note as a code note with a markdown mime type.
    type = 'code';
    mime = 'text/x-markdown';
  } else if (type === 'text') {
    content = await toHtml(content);
  } else if (type === 'code') {
    mime = str(args.mime).trim() || 'text/plain';
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new ToolError('mime must look like text/plain');
  }
  await getNote(parent); // fails with "not found" before anything is created

  const labels = args.labels && typeof args.labels === 'object' && !Array.isArray(args.labels) ? Object.entries(args.labels) : [];
  const relations = args.relations && typeof args.relations === 'object' && !Array.isArray(args.relations) ? Object.entries(args.relations) : [];
  const targets = [...new Set(relations.map(([, v]) => checkId(str(v), 'relation target')))];
  if (targets.length) {
    const titles = await noteTitles(targets);
    const missing = targets.filter((t) => titles.get(t) === null);
    if (missing.length) throw new ToolError(`relation target(s) not found: ${missing.join(', ')}; nothing was created`);
  }

  const body = { parentNoteId: parent, title, type, content };
  if (mime) body.mime = mime;
  if (args.position !== undefined) body.notePosition = clampInt(args.position, 10, 0, 100000000);
  const r = await request('POST', '/create-note', { json: body });
  const note = r.json && r.json.note;
  if (!note || !note.noteId) throw new ToolError('Trilium answered but no note came back');

  const warnings = [];
  for (const [name, value] of labels) {
    try {
      await addAttribute(note.noteId, 'label', name, value);
    } catch (err) {
      warnings.push(`label ${oneLine(name, 40)} failed (${describeError(err)})`);
    }
  }
  for (const [name, value] of relations) {
    try {
      await addAttribute(note.noteId, 'relation', name, str(value));
    } catch (err) {
      warnings.push(`relation ${oneLine(name, 40)} failed (${describeError(err)})`);
    }
  }
  const extras = [];
  if (labels.length) extras.push(`${labels.length} label(s)`);
  if (relations.length) extras.push(`${relations.length} relation(s)`);
  return `created ${note.noteId}: ${title} (${noteType({ type, mime })}) under ${parent}${extras.length ? `; ${extras.join(', ')}` : ''}` + (warnings.length ? `\nWARNING: ${warnings.join('\nWARNING: ')}` : '');
}

function countOf(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

async function toolUpdateNote(args) {
  const id = checkId(args.id);
  const modes = ['content', 'append', 'replace_text'].filter((k) => args[k] !== undefined);
  if (modes.length > 1) throw new ToolError('use only one of content, append, replace_text');
  if (args.title === undefined && !modes.length) throw new ToolError('nothing to update: pass title, content, append or replace_text');
  let title;
  if (args.title !== undefined) {
    title = str(args.title).trim();
    if (!title) throw new ToolError('title cannot be empty');
    if (title.length > 300) throw new ToolError('title is longer than 300 chars');
  }
  const note = await getNote(id);
  if (note.isProtected) throw new ToolError('this note is protected; ETAPI cannot change protected notes');
  const changed = [];
  let next;
  if (modes.length) {
    if (!TEXT_TYPES.has(note.type)) throw new ToolError(`the content of a ${note.type} note cannot be edited through this connector`);
    const html = holdsHtml(note);
    if (args.content !== undefined) {
      next = html ? await toHtml(str(args.content)) : str(args.content);
      changed.push('content (replaced)');
    } else if (args.append !== undefined) {
      const add = str(args.append);
      if (!add) throw new ToolError('append is empty');
      const cur = await readContent(note);
      const piece = html ? await toHtml(add) : add;
      next = cur + (!html && cur && !cur.endsWith('\n') ? '\n' : '') + piece;
      changed.push('content (appended)');
    } else {
      const spec = args.replace_text;
      const find = str(spec && spec.find);
      if (!spec || typeof spec !== 'object' || !find) throw new ToolError('replace_text needs {find, replace}; find is the exact text as get_note shows it');
      const cur = await readContent(note);
      const view = html ? fromHtml(cur) : cur;
      const hits = countOf(view, find);
      if (!hits) throw new ToolError('the text to replace was not found in the note (copy it exactly from get_note)');
      if (hits > 1 && spec.all !== true) throw new ToolError(`the text appears ${hits} times; use a longer piece or pass all=true`);
      const replaced = spec.all === true ? view.split(find).join(str(spec.replace)) : view.replace(find, () => str(spec.replace));
      next = html ? await toHtml(replaced) : replaced;
      changed.push(`content (${spec.all === true ? hits : 1} replacement(s))`);
    }
    if (next.length > MAX_CONTENT_CHARS) throw new ToolError('the new content is too long');
    // Safety net: keep a revision of what is there now. No revision, no change.
    try {
      await request('POST', `/notes/${enc(id)}/revision`);
    } catch (err) {
      throw new ToolError(`could not save a revision of the note first (${describeError(err)}); nothing was changed`);
    }
    await request('PUT', `/notes/${enc(id)}/content`, { text: next });
  }
  if (title !== undefined) {
    await request('PATCH', `/notes/${enc(id)}`, { json: { title } });
    changed.push(`title: ${oneLine(note.title, 60)} -> ${oneLine(title, 60)}`);
  }
  return `updated ${id}: ${oneLine(title || note.title, 80)}; changed: ${changed.join(', ')}${modes.length ? '; a revision of the old content was saved' : ''}`;
}

async function toolCloneNote(args) {
  const id = checkId(args.id);
  const to = checkId(str(args.to_parent), 'to_parent');
  const note = await getNote(id);
  await getNote(to);
  const body = { noteId: id, parentNoteId: to };
  if (args.position !== undefined) body.notePosition = clampInt(args.position, 10, 0, 100000000);
  if (str(args.prefix).trim()) body.prefix = str(args.prefix).trim().slice(0, 100);
  const r = await request('POST', '/branches', { json: body });
  return `${r.status === 201 ? 'cloned' : 'updated the existing placement of'} ${id} (${oneLine(note.title, 60)}) under ${to}; it is now in several places in the tree, one note`;
}

async function toolMoveNote(args) {
  const id = checkId(args.id);
  const to = checkId(str(args.to_parent), 'to_parent');
  const note = await getNote(id);
  const parents = note.parentNoteIds || [];
  let from = args.from_parent ? checkId(str(args.from_parent), 'from_parent') : '';
  if (!from) {
    if (parents.length !== 1) throw new ToolError(`the note has ${parents.length} parents (${parents.join(', ')}); pass from_parent to say which placement to move`);
    from = parents[0];
  }
  if (!parents.includes(from)) throw new ToolError(`${from} is not a parent of ${id} (parents: ${parents.join(', ') || 'none'})`);
  if (from === to) throw new ToolError('from_parent and to_parent are the same');
  await getNote(to);
  let branchId = '';
  for (const bid of note.parentBranchIds || []) {
    const r = await request('GET', `/branches/${enc(bid)}`);
    if (r.json && r.json.parentNoteId === from) {
      branchId = r.json.branchId || bid;
      break;
    }
  }
  if (!branchId) throw new ToolError('could not find the placement under the old parent');
  const body = { noteId: id, parentNoteId: to };
  if (args.position !== undefined) body.notePosition = clampInt(args.position, 10, 0, 100000000);
  // Add the new placement first, and check it is there, before the old one goes: the note is never left without a parent.
  await request('POST', '/branches', { json: body });
  const after = await getNote(id);
  if (!(after.parentNoteIds || []).includes(to)) throw new ToolError('the new placement did not appear; the note was left where it was');
  await request('DELETE', `/branches/${enc(branchId)}`);
  return `moved ${id} (${oneLine(note.title, 60)}) from ${from} to ${to}`;
}

async function toolSetLabel(args) {
  const id = checkId(args.id);
  const name = str(args.name).trim();
  if (!NAME_RE.test(name)) throw new ToolError('name is required: a label name without spaces');
  const value = str(args.value);
  const note = await getNote(id);
  const same = (note.attributes || []).filter((a) => a.type === 'label' && a.name === name);
  if (same.length > 1) throw new ToolError(`the note has ${same.length} labels named ${name}; use remove_attribute first, then set_label`);
  if (same.length === 1) {
    if (str(same[0].value) === value) return `${id} already has #${name}${value ? `=${oneLine(value, 60)}` : ''}; nothing changed`;
    await request('PATCH', `/attributes/${enc(same[0].attributeId)}`, { json: { value } });
    return `updated #${name} on ${id}: ${oneLine(same[0].value, 60) || '(empty)'} -> ${oneLine(value, 60) || '(empty)'}`;
  }
  await addAttribute(id, 'label', name, value, args.inheritable === true);
  return `set #${name}${value ? `=${oneLine(value, 60)}` : ''} on ${id}`;
}

async function toolSetRelation(args) {
  const id = checkId(args.id);
  const name = str(args.name).trim();
  if (!NAME_RE.test(name)) throw new ToolError('name is required: a relation name without spaces');
  const target = checkId(str(args.target), 'target');
  const [note, targetNote] = await Promise.all([getNote(id), getNote(target)]);
  if ((note.attributes || []).some((a) => a.type === 'relation' && a.name === name && a.value === target)) {
    return `${id} already has ~${name} -> ${target}; nothing changed`;
  }
  await addAttribute(id, 'relation', name, target, args.inheritable === true);
  return `added ~${name} on ${id} (${oneLine(note.title, 50)}) -> ${target} (${oneLine(targetNote.title, 50)}); a note can have the same relation to several notes`;
}

async function toolRemoveAttribute(args) {
  const id = checkId(args.id);
  const name = str(args.name).trim();
  if (!name) throw new ToolError('name is required');
  const type = str(args.type).trim().toLowerCase();
  if (type && type !== 'label' && type !== 'relation') throw new ToolError('type must be label or relation');
  const note = await getNote(id);
  const hits = (note.attributes || []).filter((a) => a.name === name && (!type || a.type === type) && (args.value === undefined || str(a.value) === str(args.value)));
  if (!hits.length) throw new ToolError(`no attribute named ${name}${args.value !== undefined ? ` with value ${oneLine(args.value, 40)}` : ''} on this note (see get_note)`);
  if (hits.length > 1 && args.all !== true) {
    throw new ToolError(`${hits.length} attributes match (${hits.map((a) => `${a.type === 'relation' ? '~' : '#'}${a.name}=${oneLine(a.value, 30)}`).join(', ')}); pass value to pick one, or all=true`);
  }
  for (const a of hits) await request('DELETE', `/attributes/${enc(a.attributeId)}`);
  return `removed ${hits.length} attribute(s) named ${name} from ${id}`;
}

async function toolDayNote(args) {
  const date = str(args.date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) throw new ToolError('date must be YYYY-MM-DD');
  // Trilium creates the day note (and its month and year notes) when it does not exist yet.
  const r = await request('GET', `/calendar/days/${enc(date)}`);
  const n = r.json || {};
  return `day note for ${date}: ${n.noteId || '?'} (${oneLine(n.title, 60)}); created if it did not exist`;
}

async function toolCreateBackup(args) {
  const name = str(args.name).trim() || 'claude';
  if (!/^[A-Za-z0-9_]{1,32}$/.test(name)) throw new ToolError('name must be letters, digits and underscores (up to 32)');
  await request('PUT', `/backup/${enc(name)}`);
  return `backup written as backup-${name}.db in Trilium's backup folder`;
}

async function toolUndeleteNote(args) {
  const id = checkId(args.id);
  await request('POST', `/notes/${enc(id)}/undelete`);
  return `restored ${id} (it needs an undeleted parent; see get_note)`;
}

// ------------------------------------------------------- destructive tools

async function toolDeleteNote(args) {
  const id = checkId(args.id);
  const note = await getNote(id);
  const kids = (note.childNoteIds || []).length;
  await request('DELETE', `/notes/${enc(id)}`);
  return `deleted ${id}: ${oneLine(note.title, 80)}${kids ? ` (with ${kids} direct child note(s) and everything below)` : ''}. It is a soft delete: undelete_note ${id} brings it back until Trilium erases deleted notes (delay in Trilium's options)`;
}

// ------------------------------------------------------------------ tools

const s = (description) => (description ? { type: 'string', description } : { type: 'string' });
const obj = (description) => ({ type: 'object', description, additionalProperties: true });

const TOOLS = [
  {
    name: 'status',
    description: 'Checks the connection: Trilium version and which switches are on (write, delete).',
    inputSchema: { type: 'object', properties: {} },
    run: toolStatus,
  },
  {
    name: 'search_notes',
    description:
      'Search notes with Trilium search syntax: words, "exact phrase", #label, #label=value, ~relation, note.title *=* part, and combinations such as: ancestor-limited towers #book. ancestor limits to a subtree, depth eq1 means direct children only. Returns id | title | type | labels and relations lines.',
    inputSchema: {
      type: 'object',
      properties: {
        q: s('search query'),
        ancestor: s('only search below this note id'),
        depth: s('eq1, lt3, gt2 ... relative to ancestor'),
        fast: { type: 'boolean', description: 'do not look into note content' },
        archived: { type: 'boolean', description: 'include archived notes' },
        order_by: s('title, dateModified, dateCreated or #label'),
        order_dir: s('asc or desc'),
        limit: { type: 'integer', description: 'default 20, max 100' },
      },
      required: ['q'],
    },
    run: toolSearchNotes,
  },
  {
    name: 'get_note',
    description:
      'One note: title, type, parents, attributes (relations come with the title of the target), children and the content. Links to other notes in text notes show as [[noteId]] (reference link) or [[noteId|label]]; a links: line lists the titles behind them. Protected notes cannot be read.',
    inputSchema: {
      type: 'object',
      properties: { id: s('note id; root is the top of the tree'), content: { type: 'boolean', description: 'false: metadata and children only' }, max_chars: { type: 'integer', description: 'default 8000, max 40000' } },
      required: ['id'],
    },
    run: toolGetNote,
  },
  {
    name: 'get_tree',
    description: 'The note tree below a note as an indented outline (title [id]). Default is the whole tree from root, 2 levels deep. System subtrees are left out.',
    inputSchema: {
      type: 'object',
      properties: { id: s('start note, default root'), depth: { type: 'integer', description: '1-4, default 2' }, max_items: { type: 'integer', description: 'default 80, max 200' } },
    },
    run: toolGetTree,
  },
  {
    name: 'recent_changes',
    description: 'Recently created, edited and deleted notes, newest first, optionally only below one note.',
    inputSchema: { type: 'object', properties: { ancestor: s('only below this note id'), limit: { type: 'integer', description: 'default 30, max 100' } } },
    run: toolRecentChanges,
  },
  {
    name: 'create_note',
    description:
      'Create a note under a parent. Text notes hold HTML (p, h2, ul, li, strong, em, table ...); inside it write [[noteId]] for a reference link to another note and [[noteId|label]] for a link with your own text, unknown ids are refused. format=markdown makes a Markdown note instead (typed as is; [[noteId]] is native there). labels is {name: value}, relations is {name: target note id}. Types: text, code (needs mime), book, search, render.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        parent: s('parent note id'),
        title: s(),
        content: s('HTML for text notes, Markdown with format=markdown'),
        format: s('html (default) or markdown'),
        type: s('text (default), code, book, search or render'),
        mime: s('for code notes, e.g. application/json'),
        position: { type: 'integer', description: 'order among siblings: 10, 20, 30...' },
        labels: obj('{name: value}'),
        relations: obj('{name: target note id}'),
      },
      required: ['parent', 'title'],
    },
    run: toolCreateNote,
  },
  {
    name: 'update_note',
    description:
      'Change a note. title renames. For the content pass exactly one of: content (replaces everything), append (adds at the end), replace_text {find, replace, all} (find is the exact text as get_note shows it). Links work as in create_note. A revision of the old content is saved first; if that fails nothing changes.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: s(),
        title: s(),
        content: s('REPLACES the whole content'),
        append: s(),
        replace_text: { type: 'object', description: '{find, replace, all}', properties: { find: s(), replace: s(), all: { type: 'boolean' } }, required: ['find', 'replace'] },
      },
      required: ['id'],
    },
    run: toolUpdateNote,
  },
  {
    name: 'move_note',
    description: 'Move a note to another parent. Without from_parent the note must have exactly one parent. The new placement is created and checked before the old one is removed.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: s(), to_parent: s(), from_parent: s('only when the note sits in several places'), position: { type: 'integer' } },
      required: ['id', 'to_parent'],
    },
    run: toolMoveNote,
  },
  {
    name: 'clone_note',
    description: 'Show the same note in a second place in the tree (one note, two placements). It is not a copy: editing it changes both.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: s(), to_parent: s(), prefix: s('title prefix for this placement only'), position: { type: 'integer' } },
      required: ['id', 'to_parent'],
    },
    run: toolCloneNote,
  },
  {
    name: 'set_label',
    description: 'Set a label (a tag with an optional value) on a note: set_label {id, name: "npc"} or with value. Updates the label if it already exists.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: s(), name: s('without the #'), value: s(), inheritable: { type: 'boolean' } },
      required: ['id', 'name'],
    },
    run: toolSetLabel,
  },
  {
    name: 'set_relation',
    description: 'Add a relation from a note to another note, for example scene -> npc -> NPC note. A note may have the same relation to several targets; adding an existing one changes nothing.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: s('note the relation starts from'), name: s('relation name without the ~'), target: s('note id it points to'), inheritable: { type: 'boolean' } },
      required: ['id', 'name', 'target'],
    },
    run: toolSetRelation,
  },
  {
    name: 'remove_attribute',
    description: 'Remove a label or relation by name from a note. Pass value to pick one when there are several, or all=true to remove all of them.',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { id: s(), name: s(), type: s('label or relation'), value: s('label value, or target note id for a relation'), all: { type: 'boolean' } },
      required: ['id', 'name'],
    },
    run: toolRemoveAttribute,
  },
  {
    name: 'day_note',
    description: 'The journal note for a date (YYYY-MM-DD). Trilium creates it, with its month and year notes, when it does not exist.',
    write: true,
    inputSchema: { type: 'object', properties: { date: s('YYYY-MM-DD') }, required: ['date'] },
    run: toolDayNote,
  },
  {
    name: 'undelete_note',
    description: 'Bring a deleted note back (see recent_changes for deleted ones). Its parent must still exist.',
    write: true,
    inputSchema: { type: 'object', properties: { id: s() }, required: ['id'] },
    run: toolUndeleteNote,
  },
  {
    name: 'create_backup',
    description: 'Write a database backup in Trilium (backup-<name>.db). Worth doing before a big reorganisation.',
    write: true,
    inputSchema: { type: 'object', properties: { name: s('letters, digits, underscore; default claude') } },
    run: toolCreateBackup,
  },
  {
    name: 'delete_note',
    description: 'Delete a note together with everything below it (soft delete, see undelete_note).',
    write: true,
    destructive: true,
    inputSchema: { type: 'object', properties: { id: s() }, required: ['id'] },
    run: toolDeleteNote,
  },
];

// -------------------------------------------------------------------- MCP

function describeError(err) {
  if (err instanceof ToolError) return err.message;
  const code = (err && (err.code || err.message)) || 'error';
  let host = 'Trilium';
  try {
    host = baseUrl().host;
  } catch (_) {
    host = 'Trilium';
  }
  return `cannot reach Trilium at ${host} (${code})`;
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
        serverInfo: { name: 'trilium', version: '1.0.0' },
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
        return { content: [{ type: 'text', text: 'write tools are disabled on this connector (TRILIUM_ENABLE_WRITE is not true)' }], isError: true };
      }
      if (tool.destructive && !destructiveEnabled()) {
        return { content: [{ type: 'text', text: 'deleting notes is disabled on this connector (TRILIUM_ENABLE_DESTRUCTIVE is not true)' }], isError: true };
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

module.exports = { fromHtml, escHtml, wikiIds, holdsHtml, isMarkdownMime, handleRequest, TOOLS, ToolError, isNeverAllowed, isDestructiveRoute, REF_PREFIX };

if (require.main === module) main();
