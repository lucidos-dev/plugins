// Ouroboros: text helpers.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.Ouroboros = root.Ouroboros || {}).Text = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // Safe for both element content and quoted attribute values. Scoreboard data
  // can come from a shared board that other people write to, so every value
  // that reaches innerHTML goes through this.
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ENTITIES[ch]);
  }

  return { escapeHtml };
});
