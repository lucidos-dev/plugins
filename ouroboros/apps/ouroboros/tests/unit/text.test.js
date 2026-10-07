const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml } = require('../../js/core/text.js');

test('escapeHtml escapes markup and both quote styles', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
});

test('escapeHtml stringifies numbers and blanks out null', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});
