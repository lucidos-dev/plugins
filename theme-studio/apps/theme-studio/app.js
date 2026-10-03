// Theme Studio: build a theme (a JSON file of design-token values) and preview it live.
//
// Reads the token catalog from GET /api/v1/themes/tokens and the themes from
// GET /api/v1/themes. Saves with lucidos.data.write('themes/<id>.json'), which the
// engine validates, and applies with the `theme` preference. The live preview
// writes the draft's resolved tokens into the `style_overrides` preference and
// restores the user's own map on save, cancel, or the next visit. The Parts
// section lives in parts.js: it resolves the draft with the engine and adds the
// part tokens it gets back to the same preview.
(() => {
  'use strict';

  const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const MAX_ID = 64;
  const MAX_VALUE = 120;
  const FORBIDDEN = ['url(', 'image-set(', 'expression(', ';', '{', '}', '<', '>', '@', '\\', '/*'];
  const MAX_OVERRIDES = 200;
  const PREVIEW_MARKER = '--theme-studio-preview';
  const SESSION_PATH = 'artifacts/theme-studio/preview-session.json';
  // Names from before the app was renamed. Read only, so a preview left
  // running under the old name is still put back.
  const LEGACY_PREVIEW_MARKER = '--look-studio-preview';
  const LEGACY_SESSION_PATH = 'artifacts/look-studio/preview-session.json';
  const HEAD_FOCUS_GROUPS = ['header', 'focus'];

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---- State ----
  let catalog = null;
  let themes = [];
  let builtInIds = new Set();
  let draft = emptyDraft();
  let snapshot = '';
  let originId = null;      // the workspace theme this draft saves over, if any
  let startId = null;       // the theme the draft started from
  let scope = 'dark';       // 'dark' | 'light' | 'tokens'
  let idTouched = false;
  let busy = false;
  let rows = [];
  let groupCounters = [];
  const openGroups = new Set();
  let paintedProps = [];
  let startSelect = null;
  let writeQueue = Promise.resolve();
  let activeThemeId = 'lucidos';
  let savedQuietId = null;   // a theme just saved without applying: no preview until edited
  let fontCatalog = null;    // GET /api/v1/fonts, or null on a Lucidos without the font catalog
  let deviceFont = 'theme';   // this device's font-family preference
  const fontSelects = {};    // slot -> lucidos.ui.Select
  const loadedFontSheets = new Set();

  const preview = {
    enabled: true,
    active: false,
    original: '',       // the user's own global style_overrides, restored on end
    originalMap: {},
    timer: null,
  };

  const PART_PREFIX = ThemeStudioParts.PART_PREFIX;
  const parts = ThemeStudioParts.create({
    el,
    getDraft: () => draft,
    getScope: () => scope,
    scopeMode: () => scopeMode(),
    explicitFor: (mode) => explicitFor(mode),
    reasonOf: (e) => reasonOf(e),
    toHex: (colour) => toHex(colour),
    probeColour: (value) => probeColour(value),
    onEdit: () => changed([]),
  });

  // family is not edited here, but a save must keep it.
  function emptyDraft() {
    return {
      id: '', name: '', description: '', author: '', credit: '', family: '',
      fonts: {}, tokens: {}, dark: {}, light: {}, parts: ThemeStudioParts.emptyParts(),
    };
  }

  // ---- Helpers ----
  function hostMode() {
    return document.documentElement.getAttribute('data-theme-mode') === 'light' ? 'light' : 'dark';
  }
  function scopeMode() { return scope === 'tokens' ? hostMode() : scope; }
  function scopeMap() { return draft[scope]; }
  function explicitFor(mode) { return Object.assign({}, draft.tokens, draft[mode] || {}); }
  function tokenDef(name) { return catalog.tokens.find((t) => t.name === name); }
  function modeLabel(mode) { return mode === 'dark' ? 'dark' : 'light'; }

  function validateValue(v) {
    if (!v) return null;
    if (v.length > MAX_VALUE) return `At most ${MAX_VALUE} characters (this is ${v.length}).`;
    for (const f of FORBIDDEN) if (v.includes(f)) return `A value cannot contain ${f}`;
    return null;
  }

  function derivationActive(t, mode) {
    if (!t.derive) return false;
    const explicit = explicitFor(mode);
    return !(t.name in explicit) && t.derive.seeds.some((s) => s in explicit);
  }

  // Every catalog token's value in one mode: explicit, else derived, else the default.
  function fullMap(mode) {
    const explicit = explicitFor(mode);
    const out = {};
    for (const t of catalog.tokens) {
      if (t.name in explicit) out[t.name] = explicit[t.name];
      else if (derivationActive(t, mode)) out[t.name] = t.derive.value;
      else out[t.name] = t.default[mode];
    }
    for (const [k, v] of Object.entries(explicit)) if (!(k in out)) out[k] = v;
    const mono = fontById(draft.fonts && draft.fonts.mono);
    if (mono && !(MONO_TOKEN in explicit)) out[MONO_TOKEN] = mono.stack;
    return out;
  }

  function slugify(s) {
    return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_ID).replace(/-+$/, '');
  }

  function uniqueId(base) {
    const taken = new Set(themes.map((l) => l.id));
    let id = slugify(base) || 'my-theme';
    if (!taken.has(id)) return id;
    for (let i = 2; ; i++) {
      const next = `${id}-${i}`;
      if (!taken.has(next)) return next;
    }
  }

  // ---- Fonts ----
  // A theme suggests fonts by catalog id: fonts.ui (only on devices that follow
  // the theme) and fonts.mono (fills --font-mono everywhere). Only a font the
  // catalog marks theme_nameable may be named. The engine marks every font so
  // now, but it keeps the field for apps that filter on it.
  const MONO_TOKEN = '--font-mono';
  function fontById(id) {
    if (!id || !fontCatalog) return null;
    return fontCatalog.fonts.find((f) => f.id === id) || null;
  }
  function fontsFor(slot) {
    if (!fontCatalog) return [];
    return fontCatalog.fonts.filter((f) => f.theme_nameable && (slot === 'ui' ? f.kind !== 'mono' : f.kind !== 'ui'));
  }
  // The frame needs the @font-face rules to show a vendored font in the specimen.
  function ensureFontSheet(font) {
    if (!font || font.source !== 'vendored' || loadedFontSheets.has(font.id)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = lucidos.apiUrl(`/fonts/${font.id}.css`);
    document.head.append(link);
    loadedFontSheets.add(font.id);
  }
  function monoTokenSet() {
    return ['tokens', 'dark', 'light'].some((m) => MONO_TOKEN in (draft[m] || {}));
  }

  function serialize() { return JSON.stringify(draft); }
  function isDirty() { return serialize() !== snapshot; }

  function reasonOf(e) {
    const raw = (e && (e.reason || e.message)) || String(e);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.error === 'string') return parsed.error;
    } catch { /* not JSON */ }
    return raw;
  }

  // Resolve any CSS colour string to #rrggbb for the native colour input.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  function toHex(color) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'transparent';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null;
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  function queueWrite(fn) {
    writeQueue = writeQueue.then(fn).catch((e) => console.warn('[theme-studio]', e));
    return writeQueue;
  }

  // ---- Banner and errors ----
  function showBanner(text, kind, action) {
    const b = $('banner');
    b.replaceChildren();
    b.className = 'banner' + (kind ? ` is-${kind}` : '');
    b.append(el('span', 'banner-text', text));
    if (action) {
      const btn = el('button', 'action-btn action-btn-secondary', action.label);
      btn.type = 'button';
      btn.addEventListener('click', action.run);
      b.append(btn);
    }
    const close = el('button', 'accent-link', 'Dismiss');
    close.type = 'button';
    close.addEventListener('click', () => { b.hidden = true; });
    b.append(close);
    b.hidden = false;
  }
  function showError(text) { const box = $('error-box'); box.textContent = text; box.hidden = false; box.scrollIntoView({ block: 'nearest' }); }
  function hideError() { $('error-box').hidden = true; }

  // ---- Live preview through style_overrides ----
  // Preview only when the draft would change what Lucidos shows: an edit, or a
  // starting theme other than the one in use. Otherwise put the user's map back.
  // Only an edit previews. Opening the app, or picking a starting theme, must not
  // repaint every device the user has open.
  function wantsPreview() { return isDirty(); }

  // Every edit is resolved by the engine, preview or not, so a refused part
  // value shows beside its property either way.
  function schedulePreview() {
    clearTimeout(preview.timer);
    if (!wantsPreview()) {
      parts.clearError();
      if (preview.enabled) endPreview();
      return;
    }
    preview.timer = setTimeout(async () => {
      await resolveParts();
      if (preview.enabled && wantsPreview()) pushPreview();
    }, 200);
  }

  function resolveParts() {
    if (!parts.available()) return Promise.resolve();
    return parts.resolveDraft(Object.assign(buildDefinition(), { name: draft.name.trim() || 'Untitled theme' }));
  }

  async function startSession() {
    preview.active = true;
    try {
      await lucidos.data.write(SESSION_PATH, JSON.stringify({ original: preview.original, startedAt: new Date().toISOString() }, null, 2));
    } catch (e) {
      console.warn('[theme-studio] could not record the preview session', e);
    }
  }

  function pushPreview() {
    if (!preview.enabled) return;
    const mode = hostMode();
    const draftMap = fullMap(mode);
    const active = themes.find((l) => l.id === activeThemeId);
    const activeMap = (active && active.resolved && active.resolved[mode]) || {};
    const ownPartKeys = Object.keys(preview.originalMap).filter((k) => k.startsWith(PART_PREFIX));
    return queueWrite(async () => {
      if (!preview.enabled) return;
      Object.assign(draftMap, await parts.previewTokens(mode, activeMap, ownPartKeys));
      const out = {};
      // Keep the user's own overrides for anything the draft does not paint.
      for (const [k, v] of Object.entries(preview.originalMap)) if (!(k in draftMap)) out[k] = v;
      for (const [k, v] of Object.entries(draftMap)) if (!validateValue(v)) out[k] = v;
      out[PREVIEW_MARKER] = '1';
      if (Object.keys(out).length > MAX_OVERRIDES) {
        for (const k of Object.keys(preview.originalMap)) {
          if (Object.keys(out).length <= MAX_OVERRIDES) break;
          if (!(k in draftMap)) delete out[k];
        }
      }
      if (!preview.active) await startSession();
      await lucidos.preferences.set('style_overrides', JSON.stringify(out));
    });
  }

  function endPreview() {
    clearTimeout(preview.timer);
    if (!preview.active) return writeQueue;
    return queueWrite(async () => {
      if (!preview.active) return;
      await lucidos.preferences.set('style_overrides', preview.original || '{}');
      preview.active = false;
      try { await lucidos.data.delete(SESSION_PATH); } catch { /* already gone */ }
    });
  }

  // A preview a previous visit never ended (the pane closed mid-edit) is put back.
  async function recoverLeftoverPreview(globalRaw) {
    let map;
    try { map = JSON.parse(globalRaw || '{}'); } catch { return globalRaw; }
    if (!map || typeof map !== 'object') return globalRaw;
    const legacy = !(PREVIEW_MARKER in map) && (LEGACY_PREVIEW_MARKER in map);
    if (!(PREVIEW_MARKER in map) && !legacy) return globalRaw;
    const sessionPath = legacy ? LEGACY_SESSION_PATH : SESSION_PATH;
    let original = null;
    try {
      const session = JSON.parse(await lucidos.data.read(sessionPath));
      if (session && typeof session.original === 'string') original = session.original;
    } catch { /* no session file */ }
    if (original === null) {
      const names = new Set(catalog.tokens.map((t) => t.name));
      const kept = {};
      for (const [k, v] of Object.entries(map)) if (!names.has(k) && k !== PREVIEW_MARKER && k !== LEGACY_PREVIEW_MARKER && !k.startsWith(PART_PREFIX)) kept[k] = v;
      original = JSON.stringify(kept);
    }
    await lucidos.preferences.set('style_overrides', original || '{}');
    try { await lucidos.data.delete(sessionPath); } catch { /* already gone */ }
    lucidos.ui.toast('Cleared a live preview left over from an earlier visit.', 'info');
    return original;
  }

  // ---- Token rows ----
  // One row edits one token (or, with `linked`, several at once) in the current scope.
  function makeRow(t, opts = {}) {
    const { big = false, label = t.label, description = t.description, linked = [] } = opts;
    const names = [t.name, ...linked];
    const isColor = t.kind === 'color';
    const row = el('div', big ? 'seed' : 'token-row');

    const input = el('input', 'value-input text-input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `${label} value`);

    let fill = null;
    let picker = null;
    let swatch = null;
    if (isColor) {
      swatch = el('label', 'swatch');
      fill = el('span', 'swatch-fill');
      picker = el('input');
      picker.type = 'color';
      picker.setAttribute('aria-label', `Pick ${label}`);
      swatch.append(fill, picker);
    }

    const reset = el('button', 'accent-link clear-btn', 'Reset');
    reset.type = 'button';
    reset.setAttribute('aria-label', `Reset ${label}`);
    const note = el('div', 'token-default');
    const err = el('p', 'token-error');
    err.hidden = true;
    const desc = el('p', 'token-desc', description);

    if (big) {
      const top = el('div', 'seed-top');
      const wrap = el('div', 'seed-swatch-wrap');
      if (swatch) wrap.append(swatch);
      const meta = el('div', 'seed-meta');
      meta.append(el('span', 'seed-label', label), el('code', 'token-name', t.name));
      top.append(wrap, meta);
      const control = el('div', 'token-control');
      control.append(input, reset);
      row.append(top, desc, control, note, err);
    } else {
      const head = el('div', 'token-head');
      head.append(el('span', 'token-label', label), el('code', 'token-name', names.join(' + ')));
      const control = el('div', 'token-control');
      if (swatch) control.append(swatch);
      control.append(input, reset);
      row.append(head, desc, control, note, err);
    }

    const write = (value) => {
      const map = scopeMap();
      for (const n of names) {
        if (value === '') delete map[n];
        else map[n] = value;
      }
      changed(names);
    };
    input.addEventListener('input', () => write(input.value.trim()));
    if (picker) picker.addEventListener('input', () => { input.value = picker.value; write(picker.value); });
    reset.addEventListener('click', () => { input.value = ''; write(''); });

    const api = {
      token: t.name,
      fill,
      picker,
      refresh() {
        const map = scopeMap();
        const mode = scopeMode();
        const value = map[t.name] ?? '';
        if (document.activeElement !== input) input.value = value;
        row.classList.toggle('is-set', value !== '');
        reset.hidden = value === '';

        const inherited = scope !== 'tokens' && !(t.name in map) && t.name in draft.tokens;
        const derived = !inherited && derivationActive(t, mode);
        if (inherited) input.placeholder = draft.tokens[t.name];
        else if (derived) input.placeholder = 'derived from the seeds';
        else input.placeholder = t.default[mode];

        let text;
        if (inherited) text = `From Both modes: ${draft.tokens[t.name]}`;
        else if (derived) text = `Derived from ${t.derive.seeds.join(', ')}`;
        else if (scope === 'tokens') {
          const d = t.default;
          text = d.dark === d.light ? `Default: ${d.dark}` : `Default: dark ${d.dark}, light ${d.light}`;
        } else text = `Default in ${modeLabel(mode)}: ${t.default[mode]}`;
        if (scope === 'tokens') {
          const over = ['dark', 'light'].filter((m) => t.name in draft[m]);
          if (over.length) text += `. Overridden in ${over.join(' and ')}.`;
        }
        note.textContent = text;
        note.title = text;

        const problem = validateValue(input.value.trim());
        input.classList.toggle('is-invalid', !!problem);
        err.hidden = !problem;
        err.textContent = problem || '';
      },
    };
    rows.push(api);
    return { node: row, api };
  }

  // ---- Rendering ----
  function renderDetails() {
    $('f-name').value = draft.name;
    $('f-id').value = draft.id;
    $('f-description').value = draft.description;
    $('f-author').value = draft.author;
    $('f-credit').value = draft.credit;
  }

  function renderScope() {
    for (const b of document.querySelectorAll('.segmented-btn[data-scope]')) {
      const on = b.dataset.scope === scope;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    const mode = hostMode();
    let hint;
    if (scope === 'tokens') {
      hint = 'Editing values for both modes. A dark or light value wins over these.';
    } else {
      hint = `Editing ${scope} mode. A value here wins over Both modes.`;
      if (preview.enabled && scope !== mode) {
        hint += ` Lucidos is in ${mode} mode now, so the live preview shows ${mode}. The specimen below shows ${scope}.`;
      }
    }
    $('scope-hint').textContent = hint;
  }

  function renderSeeds() {
    const grid = $('seed-grid');
    grid.replaceChildren();
    for (const name of catalog.seeds) {
      const t = tokenDef(name);
      if (t) grid.append(makeRow(t, { big: true }).node);
    }
  }

  function segmented(options, current, onPick, labelText) {
    const wrap = el('div', 'segmented-control');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', labelText);
    for (const [value, text] of options) {
      const b = el('button', 'segmented-btn' + (value === current ? ' active' : ''), text);
      b.type = 'button';
      b.addEventListener('click', () => onPick(value));
      wrap.append(b);
    }
    return wrap;
  }

  function renderGroup(g, container) {
    const tokens = catalog.tokens.filter((t) => t.group === g.id && !catalog.seeds.includes(t.name));
    if (!tokens.length) return;
    const details = el('details', 'group');
    details.open = openGroups.has(g.id);
    details.addEventListener('toggle', () => {
      if (details.open) openGroups.add(g.id); else openGroups.delete(g.id);
    });
    const summary = el('summary');
    const count = el('span', 'group-count');
    summary.append(el('span', 'group-label', g.label), el('span', 'group-desc', g.description), count);
    const body = el('div', 'group-body');
    const grid = el('div', 'token-grid');
    for (const t of tokens) grid.append(makeRow(t).node);
    body.append(grid);
    details.append(summary, body);
    container.append(details);
    groupCounters.push({ names: tokens.map((t) => t.name), node: count });
  }

  function renderHeadFocus() {
    const box = $('headfocus');
    box.replaceChildren();
    const mode = scopeMode();
    const eff = explicitFor(mode);
    const map = scopeMap();

    // Header bar: flat or gradient.
    const flat = eff['--header-gradient'] === 'var(--header-bar-top)';
    const bar = el('div', 'hf-block');
    bar.append(el('div', 'hf-title', 'Header bar'));
    bar.append(segmented([['gradient', 'Gradient'], ['flat', 'Flat']], flat ? 'flat' : 'gradient', (pick) => {
      if (pick === 'flat') {
        map['--header-gradient'] = 'var(--header-bar-top)';
        const colour = map['--header-bar-top'] || 'var(--bg-primary)';
        map['--header-bar-top'] = colour;
        map['--header-bar-bottom'] = colour;
      } else {
        delete map['--header-gradient'];
        if (map['--header-bar-top'] && map['--header-bar-top'] === map['--header-bar-bottom']) {
          delete map['--header-bar-top'];
          delete map['--header-bar-bottom'];
        }
      }
      rebuild();
    }, 'Header bar style'));
    const barGrid = el('div', 'token-grid');
    const top = tokenDef('--header-bar-top');
    const bottom = tokenDef('--header-bar-bottom');
    if (flat) {
      barGrid.append(makeRow(top, {
        label: 'Bar colour',
        description: 'One colour for the whole bar. var(--bg-primary) melts it into the page.',
        linked: ['--header-bar-bottom'],
      }).node);
    } else {
      barGrid.append(makeRow(top).node, makeRow(bottom).node);
    }
    barGrid.append(makeRow(tokenDef('--header-fg'), {
      label: 'Header text',
      description: 'Every glyph and label on the header. Pick a dark colour for a light bar; the muted text and control veils follow.',
    }).node);
    barGrid.append(makeRow(tokenDef('--header-divider'), {
      label: 'Divider',
      description: 'The line between pane headers. Leave it unset for one seamless bar.',
    }).node);
    bar.append(barGrid);
    box.append(bar);

    // Focus: wash or underline.
    const underline = eff['--focus-header-tint'] === 'transparent'
      && !!eff['--focus-header-underline'] && eff['--focus-header-underline'] !== 'transparent';
    const focus = el('div', 'hf-block');
    focus.append(el('div', 'hf-title', 'Focused pane'));
    focus.append(segmented([['wash', 'Wash'], ['underline', 'Underline']], underline ? 'underline' : 'wash', (pick) => {
      if (pick === 'underline') {
        map['--focus-header-tint'] = 'transparent';
        if (!map['--focus-header-underline'] || map['--focus-header-underline'] === 'transparent') {
          map['--focus-header-underline'] = 'var(--accent)';
        }
      } else {
        delete map['--focus-header-tint'];
        delete map['--focus-header-underline'];
        delete map['--focus-header-underline-width'];
      }
      rebuild();
    }, 'Focus style'));
    const focusGrid = el('div', 'token-grid');
    if (underline) {
      focusGrid.append(
        makeRow(tokenDef('--focus-header-underline'), { label: 'Underline colour' }).node,
        makeRow(tokenDef('--focus-header-underline-width'), { label: 'Underline width' }).node,
      );
    } else {
      focusGrid.append(makeRow(tokenDef('--focus-header-tint'), { label: 'Wash colour' }).node);
    }
    focus.append(focusGrid);
    box.append(focus);

    // Every header and focus token, for the fine detail.
    const all = el('div', 'hf-block');
    all.append(el('div', 'hf-title', 'All header and focus tokens'));
    for (const id of HEAD_FOCUS_GROUPS) {
      const g = catalog.groups.find((x) => x.id === id);
      if (g) renderGroup(g, all);
    }
    box.append(all);
  }

  function fontSelect(slot) {
    const options = [{ value: '', label: slot === 'ui' ? 'No suggestion (Fira Code)' : 'No suggestion (the default code font)' }]
      .concat(fontsFor(slot).map((f) => ({ value: f.id, label: f.label })));
    const current = (draft.fonts && draft.fonts[slot]) || '';
    if (!fontSelects[slot]) {
      fontSelects[slot] = lucidos.ui.Select.create({
        options,
        value: current,
        onChange: (value) => pickFont(slot, value),
      });
      $(`font-${slot}`).append(fontSelects[slot].element);
    } else {
      fontSelects[slot].setOptions(options);
      fontSelects[slot].setValue(current);
    }
  }

  function pickFont(slot, value) {
    draft.fonts = Object.assign({}, draft.fonts);
    if (value) draft.fonts[slot] = value; else delete draft.fonts[slot];
    if (slot === 'mono' && value && monoTokenSet()) {
      for (const m of ['tokens', 'dark', 'light']) delete draft[m][MONO_TOKEN];
      lucidos.ui.toast('Cleared the --font-mono override: a theme sets the code font one way, not both.', 'info');
      rows = [];
      groupCounters = [];
      renderGroups();
    }
    renderFonts();
    changed([MONO_TOKEN]);
  }

  function renderFonts() {
    const panel = $('fonts-panel');
    if (!fontCatalog) {
      $('fonts-body').hidden = true;
      $('fonts-hint').textContent = 'This Lucidos has no font catalog yet. Update Lucidos to suggest fonts in a theme.';
      panel.hidden = false;
      return;
    }
    $('fonts-body').hidden = false;
    fontSelect('ui');
    fontSelect('mono');
    const notes = ['Fonts apply in both modes. Only fonts Lucidos serves itself or the device already has are listed, so applying a theme never loads a font from Google.'];
    if (deviceFont && deviceFont !== fontCatalog.follow_theme) {
      const own = fontById(deviceFont);
      notes.push(`This device uses its own font (${own ? own.label : deviceFont}), which wins over a theme's UI font. Pick "Follow the theme" under Settings, Appearance, Typography to see it here.`);
    }
    notes.push('The live preview shows the code font across Lucidos. The UI font shows in the specimen below, and across Lucidos once the theme is saved and applied.');
    $('fonts-hint').textContent = notes.join(' ');
  }

  function renderGroups() {
    const box = $('groups');
    box.replaceChildren();
    for (const g of catalog.groups) {
      if (HEAD_FOCUS_GROUPS.includes(g.id)) continue;
      renderGroup(g, box);
    }
  }

  function refreshRows() {
    for (const r of rows) r.refresh();
    const map = scopeMap();
    for (const c of groupCounters) {
      const n = c.names.filter((name) => name in map).length;
      c.node.textContent = n ? `${n} set` : '';
    }
    parts.refresh();
  }

  function specProbe() {
    const spec = $('specimen');
    let probe = spec.querySelector('.spec-probe');
    if (!probe) { probe = el('span', 'spec-probe'); probe.setAttribute('aria-hidden', 'true'); spec.append(probe); }
    return probe;
  }

  // Any colour value, tokens included, as the specimen paints it.
  function probeColour(value) {
    const probe = specProbe();
    probe.style.color = '';
    probe.style.color = value || '';
    return getComputedStyle(probe).color;
  }

  // Paint the specimen from the draft's own resolved tokens, then read the swatches back from it.
  function paintSpecimen() {
    const spec = $('specimen');
    for (const p of paintedProps) spec.style.removeProperty(p);
    paintedProps = [];
    const ui = fontById(draft.fonts && draft.fonts.ui);
    const mono = fontById(draft.fonts && draft.fonts.mono);
    ensureFontSheet(ui);
    ensureFontSheet(mono);
    if (ui) {
      spec.style.setProperty('--font-ui', ui.stack);
      spec.style.setProperty('font-family', ui.stack);
      paintedProps.push('--font-ui', 'font-family');
    }
    for (const [k, v] of Object.entries(fullMap(scopeMode()))) {
      if (validateValue(v)) continue;
      spec.style.setProperty(k, v);
      paintedProps.push(k);
    }
    const probe = specProbe();
    const cache = new Map();
    for (const r of rows) {
      if (!r.fill) continue;
      if (!cache.has(r.token)) {
        probe.style.color = `var(${r.token})`;
        cache.set(r.token, getComputedStyle(probe).color);
      }
      const colour = cache.get(r.token);
      r.fill.style.background = colour;
      const hex = toHex(colour);
      if (hex && document.activeElement !== r.picker) r.picker.value = hex;
    }
    parts.paintSwatches();
  }

  function renderActions() {
    const dirty = isDirty();
    let note;
    if (dirty) note = 'Unsaved changes.';
    else if (originId) note = `Saved as themes/${originId}.json.`;
    else note = 'Not saved yet.';
    $('dirty-note').textContent = note;
    const exists = !!originId && themes.some((l) => l.id === originId && l.source === 'workspace');
    $('btn-delete').hidden = !exists;
    for (const id of ['btn-save-apply', 'btn-save', 'btn-cancel', 'btn-delete']) $(id).disabled = busy;
    $('f-id').classList.toggle('is-invalid', !!draft.id && !!idProblem(draft.id));
  }

  function rebuild() {
    rows = [];
    groupCounters = [];
    renderScope();
    renderSeeds();
    renderHeadFocus();
    renderFonts();
    renderGroups();
    refreshRows();
    paintSpecimen();
    renderActions();
    schedulePreview();
  }

  const MODE_TOKENS = new Set(['--header-gradient', '--header-bar-top', '--header-bar-bottom', '--focus-header-tint', '--focus-header-underline']);
  function changed(names) {
    hideError();
    // The header and focus switches read these; rebuild them unless the user is typing in that section.
    if (names && names.some((n) => MODE_TOKENS.has(n)) && !$('headfocus').contains(document.activeElement)) {
      const openBefore = new Set(openGroups);
      rows = [];
      groupCounters = [];
      renderSeeds();
      renderHeadFocus();
      renderGroups();
      openBefore.forEach((g) => openGroups.add(g));
    }
    refreshRows();
    paintSpecimen();
    renderActions();
    schedulePreview();
  }

  // ---- Loading a starting point ----
  function loadFrom(theme) {
    const mine = theme && theme.source === 'workspace';
    if (!theme) {
      draft = emptyDraft();
      draft.name = '';
      originId = null;
      startId = null;
      idTouched = false;
      $('start-hint').textContent = 'A blank theme. Set the three seeds first; everything else is optional.';
    } else {
      // A mode map holds its tokens plus an optional `parts`, which is not a token.
      const split = (map) => {
        const { parts: modeParts, ...tokens } = map || {};
        return { tokens, parts: ThemeStudioParts.clone(modeParts) };
      };
      const dark = split(theme.dark);
      const light = split(theme.light);
      draft = {
        id: mine ? theme.id : uniqueId(`${theme.id}-custom`),
        name: mine ? theme.name : `${theme.name} custom`,
        description: theme.description || '',
        author: mine ? (theme.author || '') : '',
        credit: theme.credit || '',
        family: theme.family || '',
        fonts: Object.assign({}, theme.fonts || {}),
        tokens: Object.assign({}, theme.tokens || {}),
        dark: dark.tokens,
        light: light.tokens,
        parts: { shared: ThemeStudioParts.clone(theme.parts), dark: dark.parts, light: light.parts },
      };
      originId = mine ? theme.id : null;
      startId = theme.id;
      idTouched = mine;
      $('start-hint').textContent = mine
        ? `Editing your theme. Save writes over themes/${theme.id}.json. Change the id to save a copy instead.`
        : `${theme.name} is built in and cannot change, so this is a copy with its own id.`;
    }
    snapshot = serialize();
    parts.reset(theme);
    if (startSelect) startSelect.setValue(startId || '');
    renderDetails();
    rebuild();
  }

  async function refreshThemes() {
    const res = await lucidos.request('/themes');
    themes = Array.isArray(res.themes) ? res.themes : [];
    builtInIds = new Set(themes.filter((l) => l.source === 'built-in').map((l) => l.id));
    const options = themes.map((l) => ({
      value: l.id,
      label: l.source === 'workspace' ? `${l.name} (yours)` : l.name,
    }));
    if (!startSelect) {
      startSelect = lucidos.ui.Select.create({
        options,
        value: startId || '',
        placeholder: 'Pick a theme…',
        onChange: async (value) => {
          if (value === startId) return;
          if (isDirty() && !(await lucidos.ui.confirm({ message: 'Discard your unsaved changes and start from another theme?', okLabel: 'Discard' }))) {
            startSelect.setValue(startId || '');
            return;
          }
          loadFrom(themes.find((l) => l.id === value) || null);
        },
      });
      $('start-select').append(startSelect.element);
    } else {
      startSelect.setOptions(options);
      startSelect.setValue(startId || '');
    }
  }

  // ---- Save, apply, delete, cancel ----
  function idProblem(id) {
    if (!id) return 'Give the theme an id.';
    if (id.length > MAX_ID || !ID_RE.test(id)) return 'The id must be lowercase letters and digits joined by single hyphens.';
    if (builtInIds.has(id)) return `'${id}' is a built-in theme, so pick another id.`;
    return null;
  }

  function buildDefinition() {
    const sorted = (m) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
    // A parts map, sorted, with empty parts dropped. Null when nothing is set.
    const sortedParts = (m) => {
      const out = {};
      for (const [id, props] of Object.entries(m || {}).sort(([a], [b]) => a.localeCompare(b))) {
        if (props && Object.keys(props).length) out[id] = sorted(props);
      }
      return Object.keys(out).length ? out : null;
    };
    const draftParts = draft.parts || {};
    const def = { name: draft.name.trim() };
    for (const k of ['description', 'author', 'credit']) if (draft[k].trim()) def[k] = draft[k].trim();
    if (draft.family) def.family = draft.family;
    const fonts = {};
    for (const slot of ['ui', 'mono']) if (draft.fonts && draft.fonts[slot]) fonts[slot] = draft.fonts[slot];
    if (Object.keys(fonts).length) def.fonts = fonts;
    if (Object.keys(draft.tokens).length) def.tokens = sorted(draft.tokens);
    const shared = sortedParts(draftParts.shared);
    if (shared) def.parts = shared;
    for (const m of ['dark', 'light']) {
      const modeParts = sortedParts(draftParts[m]);
      if (!Object.keys(draft[m]).length && !modeParts) continue;
      def[m] = Object.assign(modeParts ? { parts: modeParts } : {}, sorted(draft[m]));
    }
    return def;
  }

  function firstValueProblem() {
    if (draft.fonts && draft.fonts.mono && monoTokenSet()) return 'Set the code font with the Code font picker or a --font-mono override, not both.';
    for (const m of ['tokens', 'dark', 'light']) {
      for (const [k, v] of Object.entries(draft[m])) {
        const p = validateValue(v);
        if (p) return `${k} (${m === 'tokens' ? 'both modes' : m}): ${p}`;
      }
    }
    return null;
  }

  async function save(apply) {
    if (busy) return;
    hideError();
    draft.id = draft.id.trim();
    const problems = [];
    if (!draft.name.trim()) problems.push('Give the theme a name.');
    const idp = idProblem(draft.id);
    if (idp) problems.push(idp);
    const vp = firstValueProblem();
    if (vp) problems.push(vp);
    if (problems.length) { showError(problems.join(' ')); return; }

    const id = draft.id;
    const clash = themes.some((l) => l.source === 'workspace' && l.id === id) && id !== originId;
    if (clash && !(await lucidos.ui.confirm({ message: `You already have a theme with the id '${id}'. Replace it?`, okLabel: 'Replace', danger: true }))) return;

    busy = true;
    renderActions();
    try {
      try {
        await lucidos.data.write(`themes/${id}.json`, JSON.stringify(buildDefinition(), null, 2) + '\n');
      } catch (e) {
        const reason = reasonOf(e);
        parts.showRefusal(reason);
        showError(`Lucidos refused the theme: ${reason}`);
        return;
      }
      parts.clearError();
      originId = id;
      startId = id;
      savedQuietId = id;
      idTouched = true;
      snapshot = serialize();
      await refreshThemes();
      if (apply) {
        await lucidos.preferences.set('theme', id);
        activeThemeId = id;
        await endPreview();
        const merged = await lucidos.preferences.get();
        if (merged.theme && merged.theme !== id) {
          showBanner(
            `Saved, and set as the theme for devices without their own choice. This device has its own theme picked, so choose ${draft.name.trim()} under Settings, Appearance, Theme.`,
            'warn',
            { label: 'Open Appearance', run: () => lucidos.ui.navigate('settings', { settings_view: 'appearance' }) },
          );
        } else {
          lucidos.ui.toast(`Saved and applied ${draft.name.trim()}.`, 'success');
        }
      } else {
        await endPreview();
        lucidos.ui.toast(`Saved ${draft.name.trim()}.`, 'success');
      }
      $('start-hint').textContent = `Editing your theme. Save writes over themes/${id}.json. Change the id to save a copy instead.`;
    } catch (e) {
      showError(`Something went wrong: ${reasonOf(e)}`);
    } finally {
      busy = false;
      renderActions();
    }
  }

  async function removeTheme() {
    if (!originId || busy) return;
    const name = (themes.find((l) => l.id === originId) || {}).name || originId;
    const ok = await lucidos.ui.confirm({
      title: 'Delete theme',
      message: `Delete ${name}? Any device using it goes back to the default theme.`,
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    busy = true;
    renderActions();
    try {
      await lucidos.data.delete(`themes/${originId}.json`);
      await endPreview();
      lucidos.ui.toast(`Deleted ${name}.`, 'success');
      startId = null;
      await refreshThemes();
      loadFrom(null);
    } catch (e) {
      showError(`Could not delete the theme: ${reasonOf(e)}`);
    } finally {
      busy = false;
      renderActions();
    }
  }

  async function cancel() {
    await endPreview();
    const hadChanges = isDirty();
    draft = JSON.parse(snapshot);
    renderDetails();
    rows = [];
    rebuild();
    await endPreview();
    lucidos.ui.toast(hadChanges ? 'Changes discarded and preview cleared.' : 'Preview cleared.', 'info');
  }

  // ---- Wiring ----
  function wire() {
    $('f-name').addEventListener('input', (e) => {
      draft.name = e.target.value;
      if (!idTouched) { draft.id = slugify(draft.name); $('f-id').value = draft.id; }
      renderActions();
    });
    $('f-id').addEventListener('input', (e) => { draft.id = e.target.value.trim(); idTouched = true; renderActions(); });
    for (const k of ['description', 'author', 'credit']) {
      $(`f-${k}`).addEventListener('input', (e) => { draft[k] = e.target.value; renderActions(); });
    }
    // The scope bar and its copy in the Parts section.
    for (const b of document.querySelectorAll('.segmented-btn[data-scope]')) {
      b.addEventListener('click', () => { scope = b.dataset.scope; rebuild(); });
    }
    $('preview-toggle').addEventListener('change', (e) => {
      preview.enabled = e.target.checked;
      renderScope();
      if (preview.enabled) resolveParts().then(pushPreview); else endPreview();
    });
    $('start-scratch').addEventListener('click', async () => {
      if (isDirty() && !(await lucidos.ui.confirm({ message: 'Discard your unsaved changes and start from scratch?', okLabel: 'Discard' }))) return;
      loadFrom(null);
    });
    $('btn-save-apply').addEventListener('click', () => save(true));
    $('btn-save').addEventListener('click', () => save(false));
    $('btn-cancel').addEventListener('click', cancel);
    $('btn-delete').addEventListener('click', removeTheme);

    // The host flips light and dark, or theme effects: re-read defaults, the specimen and the preview.
    // The SDK stamps these attributes before the catalog loads. The first render reads them then.
    new MutationObserver(() => { if (!catalog) return; renderScope(); refreshRows(); paintSpecimen(); schedulePreview(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-mode', 'data-theme-effects'] });

    // Best effort: put the user's own overrides back if the pane closes mid-edit.
    // The next visit recovers anything this misses.
    window.addEventListener('pagehide', () => {
      if (preview.active) lucidos.preferences.set('style_overrides', preview.original || '{}').catch(() => {});
    });
  }

  async function init() {
    lucidos.ui.applyPreferences();
    lucidos.ui.watchPreferences();
    wire();
    try {
      catalog = await lucidos.request('/themes/tokens');
    } catch (e) {
      showBanner(`This Lucidos has no theme platform yet (${reasonOf(e)}). Update Lucidos to use Theme Studio.`, 'warn');
      return;
    }
    const [globalPrefs, merged] = await Promise.all([
      lucidos.preferences.get(null),
      lucidos.preferences.get(),
    ]);
    preview.original = await recoverLeftoverPreview(globalPrefs.style_overrides || '');
    try {
      const parsed = JSON.parse(preview.original || '{}');
      preview.originalMap = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { preview.originalMap = {}; }
    if (merged.style_overrides && merged.style_overrides !== globalPrefs.style_overrides) {
      showBanner('This device has its own style overrides, and they win over the live preview here. Other devices still show it.', 'warn');
    }

    deviceFont = merged['font-family'] || 'theme';
    try {
      fontCatalog = await lucidos.request('/fonts');
      if (!fontCatalog || !Array.isArray(fontCatalog.fonts)) fontCatalog = null;
    } catch (e) {
      console.warn('[theme-studio] no font catalog', e);
      fontCatalog = null;
    }

    // An engine without theme parts hides the section and keeps the rest.
    const hasParts = await parts.load();
    $('parts-panel').hidden = !hasParts;
    $('parts-missing').hidden = hasParts;
    if (hasParts) parts.render();

    await refreshThemes();
    const wanted = decodeURIComponent((location.hash || '').slice(1));
    const active = merged.theme || 'lucidos';
    activeThemeId = active;
    const first = themes.find((l) => l.id === wanted) || themes.find((l) => l.id === active) || themes[0] || null;
    scope = hostMode();
    loadFrom(first);
  }

  init();
})();
