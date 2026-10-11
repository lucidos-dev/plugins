// Theme Studio: the Parts section (ADR 0307).
//
// Every control comes from the part catalog, GET /api/v1/themes/parts, so a part
// or property the engine adds shows here with no app edit. The draft is checked
// with POST /api/v1/themes/resolve, which writes nothing. Its part tokens feed the
// live preview, and its refusal shows beside the property it names. The merge,
// the value grammar and the caps all stay in the engine.
(() => {
  'use strict';

  const PART_PREFIX = '--part-';
  // The app's scope names, and the draft.parts key each one edits.
  const SCOPE_KEY = { tokens: 'shared', dark: 'dark', light: 'light' };
  const PROBE_NAME = 'Theme Studio preview';

  function emptyParts() { return { shared: {}, dark: {}, light: {} }; }

  function pickParts(map) {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) if (k.startsWith(PART_PREFIX) && typeof v === 'string') out[k] = v;
    return out;
  }

  function clone(map) { return JSON.parse(JSON.stringify(map || {})); }

  function humanize(name) {
    const words = String(name).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/-/g, ' ').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function create(host) {
    const { el } = host;
    const $ = (id) => document.getElementById(id);

    let catalog = null;
    const partById = new Map();
    const byToken = new Map();   // part token -> { part, usage }
    let rows = [];
    let counters = [];
    let groupNodes = new Map();  // group key -> <details>
    let resolved = { dark: {}, light: {} };
    let error = null;            // { message, map?, part?, prop? }
    let seq = 0;
    const probeCache = new Map();

    const request = (body) => lucidos.request('/themes/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // ---- Catalog ----
    async function load() {
      try {
        const res = await lucidos.request('/themes/parts');
        if (!res || !Array.isArray(res.parts) || !res.properties || typeof res.properties !== 'object') throw new Error('not a part catalog');
        catalog = res;
      } catch (e) {
        console.warn('[theme-studio] no part catalog', e);
        catalog = null;
        return false;
      }
      for (const part of catalog.parts) {
        partById.set(part.id, part);
        for (const usage of part.properties || []) byToken.set(usage.token, { part, usage });
      }
      return true;
    }
    function available() { return !!catalog; }

    function partLabel(id) { return (partById.get(id) || {}).label || id; }
    function propertyDef(name) { return catalog.properties[name] || {}; }
    function aliasesFor(part, usage) {
      return (catalog.aliases || []).filter((a) => a.property === usage.name && (a.parts || []).includes(part.id));
    }
    function followsParent(part, usage) {
      return !!part.parent && String(usage.default || '').startsWith(`var(${PART_PREFIX}`);
    }
    function defaultText(part, usage) {
      return followsParent(part, usage) ? `follows ${partLabel(part.parent)}` : String(usage.default || '');
    }

    // ---- Draft access ----
    function draftParts() {
      const d = host.getDraft();
      if (!d.parts) d.parts = emptyParts();
      return d.parts;
    }
    function scopeParts() { return draftParts()[SCOPE_KEY[host.getScope()]]; }
    function valueIn(map, partId, prop) {
      const p = map && map[partId];
      return p && typeof p[prop] === 'string' ? p[prop] : undefined;
    }
    function hasValues() {
      const all = draftParts();
      return Object.values(all).some((m) => Object.values(m || {}).some((p) => Object.keys(p || {}).length));
    }
    function write(partId, prop, value) {
      const map = scopeParts();
      if (value === '') {
        if (map[partId]) {
          delete map[partId][prop];
          if (!Object.keys(map[partId]).length) delete map[partId];
        }
      } else {
        if (!map[partId]) map[partId] = {};
        map[partId][prop] = value;
      }
      host.onEdit();
    }

    // ---- Hints from the catalog's caps ----
    function capsHint(part, usage) {
      const def = propertyDef(usage.name);
      const u = def.unit || '';
      const len = (x) => `${x}${u}`;
      const out = [];
      const offsets = () => {
        const bits = [];
        if (u) bits.push(`${u} only`);
        if (def.maxOffset != null) bits.push(`x and y within ±${len(def.maxOffset)}`);
        if (def.maxBlur != null) bits.push(`blur 0 to ${len(def.maxBlur)}`);
        if (def.maxSpread != null) bits.push(`spread within ±${len(def.maxSpread)}`);
        return bits.length ? `${bits.join('; ')}.` : '';
      };
      switch (def.grammar) {
        case 'colour':
          out.push('A colour: a hex, rgb(), hsl(), color-mix(), or a colour token such as var(--accent).');
          if (def.minAlpha != null) out.push(`Alpha at least ${def.minAlpha}, and never transparent.`);
          break;
        case 'shadow': {
          const layer = def.maxSpread != null ? '[inset] x y blur [spread] colour' : 'x y blur colour';
          const layers = def.maxLayers > 1 ? `1 to ${def.maxLayers} layers of ${layer}` : `one layer of ${layer}`;
          out.push(`none, or ${layers}.`, offsets());
          break;
        }
        case 'drop-shadow':
          out.push('none, or one drop-shadow(x y blur colour).', offsets());
          break;
        case 'spacing':
          out.push(`normal, or a length${def.min != null && def.max != null ? ` from ${len(def.min)} to ${len(def.max)}` : ''}.`);
          if (u) out.push(`${u} only.`);
          break;
        case 'length':
          out.push(`A length${def.min != null && def.max != null ? ` from ${len(def.min)} to ${len(def.max)}` : ''}.`);
          if (u) out.push(`${u} only.`);
          break;
        case 'keyword':
          if (Array.isArray(def.values)) out.push(`One of ${def.values.join(', ')}.`);
          break;
        default: {
          // A grammar this version does not know: list whatever caps it carries.
          if (def.effect) out.push('none, or a value Lucidos checks.');
          const caps = [];
          if (u) caps.push(`${u} only`);
          for (const [k, v] of Object.entries(def)) {
            if (typeof v !== 'number') continue;
            const m = /^(min|max)([A-Z].*)$/.exec(k);
            if (m) caps.push(`${humanize(m[2]).toLowerCase()} at ${m[1] === 'max' ? 'most' : 'least'} ${v}`);
            else if (k === 'min' || k === 'max') caps.push(`${k === 'max' ? 'at most' : 'at least'} ${len(v)}`);
          }
          if (Array.isArray(def.values)) caps.push(`one of ${def.values.join(', ')}`);
          const s = caps.join('; ');
          if (s) out.push(`${s.charAt(0).toUpperCase()}${s.slice(1)}.`);
        }
      }
      if (usage.insetOnly) out.push('Inset shadows only.');
      if (def.effect) out.push('Reduce effects hides it.');
      return out.filter(Boolean).join(' ');
    }

    // ---- Rows ----
    function makeRow(part, usage) {
      const def = propertyDef(usage.name);
      const label = humanize(usage.name);
      const row = el('div', 'token-row');
      const head = el('div', 'token-head');
      head.append(el('span', 'token-label', label), el('code', 'token-name', usage.token));
      const desc = el('p', 'token-desc', capsHint(part, usage));
      const control = el('div', 'token-control');

      let input = null;
      let select = null;
      let fill = null;
      let picker = null;
      if (def.grammar === 'keyword' && Array.isArray(def.values)) {
        select = lucidos.ui.Select.create({
          options: [{ value: '', label: 'Unset' }].concat(def.values.map((v) => ({ value: v, label: v }))),
          value: '',
          onChange: (value) => write(part.id, usage.name, value),
        });
        const wrap = el('div', 'part-select');
        wrap.append(select.element);
        control.append(wrap);
      } else {
        if (def.grammar === 'colour') {
          const swatch = el('label', 'swatch');
          fill = el('span', 'swatch-fill');
          picker = el('input');
          picker.type = 'color';
          picker.setAttribute('aria-label', `Pick ${part.label} ${label}`);
          swatch.append(fill, picker);
          control.append(swatch);
        }
        input = el('input', 'value-input text-input');
        input.type = 'text';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', `${part.label} ${label} value`);
        control.append(input);
        input.addEventListener('input', () => write(part.id, usage.name, input.value.trim()));
        if (picker) picker.addEventListener('input', () => { input.value = picker.value; write(part.id, usage.name, picker.value); });
      }

      let off = null;
      if (def.effect) {
        off = el('button', 'accent-link clear-btn', 'Off');
        off.type = 'button';
        off.title = 'Set none, to switch this effect off in the current scope';
        off.setAttribute('aria-label', `Switch ${part.label} ${label} off`);
        off.addEventListener('click', () => { if (input) input.value = 'none'; write(part.id, usage.name, 'none'); });
        control.append(off);
      }
      const reset = el('button', 'accent-link clear-btn', 'Reset');
      reset.type = 'button';
      reset.setAttribute('aria-label', `Reset ${part.label} ${label}`);
      reset.addEventListener('click', () => { if (input) input.value = ''; write(part.id, usage.name, ''); });
      control.append(reset);

      const note = el('div', 'token-default');
      const err = el('p', 'token-error');
      err.hidden = true;
      row.append(head, desc, control, note, err);

      const api = {
        part,
        usage,
        refresh() {
          const scope = host.getScope();
          const mode = host.scopeMode();
          const all = draftParts();
          const own = valueIn(all[SCOPE_KEY[scope]], part.id, usage.name) ?? '';
          const shared = scope !== 'tokens' ? valueIn(all.shared, part.id, usage.name) : undefined;
          let aliasToken = null;
          let aliasValue;
          if (shared === undefined && (scope === 'tokens' || valueIn(all[scope], part.id, usage.name) === undefined)) {
            const explicit = host.explicitFor(mode);
            const hit = aliasesFor(part, usage).find((a) => typeof explicit[a.token] === 'string' && explicit[a.token] !== '');
            if (hit) { aliasToken = hit.token; aliasValue = explicit[hit.token]; }
          }

          if (input && document.activeElement !== input) input.value = own;
          if (select) select.setValue(own);
          row.classList.toggle('is-set', own !== '');
          reset.hidden = own === '';
          if (off) off.hidden = own === 'none';

          const fallback = defaultText(part, usage);
          if (input) input.placeholder = shared ?? aliasValue ?? fallback;
          let text;
          if (own !== '') text = `Default: ${fallback}`;
          else if (shared !== undefined) text = `From Both modes: ${shared}`;
          else if (aliasToken) text = `From ${aliasToken}: ${aliasValue}`;
          else text = `Unset. Default: ${fallback}`;
          if (scope === 'tokens') {
            const over = ['dark', 'light'].filter((m) => valueIn(all[m], part.id, usage.name) !== undefined);
            if (over.length) text += `. Overridden in ${over.join(' and ')}.`;
          }
          note.textContent = text;
          note.title = text;

          const mine = !!error && error.part === part.id && error.prop === usage.name;
          if (input) input.classList.toggle('is-invalid', mine);
          err.hidden = !mine;
          err.textContent = mine ? error.message : '';
        },
        paintSwatch() {
          if (!fill) return;
          const all = draftParts();
          const scope = host.getScope();
          const mode = host.scopeMode();
          const value = valueIn(all[SCOPE_KEY[scope]], part.id, usage.name)
            || (scope !== 'tokens' && valueIn(all.shared, part.id, usage.name))
            || resolved[mode][usage.token]
            || fallbackValue(usage.default, resolved[mode]);
          const colour = host.probeColour(value);
          fill.style.background = colour;
          const hex = host.toHex(colour);
          if (hex && document.activeElement !== picker) picker.value = hex;
        },
      };
      rows.push(api);
      return row;
    }

    function renderPart(part) {
      const block = el('div', 'part-block');
      const head = el('div', 'part-head');
      head.append(el('span', 'part-label', part.label || part.id), el('code', 'token-name', part.id));
      block.append(head);
      if (part.description) block.append(el('p', 'token-desc', part.description));
      const grid = el('div', 'token-grid');
      for (const usage of part.properties || []) grid.append(makeRow(part, usage));
      block.append(grid);
      return block;
    }

    // ---- Rendering ----
    function render() {
      if (!catalog) return;
      rows = [];
      counters = [];
      groupNodes = new Map();
      const box = $('parts-groups');
      const openBefore = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.group));
      box.replaceChildren();
      const groups = (catalog.groups || []).slice();
      const known = new Set(groups.map((g) => g.id));
      if (catalog.parts.some((p) => !known.has(p.group))) {
        groups.push({ id: '', label: 'Other', description: 'Parts with no group.' });
      }
      for (const g of groups) {
        const parts = catalog.parts.filter((p) => (g.id ? p.group === g.id : !known.has(p.group)));
        if (!parts.length) continue;
        const details = el('details', 'group');
        details.dataset.group = g.id;
        details.open = openBefore.has(g.id);
        const summary = el('summary');
        const count = el('span', 'group-count');
        summary.append(el('span', 'group-label', g.label || g.id), el('span', 'group-desc', g.description || ''), count);
        const body = el('div', 'group-body parts-list');
        for (const p of parts) body.append(renderPart(p));
        details.append(summary, body);
        box.append(details);
        groupNodes.set(g.id, details);
        counters.push({ parts: parts.map((p) => p.id), node: count });
      }
      renderStatic();
    }

    function renderStatic() {
      const aliases = $('parts-aliases');
      aliases.replaceChildren();
      for (const a of catalog.aliases || []) {
        const labels = (a.parts || []).map(partLabel);
        const list = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels.join('');
        const p = el('p', 'hint');
        p.append(el('code', null, a.token));
        p.append(` is an alias kept for older themes. It sets the ${a.property} of ${list}. An explicit part value wins over it. For a new theme, set the parts instead.`);
        const now = el('span', 'parts-alias-now');
        now.dataset.token = a.token;
        p.append(now);
        aliases.append(p);
      }
      const prot = (catalog.protected || []).map((p) => p.label || p.id);
      $('parts-protected').textContent = prot.length
        ? `No part reaches these, whatever the theme sets: ${prot.join(', ')}.`
        : '';
    }

    function refresh() {
      if (!catalog) return;
      for (const r of rows) r.refresh();
      const map = scopeParts();
      for (const c of counters) {
        const n = c.parts.reduce((sum, id) => sum + Object.keys(map[id] || {}).length, 0);
        c.node.textContent = n ? `${n} set` : '';
      }
      const mode = host.scopeMode();
      const explicit = host.explicitFor(mode);
      for (const span of document.querySelectorAll('#parts-aliases .parts-alias-now')) {
        const v = explicit[span.dataset.token];
        span.textContent = v ? ` In ${mode} mode this theme sets it to ${v}.` : '';
      }
      $('parts-reduced').hidden = document.documentElement.getAttribute('data-theme-effects') !== 'reduce';
      const mapped = !!error && rows.some((r) => r.part.id === error.part && r.usage.name === error.prop);
      const hold = $('parts-hold');
      const show = !!error && !mapped && (hasValues() || aliasSet());
      hold.hidden = !show;
      hold.textContent = show ? `The part preview waits until the theme resolves. Lucidos says: ${error.message}` : '';
    }

    function aliasSet() {
      const d = host.getDraft();
      return (catalog.aliases || []).some((a) => ['tokens', 'dark', 'light'].some((m) => d[m] && d[m][a.token]));
    }

    function paintSwatches() {
      if (!catalog) return;
      for (const r of rows) r.paintSwatch();
    }

    // ---- Refusals ----
    // The engine names the field first: `light.parts.chat-text.text-shadow: ...`,
    // or `in dark mode, the chat-text color is 2.1:1 ...` for a contrast refusal.
    function parseRefusal(message) {
      if (!message) return null;
      let m = /^(parts|dark\.parts|light\.parts)\.([a-z0-9-]+)\.([a-z0-9-]+): /.exec(message);
      if (m && partById.has(m[2])) return { message, map: m[1], part: m[2], prop: m[3] };
      m = /^in (?:dark|light) mode, the ([a-z0-9-]+) ([a-z0-9-]+) is /.exec(message);
      if (m && partById.has(m[1])) return { message, part: m[1], prop: m[2] };
      return { message };
    }

    function setError(message) {
      const before = error && error.message;
      error = message ? parseRefusal(message) : null;
      if (error && error.part && error.message !== before) {
        const part = partById.get(error.part);
        const details = part && (groupNodes.get(part.group) || groupNodes.get(''));
        if (details) details.open = true;
      }
      refresh();
    }

    // Show a save refusal beside its property. True when it named one.
    function showRefusal(message) {
      if (!catalog) return false;
      setError(message);
      return !!(error && error.part && rows.some((r) => r.part.id === error.part && r.usage.name === error.prop));
    }
    function clearError() { if (error) setError(null); }

    // ---- Resolve and preview ----
    function reset(theme) {
      seq++;
      error = null;
      const r = theme && theme.resolved;
      resolved = { dark: pickParts(r && r.dark), light: pickParts(r && r.light) };
    }

    async function resolveDraft(definition) {
      if (!catalog) return;
      const mine = ++seq;
      try {
        const res = await request(definition);
        if (mine !== seq) return;
        const r = (res && res.resolved) || {};
        resolved = { dark: pickParts(r.dark), light: pickParts(r.light) };
        setError(null);
      } catch (e) {
        if (mine !== seq) return;
        setError(host.reasonOf(e));
      }
      paintSwatches();
    }

    // A part default can fall back to its parent's part token. Follow that chain
    // through the given map, the way the stylesheet's var() does.
    function fallbackValue(value, map, depth = 0) {
      const m = /^var\((--part-[a-z0-9-]+)\s*,\s*(.+)\)$/.exec(String(value || '').trim());
      if (!m || depth > 4) return String(value || '');
      if (map[m[1]]) return map[m[1]];
      return fallbackValue(m[2], map, depth + 1);
    }

    // The engine checks each value. One it refuses is dropped, and the rest go again.
    async function checked(values) {
      const key = JSON.stringify(values);
      if (probeCache.has(key)) return probeCache.get(key);
      const pending = Object.assign({}, values);
      let out = {};
      for (let tries = Object.keys(values).length + 1; tries > 0 && Object.keys(pending).length; tries--) {
        const parts = {};
        for (const [token, v] of Object.entries(pending)) {
          const { part, usage } = byToken.get(token);
          if (!parts[part.id]) parts[part.id] = {};
          parts[part.id][usage.name] = v;
        }
        try {
          const res = await request({ name: PROBE_NAME, parts });
          out = pickParts(res && res.resolved && res.resolved.dark);
          break;
        } catch (e) {
          const ref = parseRefusal(host.reasonOf(e));
          const hit = ref && ref.part && [...byToken.entries()].find(([, x]) => x.part.id === ref.part && x.usage.name === ref.prop);
          if (!hit || !(hit[0] in pending)) break;
          delete pending[hit[0]];
        }
      }
      probeCache.set(key, out);
      return out;
    }

    // The part tokens the live preview writes for one mode: the draft's own, plus
    // an unset value for each part token the theme in use (or the user's own
    // overrides) paints and the draft leaves unset. Overrides only add, so
    // without these the theme in use would still show through.
    async function previewTokens(mode, activeMap, ownKeys) {
      if (!catalog) return {};
      const drafted = Object.assign({}, resolved[mode]);
      const unset = {};
      for (const token of new Set([...Object.keys(pickParts(activeMap)), ...ownKeys])) {
        if (token in drafted) continue;
        const hit = byToken.get(token);
        if (hit) unset[token] = fallbackValue(hit.usage.default, drafted);
      }
      if (!Object.keys(unset).length) return drafted;
      return Object.assign(await checked(unset), drafted);
    }

    return {
      load,
      available,
      render,
      refresh,
      paintSwatches,
      reset,
      resolveDraft,
      previewTokens,
      showRefusal,
      clearError,
      hasValues,
    };
  }

  window.ThemeStudioParts = { create, emptyParts, clone, PART_PREFIX };
})();
