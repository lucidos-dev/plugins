// Ouroboros: per-device storage that never throws.
//
// An app frame has an opaque origin, so its own window.localStorage throws.
// The values live in lucidos.storage.local instead: the SDK's per-device
// store, with the same calls. Await ready() once before the first read, since
// a read before it sees nothing stored. A refused write (a full store) fails
// silently, so callers can treat storage as best-effort without their own
// try/catch.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.Ouroboros = root.Ouroboros || {}).SafeStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // `getBackend` returns a Storage-shaped store. It is called on every access,
  // so the SDK only has to be there by the time something is read.
  function createSafeStorage(getBackend = () => globalThis.lucidos.storage.local) {
    return {
      get(key) { try { return getBackend().getItem(key); } catch (e) { return null; } },
      set(key, value) { try { getBackend().setItem(key, value); } catch (e) { /* best-effort */ } },
      remove(key) { try { getBackend().removeItem(key); } catch (e) { /* best-effort */ } }
    };
  }

  // Resolves once this device's stored values are readable. If the host could
  // not hand them over, the game still starts, as on a first visit.
  async function ready() {
    try {
      await globalThis.lucidos.storage.ready;
    } catch (e) {
      console.warn('Ouroboros: could not read this device\'s saved settings', e);
    }
  }

  return { createSafeStorage, ready };
});
