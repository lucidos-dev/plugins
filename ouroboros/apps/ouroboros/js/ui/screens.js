// Ouroboros, the overlay and its screens: name, start and storage.
(function (O) {
  'use strict';

  const { escapeHtml } = O.Text;
  const $ = id => document.getElementById(id);

  let el;

  function init() {
    el = {
      overlay: $('overlay'),
      name: $('name-screen'),
      start: $('start-screen'),
      storage: $('storage-screen'),
      nameTitle: $('name-screen-title'),
      namePrompt: $('name-screen-prompt'),
      nameInput: $('name-input'),
      nameOk: $('btn-name-ok'),
      knownPlayers: $('known-players'),
      nameDivider: $('name-divider'),
      startTitle: $('start-title'),
      startBtn: $('btn-start')
    };
  }

  function hideAll() {
    el.name.classList.add('hidden');
    el.start.classList.add('hidden');
    el.storage.classList.add('hidden');
  }

  function showOverlay() { el.overlay.classList.remove('hidden'); }
  function hideOverlay() { el.overlay.classList.add('hidden'); }

  // The overlay fades in while the Game Over text dissolves
  function setOverlayFadeIn(on) { el.overlay.classList.toggle('dissolve-fade-in', on); }

  function isNameVisible() { return !el.name.classList.contains('hidden'); }
  function isStartVisible() { return !el.start.classList.contains('hidden'); }

  function renderKnownPlayers(players, onPick) {
    el.knownPlayers.classList.toggle('hidden', !players.length);
    el.nameDivider.classList.add('hidden');
    if (!players.length) return;
    el.knownPlayers.innerHTML = players.map(p =>
      `<button class="player-chip" data-player="${escapeHtml(p)}">${escapeHtml(p)}</button>`
    ).join('');
    el.knownPlayers.querySelectorAll('.player-chip').forEach(chip => {
      chip.addEventListener('click', () => onPick(chip.dataset.player));
    });
  }

  // "Hva heter du?" on first run, "BYTT SPILLER" when switching.
  function showName({ isSwitch, players, onPick }) {
    hideAll();
    el.nameTitle.textContent = isSwitch ? 'BYTT SPILLER' : 'Ouroboros';
    el.nameTitle.classList.toggle('venom-title', isSwitch);
    el.namePrompt.textContent = isSwitch ? '' : 'Hva heter du?';
    el.namePrompt.classList.toggle('hidden', isSwitch);
    el.nameOk.textContent = isSwitch ? 'Bytt' : 'Start';
    el.name.classList.remove('hidden');
    showOverlay();
    renderKnownPlayers(players, onPick);
    el.nameInput.value = '';
    el.nameInput.placeholder = 'DITT NAVN';
    setTimeout(() => el.nameInput.focus(), 100);
  }

  function showStart(player) {
    hideAll();
    el.startTitle.textContent = 'ER DU KLAR?';
    el.startBtn.textContent = `START SOM ${player.toUpperCase()}`;
    el.start.classList.remove('hidden');
    showOverlay();
  }

  function showStorage() {
    hideAll();
    showOverlay();
    el.storage.classList.remove('hidden');
  }

  O.Screens = {
    init, hideAll, showOverlay, hideOverlay, setOverlayFadeIn,
    isNameVisible, isStartVisible, showName, showStart, showStorage
  };
})(window.Ouroboros);
