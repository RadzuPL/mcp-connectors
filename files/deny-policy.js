'use strict';
/*
 * Access policy for the files connector.
 *
 * Pure logic, no I/O besides reading the filesystem to resolve paths. Used by
 * deny-proxy.js, which sits between supergateway and mcp-server-filesystem.
 *
 * Environment (parsed by parseEnv):
 *   DENY_NAMES   comma-separated name patterns (* and ? only, case-insensitive).
 *                A path is refused when ANY of its segments below an allowed
 *                directory matches: files, directories, symlink targets.
 *                Example: secrets*,.esphome
 *   ALLOW_ONLY   rules "absolute-prefix=glob|glob", separated by ";". Below the
 *                prefix only FILES whose name matches one of the globs can be
 *                read or written (directories stay listable).
 *                Example: /data/ha-esphome=*.yaml|*.yml
 *   READ_ONLY    1/true/yes: every write tool is refused.
 *
 * Design rules: fail closed. Anything not understood is refused, never passed.
 */
const fs = require('fs');
const path = require('path');

// Tools of @modelcontextprotocol/server-filesystem. Each path argument is
// [argument name, kind]. kind: 'file', 'dir' or 'auto' (looked up on disk).
// A tool that is not in this table is refused (see check-upstream test).
const TOOLS = {
  list_allowed_directories: { paths: [] },
  read_file: { paths: [['path', 'file']] },
  read_text_file: { paths: [['path', 'file']] },
  read_media_file: { paths: [['path', 'file']] },
  read_multiple_files: { pathLists: ['paths'] },
  write_file: { write: true, paths: [['path', 'file']] },
  edit_file: { write: true, paths: [['path', 'file']] },
  create_directory: { write: true, paths: [['path', 'dir']] },
  list_directory: { paths: [['path', 'dir']], filter: 'list' },
  list_directory_with_sizes: { paths: [['path', 'dir']], filter: 'list_sizes' },
  directory_tree: { paths: [['path', 'dir']], filter: 'tree' },
  move_file: { write: true, paths: [['source', 'auto'], ['destination', 'auto']] },
  search_files: { paths: [['path', 'dir']], filter: 'search' },
  get_file_info: { paths: [['path', 'auto']] },
};

const deny = (reason) => ({ ok: false, reason });

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// ---------------------------------------------------------------- patterns --

function formsOf(name) {
  // Different spellings a case-insensitive / Windows-flavoured server (Samba)
  // may resolve to the same file: case, trailing dots and spaces, NTFS stream
  // suffix ("name:stream"), Unicode compatibility forms.
  const out = new Set();
  const add = (s) => { out.add(s); out.add(s.normalize('NFKC')); };
  const lower = name.toLowerCase();
  add(lower);
  add(lower.replace(/[. ]+$/, ''));
  const colon = lower.indexOf(':');
  if (colon > 0) add(lower.slice(0, colon).replace(/[. ]+$/, ''));
  return [...out];
}

function globToRegExp(glob) {
  let re = '';
  for (const ch of glob.normalize('NFKC').toLowerCase()) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 's');
}

// 8.3 short names ("SECRET~1.YAM") that a Samba share may hand out for a long name.
const SHORT_NAME = /^[^.]{1,6}~\d+(\.[^.]{0,3})?$/i;

// ------------------------------------------------------------------- paths --

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function relSegments(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' ? [] : rel.split(path.sep);
}

