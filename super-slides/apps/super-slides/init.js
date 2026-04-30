/* Super Slides — Init
   Discovers .slides files under artifacts/presentations/ via the SDK,
   shows loading state in #app (set in HTML), clears on success,
   shows error overlay on failure. Never swallows errors. */

(async function init() {
  const app = document.getElementById('app');

  // Phase 0: Discover presentations.
  // Convention: every .slides file lives directly under artifacts/presentations/.
  // Falls back to an empty list if the directory doesn't exist yet.
  let files = [];
  try {
    files = await lucidos.data.list('artifacts/presentations/*.slides');
  } catch (err) {
    SS.showError(
      'Discovery Failed',
      'Could not list presentations. The Lucidos data API returned an error.',
      err && (err.message || String(err)),
      'init.js → lucidos.data.list()'
    );
    return;
  }

  // Remove loading indicator early so the user sees state changes
  const loadingEl = app.querySelector('.ss-loading');
  if (loadingEl) loadingEl.remove();

  if (files.length === 0) {
    SS.showError(
      'No Presentations Yet',
      'Drop a <code>.slides</code> file into <code>artifacts/presentations/</code> to see it here. ' +
      'Ask Lucidos: <em>"create a new presentation called X"</em> and it will scaffold one using the ' +
      '<code>super-slides/slides-format</code> knowhow.',
      null,
      'artifacts/presentations/'
    );
    return;
  }

  // Phase 1: Load presentations — show per-file errors but continue
  const results = await Promise.allSettled(
    files.map(f => SS.loadPresentation(f))
  );

  const loaded = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      loaded.push(files[i]);
    } else {
      failed.push({ file: files[i], error: r.reason });
    }
  });

  // Phase 2: Show results
  if (loaded.length === 0) {
    const detail = failed.map(f =>
      `${f.file}\n  → ${f.error?.message || f.error}`
    ).join('\n\n');
    SS.showError(
      'No Presentations Loaded',
      'All presentation files failed to load. Check the file paths and try reloading.',
      detail,
      'init.js'
    );
    return;
  }

  if (failed.length > 0) {
    failed.forEach(f => {
      console.error(`[SS] Failed to load ${f.file}:`, f.error);
    });
  }

  // Phase 3: Init engine
  try {
    SS.initEngine();
    SS.initEditing();
  } catch (err) {
    SS.showError(
      'Engine Error',
      'Presentations loaded but the engine failed to initialize.',
      err.message + (err.stack ? '\n' + err.stack : ''),
      'init.js → initEngine()'
    );
    return;
  }

  // Phase 4: Restore device mode
  if (localStorage.getItem('ss-mode') === 'remote' && SS.toggleRemoteMode) {
    SS.toggleRemoteMode();
  }
})();
