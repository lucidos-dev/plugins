// Ouroboros: the current player and the list of known players.
//
// The current player is remembered per device (localStorage); the list of
// known players lives in the active store so every device sees it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Ouroboros = root.Ouroboros || {}).createPlayers = factory().createPlayers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LS_PLAYER = 'snake-player';
  const ANONYMOUS = 'ANONYM';

  function normalize(name) {
    return (name || '').trim().toUpperCase();
  }

  // deps.store: { readPlayers, writePlayers }; deps.storage: SafeStorage
  function createPlayers({ store, storage }) {
    let known = [];
    let current = '';

    async function add(name) {
      const n = normalize(name);
      if (!n || n === ANONYMOUS || known.includes(n)) return;
      known.push(n);
      try { await store.writePlayers(known); } catch (e) { console.warn('writePlayers failed', e); }
    }

    return {
      get current() { return current; },

      // Known players worth offering as quick picks
      list() { return known.filter(p => p && p !== ANONYMOUS); },

      async load() {
        try {
          const list = await store.readPlayers();
          if (Array.isArray(list)) known = list;
        } catch (e) { console.warn('loadPlayers failed', e); }
      },

      // Switch to `name` (blank means anonymous), remember it on this device
      // and add it to the known list. Returns the normalized name.
      setCurrent(name) {
        current = normalize(name) || ANONYMOUS;
        void add(current);
        storage.set(LS_PLAYER, current);
        return current;
      },

      saved() { return storage.get(LS_PLAYER) || ''; }
    };
  }

  return { createPlayers };
});