// realpath of the deepest existing ancestor + the not-yet-existing rest.
function realResolve(abs, fsx) {
  let cur = abs;
  const rest = [];
  for (;;) {
    try {
      const r = fsx.realpathSync(cur);
      return rest.length ? path.join(r, ...rest.slice().reverse()) : r;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// ------------------------------------------------------------------ config --

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

function parseEnv(env) {
  const denyNames = String(env.DENY_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const readOnly = truthy(env.READ_ONLY);
  const allowOnly = [];
  for (const raw of String(env.ALLOW_ONLY || '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = raw.indexOf('=');
    const prefix = eq > 0 ? raw.slice(0, eq).trim() : '';
    const globs = eq > 0 ? raw.slice(eq + 1).split('|').map((s) => s.trim()).filter(Boolean) : [];
    if (!prefix || !path.isAbsolute(prefix) || globs.length === 0) {
      throw new Error(`ALLOW_ONLY rule "${raw}" must look like /absolute/prefix=*.yaml|*.yml`);
    }
    allowOnly.push({ prefix, globs });
  }
  return { denyNames, allowOnly, readOnly, active: denyNames.length > 0 || allowOnly.length > 0 || readOnly };
}

// ------------------------------------------------------------------ policy --

function createPolicy(opts) {
  const fsx = opts.fs || fs;
  const roots = (opts.roots || []).map((r) => path.resolve(r));
  const denyNames = (opts.denyNames || []).map((src) => ({ src, re: globToRegExp(src) }));
  const allowOnly = (opts.allowOnly || []).map((r) => ({
    prefix: path.resolve(r.prefix),
    res: r.globs.map(globToRegExp),
  }));
  const readOnly = !!opts.readOnly;
  if (roots.length === 0) throw new Error('no allowed directories given');

  const realRoots = () => roots.map((r) => { try { return fsx.realpathSync(r); } catch (e) { return r; } });

  function segmentDenied(seg) {
    const forms = formsOf(seg);
    for (const dn of denyNames) {
      if (forms.some((f) => dn.re.test(f))) return `"${seg}" matches DENY_NAMES entry "${dn.src}"`;
    }
    if (forms.some((f) => SHORT_NAME.test(f))) return `"${seg}" looks like an 8.3 short name`;
    return null;
  }

  function doCheck(p, o) {
    if (typeof p !== 'string' || p === '' || p.includes('\0')) return deny('invalid path');
    if (p.startsWith('~')) return deny('paths starting with ~ are not accepted');
    if (o.write && readOnly) return deny('READ_ONLY is on: write tools are disabled');

    const lex = path.resolve(p);
    const lexRoot = roots.find((r) => within(lex, r));
    if (!lexRoot) return deny('outside the allowed directories');
    const real = realResolve(lex, fsx);
    const realRoot = realRoots().find((r) => within(real, r));
    if (!realRoot) return deny('resolves outside the allowed directories');

    for (const [target, root] of [[lex, lexRoot], [real, realRoot]]) {
      for (const seg of relSegments(target, root)) {
        const hit = segmentDenied(seg);
        if (hit) return deny(hit);
      }
    }

    let isDir = o.kind === 'dir';
    if (o.kind !== 'dir' && o.kind !== 'file') {
      try { isDir = fsx.statSync(real).isDirectory(); } catch (e) { isDir = false; }
    }
    if (!isDir) {
      for (const rule of allowOnly) {
        for (const target of [lex, real]) {
          if (target === rule.prefix || !within(target, rule.prefix)) continue;
          const forms = formsOf(path.basename(target));
          // allowed only when EVERY spelling matches, so "x.txt:y.yaml" does not slip in
          if (!forms.every((f) => rule.res.some((re) => re.test(f)))) {
            return deny(`"${path.basename(target)}" does not match ALLOW_ONLY for ${rule.prefix}`);
          }
        }
      }
    }
    return { ok: true, lex, real };
  }

  function checkPath(p, o) {
    try {
      return doCheck(p, o || {});
    } catch (e) {
      return deny(`cannot resolve path safely (${e.code || e.message})`);
    }
  }

  // Request side -----------------------------------------------------------

  function vetToolCall(name, args) {
    const spec = Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : null;
    if (!spec) return deny(`tool "${name}" is not known to the access policy`);
    if (args === undefined || args === null) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) return deny('arguments must be an object');
    const write = !!spec.write;
    if (write && readOnly) return deny('READ_ONLY is on: write tools are disabled');

    let sourceIsDir = false;
    for (const [argName, kind] of spec.paths || []) {
      const v = args[argName];
      if (typeof v !== 'string') return deny(`missing or invalid "${argName}"`);
      let k = kind;
      if (name === 'move_file') {
        if (argName === 'source') {
          const r = checkPath(v, { write, kind: 'auto' });
          if (!r.ok) return r;
          try { sourceIsDir = fsx.statSync(r.real).isDirectory(); } catch (e) { sourceIsDir = false; }
          continue;
        }
        k = sourceIsDir ? 'dir' : 'file';
      }
      const r = checkPath(v, { write, kind: k });
      if (!r.ok) return r;
    }
    for (const argName of spec.pathLists || []) {
      const list = args[argName];
      if (!Array.isArray(list) || list.length === 0) return deny(`missing or invalid "${argName}"`);
      for (const v of list) {
        const r = checkPath(v, { write, kind: 'file' });
        if (!r.ok) return r;
      }
    }
    return { ok: true, filter: spec.filter || null, args };
  }

  // Response side ----------------------------------------------------------

  function hiddenEntries(dir) {
    const real = realResolve(path.resolve(dir), fsx);
    const hidden = [];
    for (const n of fsx.readdirSync(real)) {
      if (!checkPath(path.join(dir, n), { kind: 'auto' }).ok) hidden.push(n);
    }
    return hidden;
  }

  function filterList(text, dir, sizes) {
    const hidden = hiddenEntries(dir);
    return text.split('\n').filter((line) => {
      if (sizes && (/^Total:/.test(line) || /^Combined size:/.test(line))) return false;
      const m = /^\[(FILE|DIR)\] (.*)$/.exec(line);
      if (!m) return true;
      return !hidden.some((n) => m[2] === n || m[2].startsWith(n + ' '));
    }).join('\n');
  }

  function filterTreeNodes(nodes, dir) {
    if (!Array.isArray(nodes)) throw new Error('unexpected directory_tree shape');
    return nodes
      .filter((n) => n && typeof n.name === 'string')
      .filter((n) => checkPath(path.join(dir, n.name), { kind: 'auto' }).ok)
      .map((n) => (Array.isArray(n.children)
        ? { ...n, children: filterTreeNodes(n.children, path.join(dir, n.name)) }
        : n));
  }

  function filterText(ctx, text) {
    const base = ctx.args.path;
    switch (ctx.filter) {
      case 'list': return filterList(text, base, false);
      case 'list_sizes': return filterList(text, base, true);
      case 'tree': return JSON.stringify(filterTreeNodes(JSON.parse(text), base), null, 2);
      case 'search': {
        const lines = text.split('\n');
        const kept = lines.filter((l) => l.trim() === '' || l === 'No matches found' || checkPath(l, { kind: 'auto' }).ok);
        const anyPath = kept.some((l) => l.trim() !== '' && l !== 'No matches found');
        return anyPath ? kept.join('\n') : 'No matches found';
      }
      default: return text;
    }
  }

  // ctx comes from vetToolCall. Returns the (possibly rewritten) result, or throws
  // when the shape is not understood; the caller then answers with an error.
  function filterResult(ctx, result) {
    if (!ctx.filter || !result || result.isError) return result;
    if (!Array.isArray(result.content) || result.content.length === 0) throw new Error('unexpected result shape');
    const content = result.content.map((item) => {
      if (!item || item.type !== 'text' || typeof item.text !== 'string') throw new Error('unexpected content item');
      return { ...item, text: filterText(ctx, item.text) };
    });
    const out = { ...result, content };
    if (result.structuredContent !== undefined) {
      // The upstream server repeats the text in structuredContent; rebuild it from
      // the filtered text so the unfiltered copy never leaves.
      out.structuredContent = { content: content.map((c) => c.text).join('\n') };
    }
    return out;
  }

  return { checkPath, vetToolCall, filterResult };
}

module.exports = { createPolicy, parseEnv, TOOLS, errorResult, formsOf, globToRegExp };
