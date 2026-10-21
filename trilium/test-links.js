'use strict';
// Link conversion tests (pure functions, no ETAPI mock needed). Run: node trilium/test-links.js

const assert = require('assert');
const { fromHtml } = require('./server.js');

const ext = '<a href="https://en.wikipedia.org/wiki/Trilium#History">link</a>';
assert.strictEqual(fromHtml(ext), ext, 'external link with a #fragment stays untouched');

const local = '<a href="/docs#Sekcja1">x</a> <a href="#Sekcja1">y</a>';
assert.strictEqual(fromHtml(local), local, 'non-note fragments stay untouched');

assert.strictEqual(fromHtml('<a class="reference-link" href="#root/abcd1234">Borin</a>'), '[[abcd1234]]');
assert.strictEqual(fromHtml('<a href="#root/a1b2c3d4/abcd1234">kowal</a>'), '[[abcd1234|kowal]]');

console.log('ok   link conversion (4 checks)');
