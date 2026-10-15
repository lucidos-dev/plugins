/* Super Slides — Device mode
   Presenter on the laptop, remote on the phone: `ss-mode` is a fact about
   this device, so it stays out of the workspace-wide SS.appState document,
   which every device shares. It lives in lucidos.storage.local, the SDK's
   per-device store for an app frame (js-sdk.md § lucidos.storage). */

SS.deviceMode = (function () {
  const KEY = 'ss-mode';

  // The mode this device used last. Called once at startup: the one await of
  // lucidos.storage.ready, since a read before it sees nothing stored.
  async function restore() {
    await lucidos.storage.ready;
    return lucidos.storage.local.getItem(KEY) === 'remote' ? 'remote' : 'presenter';
  }

  function remember(mode) {
    lucidos.storage.local.setItem(KEY, mode);
  }

  return { restore, remember };
})();
