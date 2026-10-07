// Ouroboros: localStorage that never throws.
//
// Some Lucidos app frames run with an opaque origin, where merely touching
// window.localStorage throws a SecurityError. Every read here falls back to
// null and every write fails silently, so callers can treat storage as
// best-effort without their own try/catch.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.Ouroboros = root.Ouroboros || {}).SafeStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // `getBackend` returns the real Storage; it is called on every access
  // because the getter itself is what throws in an isolated frame.
  function createSafeStorage(getBackend = () => globalThis.localStorage) {
    return {
      get(key) { try { return getBackend().getItem(key); } catch (e) { return null; } },
      set(key, value) { try { getBackend().setItem(key, value); } catch (e) { /* best-effort */ } },
      remove(key) { try { getBackend().removeItem(key); } catch (e) { /* best-effort */ } }
    };
  }

  return { createSafeStorage };
});
