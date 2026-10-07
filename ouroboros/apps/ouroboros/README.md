# Ouroboros

Classic Snake for Lucidos, with daily and all-time leaderboards, replays,
procedural music and a Game Over sequence timed to the jingle.

## Layout

```
index.html          markup, plus the script and stylesheet order
css/                styles, split by area (base → responsive, cascade order matters)
js/core/            pure logic, no DOM: rules, scores, replays, timing, fall physics
js/store.js         highscore/player storage: local (lucidos.data) or shared (proxy)
js/players.js       current player and known players
js/audio/           AudioContext engine, sound effects, music, and the O.Audio facade
js/render/          canvas board, particles, DOM effects, the Game Over overlay
js/ui/              input, scoreboard panels, overlay screens, storage screen
js/main.js          controller: state, render loop, replays, death sequence
audio/clips/        bundled fanfare/trombone overrides, loaded at startup
knowhow/            storage backend reference for the Lucidos agent
tests/unit/         node:test unit tests for js/core, store and players
tests/e2e/          Chromium + WebKit tests for the Game Over sequence and more
```

Everything hangs off `window.Ouroboros`. The files are classic scripts, not ES
modules: the app frame has an opaque origin, and module scripts load with CORS,
which the engine does not grant for app files. Files in `js/core/`, plus
`js/store.js` and `js/players.js`, also export through `module.exports`, so
Node can test them without a build step.

## Tests

```
npm test                 # unit tests, plain Node, no dependencies
npm run test:e2e         # needs playwright-core and its browsers:
PLAYWRIGHT_CORE=~/projects/lucidos/node_modules/playwright-core npm run test:e2e
```

The e2e suite serves the app with a stub SDK. It checks that the Game Over
words stay inside their SVG box (WebKit clips a filtered SVG to that box),
settle before the dissolve, and finish on the start screen. It runs in
Chromium, WebKit, and WebKit throttled to 30 fps.

## Keep in mind

- The playing field has a fixed size and the font is always monospace. Neither
  follows the Lucidos UI-scale or font preferences.
- The death animation steps on a fixed 60 Hz clock (`Timing.createFixedStepClock`).
  Never count rAF frames: Safari caps rAF at 60 Hz, or 30 Hz in Low Power Mode.
- Anything from a scoreboard goes through `Text.escapeHtml` before it reaches
  `innerHTML`. Shared boards are written by other people.
