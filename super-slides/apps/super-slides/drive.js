/* ══════════════════════════════════════════════════════
   Super Slides — Google Drive integration
   ══════════════════════════════════════════════════════
   Save / Open / Share .slides decks via Google Drive.

   Auth: uses lucidos.oauth.getAccessToken('google') — the SDK
   method purpose-built for handing a short-lived bearer token to
   in-browser code. The token never persists in the iframe; we
   re-request it for every Drive call. The Drive REST API is
   CORS-enabled and accepts the token as an Authorization header,
   so no apis.json proxy entry or stored credential is needed —
   the app just rides whatever Google account this workspace has
   connected (via the OAuth account settings / connect_oauth_account).

   Scope note: a workspace connected with only `drive.file` can
   save, re-open, and share files THIS app created — which covers
   "save my decks, send a colleague a link". Two-way collaboration
   where you also OPEN a colleague's deck needs either broader Drive
   scope or a shared folder both sides save into (see the plugin's
   setup instructions). Open-from-Drive lists this app's own files;
   "Open by link" lets you pull any deck you have access to by ID/URL.
   ══════════════════════════════════════════════════════ */

SS.drive = (function () {
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const MAP_KEY = 'ss-drive-map'; // { [presId]: driveFileId }

  /* ── local id ↔ Drive file id map ── */
  function loadMap() {
    try { return JSON.parse(localStorage.getItem(MAP_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function rememberFile(presId, fileId) {
    const m = loadMap();
    m[presId] = fileId;
    localStorage.setItem(MAP_KEY, JSON.stringify(m));
  }
  function knownFileId(presId) { return loadMap()[presId] || null; }

  /* ── token ── */
  async function token() {
    if (!window.lucidos || !lucidos.oauth) {
      throw new Error('Lucidos SDK not available');
    }
    try {
      const t = await lucidos.oauth.getAccessToken('google');
      return t.accessToken;
    } catch (err) {
      const code = err && err.httpCode;
      if (code === 404) {
        throw new Error(
          'No Google account is connected to this workspace. ' +
          'Connect one in Settings → Accounts (or ask Lucidos to "connect my Google account"), then try again.'
        );
      }
      throw new Error('Could not get a Google access token: ' + (err && (err.message || err)));
    }
  }

  async function driveFetch(url, init) {
    const tok = await token();
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: 'Bearer ' + tok, ...(init && init.headers) },
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.error && j.error.message ? j.error.message : ''; }
      catch (e) { /* non-JSON body */ }
      const e = new Error(`Drive API ${res.status}${detail ? ': ' + detail : ''}`);
      e.status = res.status;
      throw e;
    }
    return res;
  }

  /* ── core operations ── */

  // Upload (create or update) a deck. `pres` is a registry entry; we save
  // its original .slides JSON (rawData), pretty-printed for diff-friendliness.
  // Upload (create or update) a deck's .slides JSON.
  //   opts.fileId    — explicit target file. If the key is PRESENT (even null),
  //                    it overrides the remembered map: pass `null` to force a
  //                    fresh CREATE (this is how "Save a copy" makes a new file).
  //   opts.folderId  — parent folder for a CREATE (ignored when updating in place).
  // After a successful save the deck→file map is updated so subsequent saves
  // land on the same file.
  async function save(pres, opts) {
    opts = opts || {};
    if (!pres || !pres.rawData) throw new Error('No presentation data to save');
    const presId = pres.id || pres.rawData.id || 'untitled';
    const content = JSON.stringify(pres.rawData, null, 2);
    const targetId = ('fileId' in opts) ? opts.fileId : knownFileId(presId);

    const metadata = {
      name: `${presId}.slides`,
      mimeType: 'application/json',
      appProperties: { superSlides: '1', presId: presId },
    };
    if (!targetId && opts.folderId) metadata.parents = [opts.folderId];

    const boundary = 'ssdrive' + Math.random().toString(36).slice(2);
    const metaPart = targetId ? { appProperties: metadata.appProperties } : metadata;
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(metaPart) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      content +
      `\r\n--${boundary}--`;

    const base = targetId ? `${UPLOAD}/files/${targetId}` : `${UPLOAD}/files`;
    const url = `${base}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,parents`;

    const res = await driveFetch(url, {
      method: targetId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const file = await res.json();
    rememberFile(presId, file.id);
    return file; // { id, name, webViewLink, parents }
  }

  // The folder ids a file currently lives in.
  async function getParents(fileId) {
    const res = await driveFetch(`${DRIVE}/files/${fileId}?fields=parents&supportsAllDrives=true`);
    const j = await res.json();
    return j.parents || [];
  }

  // Relocate a file to a new folder (Drive add/remove parents).
  async function moveFile(fileId, newParentId) {
    const prev = (await getParents(fileId)).join(',');
    const url = `${DRIVE}/files/${fileId}?addParents=${encodeURIComponent(newParentId)}` +
      (prev ? `&removeParents=${encodeURIComponent(prev)}` : '') +
      `&supportsAllDrives=true&fields=id,parents`;
    await driveFetch(url, { method: 'PATCH' });
  }

  // Create a subfolder inside parentId (a real folder id, a shared-drive id, or
  // 'root' for My Drive). Returns the new folder { id, name, driveId, parents }.
  async function createFolder(parentId, name) {
    const metadata = {
      name: name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    };
    const url = `${DRIVE}/files?supportsAllDrives=true&fields=id,name,driveId,parents`;
    const res = await driveFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    return res.json();
  }

  // List .slides decks this app created in Drive.
  async function list() {
    const q = encodeURIComponent(
      "appProperties has { key='superSlides' and value='1' } and trashed = false"
    );
    const fields = encodeURIComponent('files(id,name,modifiedTime,webViewLink,appProperties)');
    const res = await driveFetch(
      `${DRIVE}/files?q=${q}&fields=${fields}&orderBy=modifiedTime desc&pageSize=100`
    );
    const j = await res.json();
    return j.files || [];
  }

  /* ── folder browsing (full drive scope) ── */

  // List subfolders of a parent. parentId can be a real folder id, or one of
  // the virtual roots: 'root' (My Drive) / 'sharedWithMe'. Shared-drive roots
  // are listed via listSharedDrives().
  async function listFolders(parentId) {
    let q;
    if (parentId === 'sharedWithMe') {
      q = "mimeType='application/vnd.google-apps.folder' and sharedWithMe and trashed=false";
    } else {
      q = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    }
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,driveId)',
      orderBy: 'name',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      corpora: parentId === 'sharedWithMe' ? 'user' : 'allDrives',
    });
    const res = await driveFetch(`${DRIVE}/files?${params.toString()}`);
    return (await res.json()).files || [];
  }

  // List the user's shared drives (Team Drives).
  async function listSharedDrives() {
    const res = await driveFetch(`${DRIVE}/drives?pageSize=100&fields=drives(id,name)`);
    return (await res.json()).drives || [];
  }

  // List .slides decks inside a specific folder (any app — full scope).
  async function listInFolder(folderId) {
    const q = `'${folderId}' in parents and trashed=false and ` +
      "(name contains '.slides' or mimeType='application/json')";
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,modifiedTime,webViewLink,appProperties)',
      orderBy: 'modifiedTime desc',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      corpora: 'allDrives',
    });
    const res = await driveFetch(`${DRIVE}/files?${params.toString()}`);
    return (await res.json()).files || [];
  }

  /* ── folder ancestry (for an honest breadcrumb) ──
     Given a folder id, walk the Drive parents chain up to its top-level root
     (My Drive or a shared drive) and return the path as
     [{id,name}, …] outermost-first, INCLUDING the folder itself. Used to seed
     the browser's breadcrumb so a deep pinned/last folder shows its real path
     (e.g. "Jobs - P&T › 04 Area - Job Seekers › 03 User Acquisition") instead
     of looking like it sits directly under Drive. */
  let _rootId = null;
  async function myDriveRootId() {
    if (_rootId) return _rootId;
    try {
      const r = await driveFetch(`${DRIVE}/files/root?fields=id`);
      _rootId = (await r.json()).id || null;
    } catch (e) { _rootId = null; }
    return _rootId;
  }
  async function folderMeta(fileId) {
    const res = await driveFetch(
      `${DRIVE}/files/${fileId}?fields=id,name,parents,driveId&supportsAllDrives=true`
    );
    return res.json();
  }
  async function sharedDriveName(driveId) {
    try {
      const res = await driveFetch(`${DRIVE}/drives/${driveId}?fields=id,name`);
      return (await res.json()).name || 'Shared drive';
    } catch (e) { return 'Shared drive'; }
  }
  async function ancestry(folderId) {
    const rootId = await myDriveRootId();
    const chain = [];
    let cur = folderId;
    let driveId = null;
    const seen = new Set();
    for (let i = 0; i < 25 && cur && !seen.has(cur); i++) {
      seen.add(cur);
      let md;
      try { md = await folderMeta(cur); } catch (e) { break; }
      chain.unshift({ id: md.id, name: md.name });
      if (md.driveId) driveId = md.driveId;
      const parent = md.parents && md.parents[0];
      if (!parent) break;                       // top of My Drive
      if (rootId && parent === rootId) break;    // parent is My Drive root
      if (driveId && parent === driveId) break;  // parent is shared-drive root
      cur = parent;
    }
    // Prepend the container root so the breadcrumb is navigable.
    if (driveId) chain.unshift({ id: driveId, name: await sharedDriveName(driveId) });
    else chain.unshift({ id: 'root', name: 'My Drive' });
    return chain;
  }

  /* ── last-used folder memory ── */
  const LAST_FOLDER_KEY = 'ss-drive-last-folder'; // { id, name }
  function rememberFolder(id, name, path) {
    try {
      const entry = { id, name };
      if (Array.isArray(path) && path.length) entry.path = path;
      localStorage.setItem(LAST_FOLDER_KEY, JSON.stringify(entry));
    } catch (e) {}
  }
  function lastFolder() {
    try { return JSON.parse(localStorage.getItem(LAST_FOLDER_KEY)) || null; } catch (e) { return null; }
  }

  /* ── pinned default folder (workspace config) ──
     Stored in artifacts/super-slides/drive-config.json so it persists across
     devices/sessions (unlike the per-browser last-used folder). When set, the
     folder browser opens here by default. */
  const PINNED_PATH = 'artifacts/super-slides/drive-config.json';
  let _pinned;        // cached value: { id, name } | null
  let _pinnedLoaded = false;

  async function loadPinned() {
    if (_pinnedLoaded) return _pinned;
    try {
      const raw = await lucidos.data.read(PINNED_PATH);
      const cfg = JSON.parse(raw);
      _pinned = (cfg && cfg.pinnedFolder && cfg.pinnedFolder.id) ? cfg.pinnedFolder : null;
    } catch (e) { _pinned = null; }
    _pinnedLoaded = true;
    return _pinned;
  }
  function pinnedFolder() { return _pinned || null; }
  async function setPinned(id, name, path) {
    if (id) {
      _pinned = { id, name: name || id };
      if (Array.isArray(path) && path.length) _pinned.path = path;
    } else {
      _pinned = null;
    }
    _pinnedLoaded = true;
    try { await lucidos.data.write(PINNED_PATH, JSON.stringify({ pinnedFolder: _pinned }, null, 2)); }
    catch (e) { /* best-effort */ }
    return _pinned;
  }

  // Download a file's JSON content by Drive file id.
  async function download(fileId) {
    const res = await driveFetch(`${DRIVE}/files/${fileId}?alt=media`);
    return res.text();
  }

  // Get a file's metadata (used to derive a name when opening by link).
  async function meta(fileId) {
    const res = await driveFetch(
      `${DRIVE}/files/${fileId}?fields=id,name,webViewLink,appProperties`
    );
    return res.json();
  }

  // Make a file shareable. mode: 'link' (anyone with link, reader) or
  // 'user' (share with a specific email as writer). Returns webViewLink.
  async function share(fileId, mode, email) {
    const permission = mode === 'user'
      ? { role: 'writer', type: 'user', emailAddress: email }
      : { role: 'reader', type: 'anyone' };
    await driveFetch(`${DRIVE}/files/${fileId}/permissions?sendNotificationEmail=${mode === 'user'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(permission),
    });
    const m = await meta(fileId);
    return m.webViewLink;
  }

  /* ── helpers ── */

  // Pull a Drive file id out of a share URL or accept a bare id.
  function parseFileId(input) {
    if (!input) return null;
    const s = input.trim();
    let m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);          // .../file/d/<id>/...
    if (m) return m[1];
    m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);            // ...?id=<id>
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;      // bare id
    return null;
  }

  // Import downloaded deck JSON into the workspace, register + show it.
  async function importDeck(rawJson, fallbackName) {
    let data;
    try { data = JSON.parse(rawJson); }
    catch (e) { throw new Error('That Drive file is not a valid .slides JSON document.'); }
    const id = data.id || (fallbackName || 'imported').replace(/\.slides$/, '');
    data.id = id;
    const path = `artifacts/presentations/${id}.slides`;
    await lucidos.data.write(path, JSON.stringify(data, null, 2));
    // If already registered, drop the stale copy so we re-load fresh.
    const reg = window._superSlidesRegistry || [];
    const existingIdx = reg.findIndex(p => p.id === id);
    if (existingIdx >= 0) reg.splice(existingIdx, 1);
    const pres = await SS.loadPresentation(path);
    if (SS._rebuildMenuAndShow) SS._rebuildMenuAndShow(pres.id);
    return pres;
  }

  function toast(msg, type) {
    if (window.lucidos && lucidos.ui && lucidos.ui.toast) lucidos.ui.toast(msg, type || 'info');
  }

  return {
    save, list, download, meta, share, parseFileId, importDeck,
    knownFileId, token, toast,
    getParents, moveFile, createFolder, listFolders, listSharedDrives, listInFolder, ancestry,
    rememberFolder, lastFolder, loadPinned, pinnedFolder, setPinned,
  };
})();

/* ══════════════════════════════════════════════════════
   Drive UI — modals (matches the speaker-remote modal style)
   ══════════════════════════════════════════════════════ */

SS.driveUI = (function () {
  // Keep the modal inside the region NOT covered by the on-screen keyboard.
  // On iOS Safari a position:fixed element is sized to the LAYOUT viewport, so
  // a centered modal stays put while the keyboard overlays the bottom — hiding
  // any input near the foot of the card (e.g. the inline "new folder" field).
  // The visualViewport API reports the actually-visible area; we pin the modal
  // container to it so its contents reflow above the keyboard.
  let _vvSync = null;
  function unbindViewport() {
    const vv = window.visualViewport;
    if (_vvSync && vv) {
      vv.removeEventListener('resize', _vvSync);
      vv.removeEventListener('scroll', _vvSync);
    }
    _vvSync = null;
  }
  function bindViewport(m) {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      m.style.top = vv.offsetTop + 'px';
      m.style.left = vv.offsetLeft + 'px';
      m.style.width = vv.width + 'px';
      m.style.height = vv.height + 'px';
      m.style.right = 'auto';
      m.style.bottom = 'auto';
    };
    _vvSync = sync;
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  }

  function closeModal() {
    const ex = document.getElementById('ssDriveModal');
    if (ex) ex.remove();
    unbindViewport();
  }

  function modal(innerHtml) {
    closeModal();
    const m = document.createElement('div');
    m.id = 'ssDriveModal';
    m.innerHTML =
      `<div class="remote-modal-backdrop"></div>
       <div class="remote-modal-card ss-drive-card">${innerHtml}</div>`;
    document.body.appendChild(m);
    m.querySelector('.remote-modal-backdrop').addEventListener('click', closeModal);
    bindViewport(m);
    return m;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ── A blocking spinner modal shown while a Drive upload is in flight. ── */
  function busyCard(message) {
    return modal(
      `<div class="ss-drive-busy">
         <div class="ss-loading-spinner"></div>
         <div class="ss-drive-busy-msg">${escapeHtml(message)}</div>
       </div>`
    );
  }

  /* ══════════════════════════════════════════════════
     Folder browser — navigate My Drive / Shared with me /
     shared drives. Used by both Save (pick a destination
     folder) and Open (pick a .slides file in a folder).
     ══════════════════════════════════════════════════ */

  const ROOTS = [
    { id: 'root',         name: 'My Drive',       icon: '📁' },
    { id: 'sharedWithMe', name: 'Shared with me', icon: '👥' },
    { id: '__drives__',   name: 'Shared drives',  icon: '🗂' },
  ];

  // stack entries: { id, name }. The first entry is a virtual root.
  function folderBrowser(mode) {
    // Open at the pinned default folder when set; else the last-used folder;
    // else the roots list. Seed with a single-entry stack for an immediate
    // render, then asynchronously expand to the folder's true ancestry so the
    // breadcrumb shows the real path (e.g. "Jobs - P&T › 04 Area … › 03 UA")
    // instead of making a deep folder look like it sits directly under Drive.
    const pinned = SS.drive.pinnedFolder();
    const fromPinned = !!pinned;
    const last = pinned || SS.drive.lastFolder();
    // When this folder was pinned/saved we stored its FULL path, so we already
    // know the breadcrumb — seed the stack with it and render once (complete
    // crumbs + folder list together, no async ancestry walk, no second render).
    // Legacy entries that only saved {id,name} fall back to a single-entry stack
    // whose ancestry is derived lazily below and then persisted for next time.
    const knownPath = last && Array.isArray(last.path) && last.path.length ? last.path : null;
    let stack = knownPath
      ? knownPath.map(s => ({ id: s.id, name: s.name }))
      : (last ? [{ id: last.id, name: last.name }] : [{ id: '__roots__', name: 'Drive' }]);

    const m = modal(
      `<h3>${mode === 'save' ? 'Save to Google Drive' : 'Open from Google Drive'}</h3>
       <div class="ss-drive-crumbs" id="ssCrumbs"></div>
       <div class="ss-drive-browser" id="ssBrowser"><div class="ss-drive-loading">Loading…</div></div>
       <div class="ss-drive-actionsbar" id="ssActionsBar"></div>
       <div class="remote-modal-actions" style="margin-top:16px">
         <button class="remote-modal-btn" data-action="close">Cancel</button>
       </div>`
    );
    m.querySelector('[data-action="close"]').addEventListener('click', closeModal);

    const browserEl = m.querySelector('#ssBrowser');
    const crumbsEl = m.querySelector('#ssCrumbs');
    const actionsEl = m.querySelector('#ssActionsBar');

    function renderCrumbs() {
      const parts = [`<span class="ss-crumb" data-i="-1">Drive</span>`];
      stack.forEach((s, i) => {
        if (s.id === '__roots__') return;
        parts.push('<span class="ss-crumb-sep">›</span>');
        parts.push(`<span class="ss-crumb" data-i="${i}">${escapeHtml(s.name)}</span>`);
      });
      crumbsEl.innerHTML = parts.join('');
      crumbsEl.querySelectorAll('.ss-crumb').forEach(el => {
        el.addEventListener('click', () => {
          const i = parseInt(el.dataset.i, 10);
          stack = i < 0 ? [{ id: '__roots__', name: 'Drive' }] : stack.slice(0, i + 1);
          render();
        });
      });
    }

    function here() { return stack[stack.length - 1]; }
    // The full navigable path to the current folder, for persisting as a known
    // breadcrumb (drops the virtual roots entry). Reused on next open so we
    // skip the ancestry walk entirely.
    function pathHere() {
      return stack.filter(s => s.id !== '__roots__').map(s => ({ id: s.id, name: s.name }));
    }

    function renderActions() {
      const card = actionsEl.closest('.ss-drive-card');
      if (card) card.classList.remove('ss-drive-naming');
      const loc = here();
      const inRealFolder = loc.id !== '__roots__' &&
        loc.id !== '__drives__' && loc.id !== 'sharedWithMe';
      const canSaveHere = mode === 'save' && inRealFolder;

      const pinned = SS.drive.pinnedFolder();
      const isPinned = pinned && pinned.id === loc.id;
      const pinBtn = inRealFolder
        ? `<button class="remote-modal-btn ss-drive-pin" id="ssPinHere" title="${isPinned
              ? 'This is your default folder — click to unpin'
              : 'Open the browser here by default'}">${isPinned ? 'Default ✓' : 'Pin as default'}</button>`
        : '';

      const newFolderBtn = inRealFolder
        ? `<button class="remote-modal-btn ss-drive-newfolder" id="ssNewFolder" title="Create a folder here">
             <span class="remote-modal-btn-icon">＋</span> New folder
           </button>`
        : '';

      const saveBtn = canSaveHere
        ? `<button class="remote-modal-btn ss-drive-savehere" id="ssSaveHere">
             <span class="remote-modal-btn-icon">⬆</span> Save here: <strong>${escapeHtml(loc.name)}</strong>
           </button>`
        : (mode === 'save'
            ? `<div class="ss-drive-hint-inline">Open a folder to save into it.</div>`
            : '');

      const folderRow = (pinBtn || newFolderBtn)
        ? `<div class="ss-drive-folderactions">${pinBtn}${newFolderBtn}</div>`
        : '';

      actionsEl.innerHTML = saveBtn + folderRow;

      if (canSaveHere) {
        actionsEl.querySelector('#ssSaveHere').addEventListener('click', () => doSave(loc, pathHere()));
      }
      if (inRealFolder) {
        actionsEl.querySelector('#ssPinHere').addEventListener('click', async () => {
          if (isPinned) {
            await SS.drive.setPinned(null);
            SS.drive.toast('Default folder cleared', 'info');
          } else {
            await SS.drive.setPinned(loc.id, loc.name, pathHere());
            SS.drive.toast(`“${loc.name}” pinned as default`, 'success');
          }
          renderActions();
        });
        actionsEl.querySelector('#ssNewFolder').addEventListener('click', () => newFolderPrompt(loc));
      }
    }

    // Inline "new folder" form rendered into the actions bar. Creating a folder
    // pushes it onto the stack and navigates in; cancel restores the actions.
    function newFolderPrompt(parent) {
      // The app lives in an iframe, where the on-screen keyboard does NOT shrink
      // visualViewport — so we can't reflow around it. Instead, collapse the card
      // (the tall folder list is hidden via .ss-drive-naming) and anchor it to the
      // top of the screen, so the input sits high above the keyboard. No scroll
      // tricks needed → no jank.
      const card = actionsEl.closest('.ss-drive-card');
      if (card) card.classList.add('ss-drive-naming');
      actionsEl.innerHTML =
        `<div class="ss-drive-newfolderform">
           <div class="ss-drive-naming-label">New folder in “${escapeHtml(parent.name)}”</div>
           <div class="ss-drive-naming-row">
             <input class="ss-drive-input" id="ssNewFolderName" placeholder="Folder name" autocomplete="off" autocapitalize="words" />
             <button class="remote-modal-btn ss-drive-go" id="ssNewFolderCreate">Create</button>
             <button class="remote-modal-btn" id="ssNewFolderCancel">Cancel</button>
           </div>
         </div>`;
      const input = actionsEl.querySelector('#ssNewFolderName');
      // focus() runs synchronously inside this click handler (a user gesture),
      // so iOS reliably opens the keyboard.
      input.focus();
      actionsEl.querySelector('#ssNewFolderCancel').addEventListener('click', renderActions);
      const create = async () => {
        const name = (input.value || '').trim();
        if (!name) { SS.drive.toast('Enter a folder name', 'warning'); return; }
        const btn = actionsEl.querySelector('#ssNewFolderCreate');
        btn.disabled = true; btn.textContent = 'Creating…';
        try {
          const folder = await SS.drive.createFolder(parent.id, name);
          SS.drive.toast(`Created “${folder.name}”`, 'success');
          stack.push({ id: folder.id, name: folder.name });
          render(); // navigate into the new (empty) folder
        } catch (err) {
          btn.disabled = false; btn.textContent = 'Create';
          SS.drive.toast(err.message, 'error');
        }
      };
      actionsEl.querySelector('#ssNewFolderCreate').addEventListener('click', create);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    }

    async function render() {
      renderCrumbs();
      renderActions();
      browserEl.innerHTML = '<div class="ss-drive-loading">Loading…</div>';
      const loc = here();
      try {
        let rows = '';
        if (loc.id === '__roots__') {
          rows = ROOTS.map(r =>
            `<div class="ss-drive-row ss-drive-folder" data-id="${r.id}" data-name="${escapeHtml(r.name)}">
               <span class="ss-drive-row-icon">${r.icon}</span>
               <span class="ss-drive-row-name">${escapeHtml(r.name)}</span>
               <span class="ss-drive-row-chev">›</span>
             </div>`).join('');
        } else if (loc.id === '__drives__') {
          const drives = await SS.drive.listSharedDrives();
          rows = drives.length
            ? drives.map(d =>
                `<div class="ss-drive-row ss-drive-folder" data-id="${d.id}" data-name="${escapeHtml(d.name)}">
                   <span class="ss-drive-row-icon">🗂</span>
                   <span class="ss-drive-row-name">${escapeHtml(d.name)}</span>
                   <span class="ss-drive-row-chev">›</span>
                 </div>`).join('')
            : '<div class="ss-drive-empty">No shared drives.</div>';
        } else {
          const folders = await SS.drive.listFolders(loc.id);
          rows += folders.map(f =>
            `<div class="ss-drive-row ss-drive-folder" data-id="${f.id}" data-name="${escapeHtml(f.name)}">
               <span class="ss-drive-row-icon">📁</span>
               <span class="ss-drive-row-name">${escapeHtml(f.name)}</span>
               <span class="ss-drive-row-chev">›</span>
             </div>`).join('');
          if (mode === 'open') {
            const files = await SS.drive.listInFolder(loc.id);
            rows += files.map(f =>
              `<div class="ss-drive-row ss-drive-file" data-fid="${f.id}" data-name="${escapeHtml(f.name)}">
                 <span class="ss-drive-row-icon">📄</span>
                 <span class="ss-drive-row-name">${escapeHtml(f.name.replace(/\.slides$/, ''))}</span>
                 <span class="ss-drive-row-time">${timeAgo(f.modifiedTime)}</span>
               </div>`).join('');
          }
          if (!rows) {
            rows = `<div class="ss-drive-empty">${mode === 'open'
              ? 'No folders or decks here.' : 'No subfolders here.'}</div>`;
          }
        }
        browserEl.innerHTML = rows;
        browserEl.querySelectorAll('.ss-drive-folder').forEach(el => {
          el.addEventListener('click', () => {
            stack.push({ id: el.dataset.id, name: el.dataset.name });
            render();
          });
        });
        browserEl.querySelectorAll('.ss-drive-file').forEach(el => {
          el.addEventListener('click', () => pickFile(el.dataset.fid, el.dataset.name));
        });
      } catch (err) {
        browserEl.innerHTML = `<div class="ss-drive-empty ss-drive-err">${escapeHtml(err.message)}</div>`;
      }
    }

    render();

    // Legacy fallback only: we opened at a folder but only knew its id+name (no
    // stored path). Derive the true ancestry so the breadcrumb is honest and
    // every parent is clickable, refresh just the crumbs (the folder itself is
    // unchanged — a full render() here would re-fetch the same list = double
    // load), then persist the resolved path so the next open is instant.
    if (!knownPath) {
      (async () => {
        if (!last || !last.id) return;
        try {
          const path = await SS.drive.ancestry(last.id);
          if (!path || !path.length) return;
          // Only adopt it if we're still showing that same starting folder
          // (user hasn't navigated away during the async fetch).
          if (stack.length === 1 && stack[0].id === last.id) {
            stack = path.map(s => ({ id: s.id, name: s.name }));
            renderCrumbs();
            const persistPath = stack.filter(s => s.id !== '__roots__');
            if (fromPinned) SS.drive.setPinned(last.id, last.name, persistPath);
            else SS.drive.rememberFolder(last.id, last.name, persistPath);
          }
        } catch (e) { /* keep the single-entry stack on failure */ }
      })();
    }

    return m;
  }

  // Save the current deck into the chosen folder, prompting copy/move when the
  // deck already lives in a different Drive folder.
  async function doSave(folder, path) {
    const pres = SS._currentPres;
    if (!pres) { SS.drive.toast('No presentation open', 'warning'); return; }
    SS.drive.rememberFolder(folder.id, folder.name, path);

    const existingId = SS.drive.knownFileId(pres.id);
    // If this deck is already a Drive file, find out whether it's elsewhere.
    if (existingId) {
      let parents = [];
      try { parents = await SS.drive.getParents(existingId); } catch (e) { /* treat as unknown */ }
      const elsewhere = parents.length && !parents.includes(folder.id);
      if (elsewhere) {
        const choice = await copyOrMovePrompt(folder.name);
        if (choice === 'cancel') return;
        busyCard('Saving to Google Drive…');
        try {
          if (choice === 'move') {
            await SS.drive.moveFile(existingId, folder.id);
            const file = await SS.drive.save(pres); // update content in place
            return finishSave(pres, file, `Moved to “${folder.name}” and saved`);
          }
          // copy → force a brand-new file in the target folder
          const file = await SS.drive.save(pres, { fileId: null, folderId: folder.id });
          return finishSave(pres, file, `Saved a copy in “${folder.name}”`);
        } catch (err) { return errorCard('Save failed', err.message); }
      }
    }

    busyCard('Saving to Google Drive…');
    try {
      const file = await SS.drive.save(pres, existingId ? {} : { folderId: folder.id });
      finishSave(pres, file, `“${pres.title || file.name}” saved to “${folder.name}”`);
    } catch (err) {
      errorCard('Save failed', err.message);
    }
  }

  function finishSave(pres, file, heading) {
    shareResult(file.id, file.webViewLink, heading);
  }

  // Themed yes/no/cancel for the relocate case.
  function copyOrMovePrompt(folderName) {
    return new Promise((resolve) => {
      const m = modal(
        `<h3>This deck is already in Drive</h3>
         <p class="remote-modal-hint">It currently lives in a different folder. Save into
            “${escapeHtml(folderName)}” as a copy, or move the existing file there?</p>
         <div class="remote-modal-actions" style="margin-top:16px; gap:8px">
           <button class="remote-modal-btn" data-c="copy"><span class="remote-modal-btn-icon">📑</span> Save a copy</button>
           <button class="remote-modal-btn ss-drive-go" data-c="move"><span class="remote-modal-btn-icon">➡</span> Move it here</button>
         </div>
         <div class="remote-modal-actions" style="margin-top:8px">
           <button class="remote-modal-btn" data-c="cancel">Cancel</button>
         </div>`
      );
      m.querySelectorAll('[data-c]').forEach(b =>
        b.addEventListener('click', () => resolve(b.dataset.c)));
    });
  }

  /* ── Save / Open entry points ── */
  async function saveCurrent() {
    const pres = SS._currentPres;
    if (!pres) { SS.drive.toast('No presentation open', 'warning'); return; }
    await SS.drive.loadPinned();
    folderBrowser('save');
  }

  async function openPicker() {
    await SS.drive.loadPinned();
    folderBrowser('open');
  }

  async function pickFile(fileId, name) {
    SS.drive.toast('Opening from Drive…');
    closeModal();
    try {
      const raw = await SS.drive.download(fileId);
      const pres = await SS.drive.importDeck(raw, name);
      SS.drive.toast(`Opened “${pres.title || name}”`, 'success');
    } catch (err) {
      errorCard('Open failed', err.message);
    }
  }

  /* ── Share current deck ── */
  async function shareCurrent() {
    const pres = SS._currentPres;
    if (!pres) { SS.drive.toast('No presentation open', 'warning'); return; }
    // Ensure it's saved first (need a Drive file id to share).
    let fileId = SS.drive.knownFileId(pres.id);
    let link = null;
    try {
      if (!fileId) {
        SS.drive.toast('Saving to Drive first…');
        const file = await SS.drive.save(pres);
        fileId = file.id; link = file.webViewLink;
      }
      shareResult(fileId, link, `Share “${pres.title || pres.id}”`);
    } catch (err) {
      errorCard('Share failed', err.message);
    }
  }

  // The result card with copy-link + "share with email" controls.
  function shareResult(fileId, webViewLink, heading) {
    const m = modal(
      `<h3>${escapeHtml(heading)}</h3>
       <p class="remote-modal-hint">Saved to Google Drive. Get a view link, or share with edit access by email.</p>
       <div class="ss-drive-sharebtns">
         <button class="remote-modal-btn" id="ssDriveLinkBtn">
           <span class="remote-modal-btn-icon">🔗</span> Get view link
         </button>
       </div>
       <div class="remote-modal-url" id="ssDriveUrl" style="display:${webViewLink ? 'block' : 'none'}">${escapeHtml(webViewLink || '')}</div>
       <div class="ss-drive-or">share with edit access</div>
       <div class="ss-drive-linkrow">
         <input class="ss-drive-input" id="ssDriveEmail" type="email" placeholder="colleague@example.com" />
         <button class="remote-modal-btn ss-drive-go" id="ssDriveEmailBtn">Invite</button>
       </div>
       <div class="remote-modal-actions" style="margin-top:16px">
         <button class="remote-modal-btn" data-action="close">Done</button>
       </div>`
    );
    m.querySelector('[data-action="close"]').addEventListener('click', closeModal);

    const urlEl = m.querySelector('#ssDriveUrl');

    m.querySelector('#ssDriveLinkBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.innerHTML = '<span class="remote-modal-btn-icon">…</span> Creating link';
      try {
        const link = await SS.drive.share(fileId, 'link');
        urlEl.textContent = link;
        urlEl.style.display = 'block';
        btn.innerHTML = '<span class="remote-modal-btn-icon">📋</span> Copy link';
        btn.disabled = false;
        btn.onclick = () => {
          navigator.clipboard.writeText(link).then(() => {
            btn.innerHTML = '<span class="remote-modal-btn-icon">✓</span> Copied!';
            SS.drive.toast('Link copied', 'success');
          });
        };
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = '<span class="remote-modal-btn-icon">🔗</span> Get view link';
        SS.drive.toast(err.message, 'error');
      }
    });

    m.querySelector('#ssDriveEmailBtn').addEventListener('click', async () => {
      const emailEl = m.querySelector('#ssDriveEmail');
      const email = (emailEl.value || '').trim();
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
        SS.drive.toast('Enter a valid email', 'warning'); return;
      }
      try {
        await SS.drive.share(fileId, 'user', email);
        SS.drive.toast(`Shared with ${email}`, 'success');
        emailEl.value = '';
      } catch (err) {
        SS.drive.toast(err.message, 'error');
      }
    });
  }

  function errorCard(title, detail) {
    const m = modal(
      `<h3>${escapeHtml(title)}</h3>
       <p class="remote-modal-hint" style="white-space:pre-wrap">${escapeHtml(detail || '')}</p>
       <div class="remote-modal-actions" style="margin-top:16px">
         <button class="remote-modal-btn" data-action="close">Close</button>
       </div>`
    );
    m.querySelector('[data-action="close"]').addEventListener('click', closeModal);
  }

  function timeAgo(iso) {
    if (window.lucidos && lucidos.utils && lucidos.utils.timeAgo) {
      try { return lucidos.utils.timeAgo(iso); } catch (e) { /* fall through */ }
    }
    return new Date(iso).toLocaleDateString();
  }

  return { saveCurrent, openPicker, shareCurrent, close: closeModal };
})();
