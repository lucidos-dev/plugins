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

  /* ── last-used folder memory ── */
  const LAST_FOLDER_KEY = 'ss-drive-last-folder'; // { id, name }
  function rememberFolder(id, name) {
    try { localStorage.setItem(LAST_FOLDER_KEY, JSON.stringify({ id, name })); } catch (e) {}
  }
  function lastFolder() {
    try { return JSON.parse(localStorage.getItem(LAST_FOLDER_KEY)) || null; } catch (e) { return null; }
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
    getParents, moveFile, listFolders, listSharedDrives, listInFolder,
    rememberFolder, lastFolder,
  };
})();

/* ══════════════════════════════════════════════════════
   Drive UI — modals (matches the speaker-remote modal style)
   ══════════════════════════════════════════════════════ */

SS.driveUI = (function () {
  function closeModal() {
    const ex = document.getElementById('ssDriveModal');
    if (ex) ex.remove();
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
    // Start at the last-used folder when we have one (default: roots list).
    const last = SS.drive.lastFolder();
    let stack = last ? [{ id: last.id, name: last.name }] : [{ id: '__roots__', name: 'Drive' }];

    const m = modal(
      `<h3>${mode === 'save' ? 'Save to Google Drive' : 'Open from Google Drive'}</h3>
       <div class="ss-drive-crumbs" id="ssCrumbs"></div>
       <div class="ss-drive-browser" id="ssBrowser"><div class="ss-drive-loading">Loading…</div></div>
       <div class="ss-drive-actionsbar" id="ssActionsBar"></div>
       ${mode === 'open' ? `
       <div class="ss-drive-or">or open any deck you have access to</div>
       <div class="ss-drive-linkrow">
         <input class="ss-drive-input" id="ssDriveLink" placeholder="Paste a Drive share link or file ID" />
         <button class="remote-modal-btn ss-drive-go" id="ssDriveOpenLink">Open</button>
       </div>` : ''}
       <div class="remote-modal-actions" style="margin-top:16px">
         <button class="remote-modal-btn" data-action="close">Cancel</button>
       </div>`
    );
    m.querySelector('[data-action="close"]').addEventListener('click', closeModal);
    if (mode === 'open') {
      m.querySelector('#ssDriveOpenLink').addEventListener('click', openByLink);
      m.querySelector('#ssDriveLink').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') openByLink();
      });
    }

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

    function renderActions() {
      const loc = here();
      const canSaveHere = mode === 'save' && loc.id !== '__roots__' &&
        loc.id !== '__drives__' && loc.id !== 'sharedWithMe';
      actionsEl.innerHTML = canSaveHere
        ? `<button class="remote-modal-btn ss-drive-savehere" id="ssSaveHere">
             <span class="remote-modal-btn-icon">⬆</span> Save here: <strong>${escapeHtml(loc.name)}</strong>
           </button>`
        : (mode === 'save'
            ? `<div class="ss-drive-hint-inline">Open a folder to save into it.</div>`
            : '');
      if (canSaveHere) {
        actionsEl.querySelector('#ssSaveHere').addEventListener('click', () => doSave(loc));
      }
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
    return m;
  }

  // Save the current deck into the chosen folder, prompting copy/move when the
  // deck already lives in a different Drive folder.
  async function doSave(folder) {
    const pres = SS._currentPres;
    if (!pres) { SS.drive.toast('No presentation open', 'warning'); return; }
    SS.drive.rememberFolder(folder.id, folder.name);

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
  function saveCurrent() {
    const pres = SS._currentPres;
    if (!pres) { SS.drive.toast('No presentation open', 'warning'); return; }
    folderBrowser('save');
  }

  function openPicker() {
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

  async function openByLink() {
    const input = document.getElementById('ssDriveLink');
    const id = SS.drive.parseFileId(input && input.value);
    if (!id) { SS.drive.toast('That doesn’t look like a Drive link or file ID', 'warning'); return; }
    SS.drive.toast('Opening from Drive…');
    closeModal();
    try {
      let name = 'imported';
      try { const md = await SS.drive.meta(id); name = md.name || name; } catch (e) { /* metadata optional */ }
      const raw = await SS.drive.download(id);
      const pres = await SS.drive.importDeck(raw, name);
      SS.drive.toast(`Opened “${pres.title || name}”`, 'success');
    } catch (err) {
      errorCard('Open failed', err.message + '\n\nIf this is a colleague’s deck, the connected Google account may need access to it (drive.file only sees files this app created).');
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
