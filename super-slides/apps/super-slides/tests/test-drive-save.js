/* ══════════════════════════════════════════════════════
   Super Slides — Drive save content resolution
   ══════════════════════════════════════════════════════
   Regression coverage for the "Drive saved my pre-edit content"
   staleness bug.

   The chain that produced it:
     - loadPresentation() snapshots the file into pres.rawData ONCE.
     - inline edits (editing.js) and notes edits (remote-mode.js) patch
       the on-disk .slides file via lucidos.data.edit(), but never touch
       pres.rawData.
     - save() used to upload pres.rawData — the stale load-time snapshot —
       so Drive received pre-edit content even though it reported "saved",
       and re-opening that Drive copy clobbered the good local file.

   The fix: SS.drive.resolveSaveContent(pres) re-reads the on-disk file as
   the source of truth, syncs pres.rawData, and returns the bytes to upload.
   These tests drive that REAL exported function with a mocked lucidos.data.
   ══════════════════════════════════════════════════════ */

asuite('Drive save — content resolution', (t) => {
  // Per-test lucidos stub. resolveSaveContent reads window.lucidos.data.read.
  let savedLucidos;
  let readCalls;

  t.beforeEach(() => {
    savedLucidos = window.lucidos;
    readCalls = [];
  });
  t.afterEach(() => {
    window.lucidos = savedLucidos; // restore (undefined in the test page)
  });

  // Build a registry-entry-shaped pres whose on-disk file differs from the
  // load-time rawData snapshot — exactly the post-edit state.
  function makeStalePres(diskContent, snapshot) {
    window.lucidos = {
      data: {
        read: async (path) => { readCalls.push(path); return diskContent; },
      },
    };
    return {
      id: 'ua-architecture',
      sourceFile: 'artifacts/presentations/ua-architecture.slides',
      rawData: snapshot, // stale: captured at load time
    };
  }

  t.test('uploads the EDITED on-disk content, not the stale snapshot', async () => {
    const onDisk = { id: 'ua-architecture', title: 'Tech Lead Forum — April 2026' };
    const stale  = { id: 'ua-architecture', title: 'Tech Lead Forum — April 2026 - test' };
    const pres = makeStalePres(JSON.stringify(onDisk), stale);

    const { data, content } = await SS.drive.resolveSaveContent(pres);

    assertEqual(data.title, 'Tech Lead Forum — April 2026', 'parsed title is the edited one');
    assert(content.includes('Tech Lead Forum — April 2026'), 'content carries edited title');
    assert(!content.includes('- test'), 'content does NOT carry the stale "- test" suffix');
    assertEqual(readCalls.length, 1, 'read the source file exactly once');
    assertEqual(readCalls[0], pres.sourceFile, 'read the deck source file');
  });

  t.test('syncs pres.rawData to the on-disk content', async () => {
    const onDisk = { id: 'ua-architecture', title: 'Fresh' };
    const pres = makeStalePres(JSON.stringify(onDisk), { id: 'ua-architecture', title: 'Stale' });

    await SS.drive.resolveSaveContent(pres);

    assertEqual(pres.rawData.title, 'Fresh', 'rawData updated to disk content');
  });

  t.test('content is pretty-printed and round-trips', async () => {
    const onDisk = { id: 'deck', title: 'T', slides: [{ title: 'A' }] };
    const pres = makeStalePres(JSON.stringify(onDisk), null);

    const { content } = await SS.drive.resolveSaveContent(pres);

    assert(content.includes('\n  '), 'two-space indentation present');
    assertDeepEqual(JSON.parse(content), onDisk, 'content parses back to disk object');
  });

  t.test('falls back to rawData when there is no sourceFile', async () => {
    window.lucidos = { data: { read: async () => { throw new Error('should not be called'); } } };
    const snapshot = { id: 'mem-only', title: 'In memory' };
    const pres = { id: 'mem-only', rawData: snapshot }; // no sourceFile

    const { data, content } = await SS.drive.resolveSaveContent(pres);

    assertEqual(data.title, 'In memory', 'used in-memory rawData');
    assertDeepEqual(JSON.parse(content), snapshot, 'content from rawData');
  });

  t.test('falls back to rawData when the disk read fails', async () => {
    window.lucidos = { data: { read: async () => { throw new Error('boom'); } } };
    const snapshot = { id: 'deck', title: 'Recovered from memory' };
    const pres = { id: 'deck', sourceFile: 'artifacts/presentations/deck.slides', rawData: snapshot };

    const { data } = await SS.drive.resolveSaveContent(pres);

    assertEqual(data.title, 'Recovered from memory', 'fell back to rawData on read failure');
  });

  t.test('falls back to rawData when the disk file is malformed JSON', async () => {
    window.lucidos = { data: { read: async () => '{ this is not json' } };
    const snapshot = { id: 'deck', title: 'Kept' };
    const pres = { id: 'deck', sourceFile: 'artifacts/presentations/deck.slides', rawData: snapshot };

    const { data } = await SS.drive.resolveSaveContent(pres);

    assertEqual(data.title, 'Kept', 'malformed disk JSON falls back to rawData instead of throwing');
  });

  t.test('throws when there is no presentation', async () => {
    await assertThrowsAsync(() => SS.drive.resolveSaveContent(null), 'null pres throws');
  });

  t.test('throws when there is neither sourceFile nor rawData', async () => {
    window.lucidos = undefined;
    await assertThrowsAsync(
      () => SS.drive.resolveSaveContent({ id: 'empty' }),
      'no data anywhere throws'
    );
  });
});
