---
name: .slides File Format
description: Reference for the .slides JSON format, semantic component types, and editing patterns for Super Slides presentations
---

# .slides File Format

## Core Rules

1. **Always confirm which presentation the user is talking about** before making any edits. There are multiple `.slides` files — never assume. Check the app UI to see which presentation is currently open, or ask the user. Editing the wrong file means a revert and wasted time.

2. **`.slides` files contain ZERO CSS.** All styling lives in `styles.css` (built-in) or per-presentation `styles.css` (custom). The `.slides` file is pure semantic data.

## File Structure

```json
{
  "id": "my-presentation",
  "title": "Display Title",
  "subtitle": "Optional subtitle",
  "titleScroller": { ... },       // Optional hero animation
  "sections": [                    // Optional — flat "slides" array also works
    {
      "title": "Section Name",
      "color": "accent",           // Theme color name
      "slides": [
        {
          "title": "Slide Title",  // Used in slide picker
          "hero": false,           // Centers content vertically
          "notes": "Speaker notes", // Plain text, shown in remote view; \n\n splits paragraphs
          "cardNotes": ["Card 0 notes", "Card 1 notes"], // Per-card notes shown when card is focused
          "content": [ ... ]       // Array of component nodes
        }
      ]
    }
  ]
}
```

### With sections vs without

- **Sectioned**: `{ sections: [{ title, color, slides: [...] }] }` — enables section indicator pips and grouped slide picker
- **Flat**: `{ slides: [...] }` — simple sequential slides

## Component Types

### Layout

| Type | Props | Description |
|------|-------|-------------|
| `columns` | `children`, `mt`, `mb`, `gap`, `align` | 2-column grid |
| `threeCol` | `children`, `mt`, `mb`, `gap` | 3-column grid |
| `fourCol` | `children`, `mt`, `mb`, `gap` | 4-column grid |
| `group` | `children`, `mt`, `mb`, `gap`, `align` | Vertical flex container |

### Content

| Type | Props | Description |
|------|-------|-------------|
| `slideHeader` | `tag: {text, color}`, `title`, `subtitle` | Standard slide header with tag pill |
| `card` | `children`, `highlight`, `className`, `mt`, `mb`, `align` | Bordered card container |
| `heading` | `level` (1-6), `text`, `color`, `size`, `mt`, `mb`, `sub`, `subColor` | Semantic heading |
| `text` | `text`, `color`, `align`, `size`, `font` ("mono"), `weight`, `mt`, `mb`, `leading` | Paragraph |
| `stat` | `value`, `label`, `sublabel`, `color` | Large number/value display |
| `list` | `items` (string array) | Unordered list |
| `insight` | `text`, `color` | Highlighted callout box |
| `icon` | `emoji` | Large centered emoji |
| `spacer` | `size` (xs/sm/md/lg/xl/2xl) | Vertical space |

### Specialized

| Type | Props | Description |
|------|-------|-------------|
| `pipeline` | `children` (pipelineStep nodes) | Horizontal flow diagram |
| `pipelineStep` | `icon`, `label`, `ownerClass`, `ownerLabel`, `sub` | Single pipeline step |
| `esFlow` | `events` (string array) | Event sourcing arrow chain |
| `tree` | `content` (HTML with .dir/.file/.highlight classes) | Terminal-style file tree |
| `skillChips` | `chips` (string array) | Tag pills for skills/tech |
| `takeawayList` | `children` (takeawayItem nodes) | Numbered takeaway list |
| `takeawayItem` | `num`, `title`, `body` | Single takeaway entry |
| `teamBadge` | `text` | Dot + label badge |
| `vsLabel` | `text` | "VS" separator label |
| `archDiagram` | `content` (SVG string) | Architecture diagram |

### External Content

| Type | Props | Description |
|------|-------|-------------|
| `include` | `src` | Loads external HTML file from `{presId}/{src}` |
| `html` | `content` | Raw HTML escape hatch (use sparingly) |

## Semantic Props (replaces inline CSS)

Instead of `"style": "margin-top: 24px; text-align: center;"`, use semantic props:

| Prop | Values | CSS equivalent |
|------|--------|---------------|
| `mt` | xs/sm/md/lg/xl/2xl | margin-top |
| `mb` | xs/sm/md/lg/xl/2xl | margin-bottom |
| `gap` | xs/sm/md/lg/xl | grid/flex gap |
| `align` | start/center/end/stretch | align-items |
| `color` | accent/green/amber/cyan/rose/orange/purple/white/dim/text | text color |
| `size` | xs/sm/md/lg/xl/2xl/3xl/4xl/5xl | font-size |
| `weight` | 300-800 | font-weight |
| `font` | "mono" | JetBrains Mono |
| `leading` | tight/normal/relaxed/loose/double | line-height |
| `highlight` | accent/green/amber/cyan/rose/orange/purple | card border glow |

## Inline Markup (allowed in text values)

These HTML tags are allowed inside `text`, `title`, `body` etc. values:
- `<strong>`, `<em>`, `<code>`, `<br>`, `<span class="...">` (with utility classes only)

**Never** use `style` attributes in inline markup.

## Presentation Assets

```
artifacts/presentations/
  my-pres.slides              # Pure semantic JSON
  my-pres/                    # Companion directory (same name as id)
    timeline-chart.html       # Complex visuals (loaded via include)
    components.js             # Custom component definitions
    styles.css                # Custom component styles
```

### Custom Components

Register via `SS.registerComponent(name, renderFn)` in `{presId}/components.js`:

```javascript
SS.registerComponent('myChart', (node) =>
  `<div class="my-chart">${node.data.map(d => `<span>${d}</span>`).join('')}</div>`
);
```

Custom components are checked before built-in types in `renderNode`.

## Editing Patterns

### Use json_path for surgical edits

```
edit_file(path="artifacts/presentations/cognos.slides",
          json_path="sections[2].slides[0].content[1].children[0].children[1]",
          new_value={"type": "heading", "level": 3, "text": "New Title", "color": "cyan"})
```

### Use Python for bulk operations

When migrating or restructuring many nodes, use `run_python` with `json.load()`/`json.dump()` — more reliable than string replacement for structured changes.

### Common edit scenarios

- **Change card title**: `json_path="...content[N].children[0]"` → update heading node
- **Add a slide**: `json_path="sections[N].slides"` → append to array
- **Change colors**: `json_path="...highlight"` → new color name
- **Add spacing**: Add `"mt": "lg"` prop to the node
- **Complex visual**: Create an HTML file in `{presId}/`, add `{"type": "include", "src": "filename.html"}`

## Loading & Error States

The app must always show its current state — never a blank screen.

### Principles

1. **No blank screens** — `#app` starts with a loading spinner in the HTML itself (not injected by JS). The user sees "Loading presentations…" immediately.
2. **No swallowed errors** — every `catch` either calls `SS.showError()` or logs to console. Silent failures are bugs.
3. **Partial success is OK** — if 1 of N presentations fails, show the ones that loaded. Log the failure visibly.
4. **Phase-based init** — init.js runs in phases: Load → Clear loading → Init engine → Restore mode. Each phase handles its own errors.

### Implementation

- **HTML**: `<div id="app">` contains a `.ss-loading` div with spinner + message, visible before any JS runs.
- **init.js**: Uses `Promise.allSettled()` so one file failing doesn't block others. Removes `.ss-loading` after all settle. Shows `SS.showError()` overlay if zero presentations loaded; logs and continues if partial.
- **SS.showError()**: Full-screen overlay with icon, title, message, detail (monospace), and source. Z-index 9999 so it's always visible.
- **SS.loadPresentation()**: Shows error overlay for file-read failures and JSON parse failures (with position context). Throws after showing — caller decides whether to continue.

### CSS classes

| Class | Purpose |
|-------|---------|
| `.ss-loading` | Full-screen centered loading state (spinner + text) |
| `.ss-loading-spinner` | Animated border-spin circle |
| `.ss-error-overlay` | Full-screen error backdrop |
| `.ss-error-box` | Error card with icon, title, message, detail, source |

## Tests

### Structure

```
tests/
  index.html       ← Runner page — loads all suites, renders results
  harness.js       ← suite(), assert*, renderResults()
  models.js        ← Mock event bus, presenter, remote (mirror actual code)
  test-sync.js     ← Basic sync between presenter and remote
  test-commands.js ← next/prev/goto/boundary checks
  test-switching.js← Multi-presentation switching & stale ID handling
  test-cards.js    ← Card focus system
  test-recovery.js ← Anti-flicker pending goto, missed events, late join
```

### Adding a test suite

1. Create `tests/test-foo.js` using `suite()` from harness:
   ```javascript
   suite('My Feature', (t) => {
     t.test('does thing', () => {
       assertEqual(1, 1, 'one is one');
     });
   });
   ```
2. Add `<script src="test-foo.js"></script>` to `tests/index.html` before the render script.

### Running tests

Open `tests/index.html` via the data API:
```
/api/v1/data/apps/super-slides/tests/index.html
```

### When to update

- **models.js must stay in sync with engine.js and remote-mode.js.** When you change command handling, state broadcasting, presentation switching, or card focus logic in the real code, update the corresponding model and run the tests.
- After any change to engine.js, remote-mode.js, or remote.js: **run the tests before committing the knowhow or marking done.**

### Available assertions

`assert(cond, msg)`, `assertEqual(a, b, label)`, `assertNotEqual(a, b, label)`, `assertDeepEqual(a, b, label)`, `assertGreater(a, b, label)`, `assertGreaterOrEqual(a, b, label)`

## Card Focus System

Slides with ≥2 `.card` elements (or `.takeaway-item` / `.insight`) support arrow-key focus mode:
- `→` focuses next card, `←` unfocuses or goes to previous
- The slide gets `data-card-focus="N"` attribute — use this in CSS for per-card animations
- Cards get `.card-focused` class when active

## Speaker Remote (`remote.html`)

A separate UI in the same app folder for driving the presenter from a phone or second window.

### Files

- `remote.html` — shell (header, slide info, notes card, prev/next/picker)
- `remote.js` — SSE wiring + command sender
- `remote.css` — self-contained styling
- `remote-mode.js` — embedded remote overlay (injected into main app)
- `remote-mode.css` — embedded remote styling (`.rm-` prefix)

### Sync via domain events

The presenter and remote talk through three event types, all emitted as **transient** (`{ transient: true }`) — they are broadcast over SSE but **not persisted** to the event store:

| Event | Direction | Payload |
|-------|-----------|---------|
| `SlidePresenterState` | presenter → remote | `{ presentationId, presentationTitle, slideIndex, slideCount, slideTitle, cardIndex, cardCount }` |
| `SlideRemoteCommand`  | remote → presenter | `{ action: "setState" \| "sync", presentationId, slideIndex, cardIndex }` |
| `SlidePresenterPing`  | remote → presenter | `{}` — asks the presenter to re-broadcast its current state |

**Absolute-state protocol** (current): every `setState` command carries the **full target state** — `presentationId`, `slideIndex`, and `cardIndex` together. The presenter reconciles to that target in three steps:
1. If `presentationId` differs from current → switch presentation (loading the new one and broadcasting).
2. If `slideIndex` differs → `goTo(slideIndex)`.
3. If `cardIndex` differs → `focusCard(cardIndex)` or `clearCardFocus()`.

There are **no relative commands** (no `next`/`prev`/`focusCard`/`clearCardFocus`). The remote computes the target locally (using its optimistic state) and tells the presenter exactly where to be. This makes drift impossible: a stale or out-of-order command still names the full state it wants, so the last command always wins.

The legacy `sync` action is preserved for the rare case of asking the presenter to re-broadcast without changing state.

Because events are transient, a freshly-opened remote cannot query stored state — it relies on `SlidePresenterPing` to ask the presenter for an immediate re-broadcast.

Presenter broadcasts `SlidePresenterState` on every `goTo()`, card focus change, and after `loadPresentation()`. The state includes `cardIndex` (-1 = no focus) and `cardCount` so remotes can render card navigation.

When the remote switches presentations via the picker, it **optimistically updates** its own state (`presentationId`, `slideIndex = 0`, `slideCount`, etc.) immediately before sending the `setState`, so any subsequent tap carries the correct new ID.

### Remote commands

| Action | Required fields | Description |
|--------|----------------|-------------|
| `setState` | `presentationId`, `slideIndex`, `cardIndex` | Reconcile presenter to this exact target state |
| `sync` | `presentationId` | Ask presenter to re-broadcast current state (no change) |

The remote translates UX actions into `setState`:
- Tap "next": send `{ presentationId, slideIndex: current+1, cardIndex: -1 }`
- Tap "prev": send `{ presentationId, slideIndex: current-1, cardIndex: -1 }`
- Picker pick slide N: send `{ presentationId, slideIndex: N, cardIndex: -1 }`
- Picker pick presentation P: send `{ presentationId: P, slideIndex: 0, cardIndex: -1 }`
- Focus card C: send `{ presentationId, slideIndex, cardIndex: C }`
- Clear card focus: send `{ presentationId, slideIndex, cardIndex: -1 }`

### Anti-flicker on the remote (pending goto)

The remote still uses a short-lived "pending" guard to suppress in-flight broadcasts that would briefly revert the optimistic UI. When a broadcast arrives whose `slideIndex` doesn't match the pending value, it is dropped for up to 3 seconds (`PENDING_TIMEOUT`).

**Exception**: when the broadcast carries a different `presentationId`, the guard is bypassed and the pending state is dropped — a presentation switch on the presenter (e.g. desktop user picks one from the menu) must always win. Covered by `tests/test-desync.js`.

### Embedded remote mode (`remote-mode.js` + `remote-mode.css`)

A full-screen overlay inside the main app, activated via the menu ("Remote mode") or `SS.toggleRemoteMode()`. Designed for controlling the presenter from Lucidos on mobile.

Features:
- **Top navigation**: prev/next buttons, slide counter, picker, and exit button
- **Presentation selector**: dropdown to switch between loaded presentations
- **Card iteration**: shows card nav when the current slide has ≥2 focusable cards (cards, takeaway items, insights). Sends `focusCard` and `clearCardFocus` commands.
- **Editable speaker notes**: textarea bound to the current slide's `notes` field. Dirty notes are saved via `lucidos.data.edit()` (JSON path edit) to the `.slides` file. Auto-saves on slide change or exit.
- **Slide picker**: bottom-sheet overlay with section grouping
- **Touch swipes**: horizontal swipe for prev/next

Files:
- `remote-mode.css` — self-contained styles (`.rm-` prefix)
- `remote-mode.js` — injects DOM into body, manages its own state, listens for `SlidePresenterState` via SSE

### Standalone speaker remote (`remote.html`)

A separate UI in the same app folder for driving the presenter from a phone or second window (outside Lucidos).

### Speaker notes

- Slides may carry a `notes` string. Plain text; `\n\n` becomes paragraphs, `\n` becomes `<br>`.
- Slides may also carry a `cardNotes` array of strings — per-card notes shown when a card is focused. Index 0 = first focusable element (`.card`, `.takeaway-item`, or `.insight` in DOM order).
- When `cardIndex >= 0`, the remote shows `cardNotes[cardIndex]` (falling back to empty). When `cardIndex === -1`, it shows `notes`.
- Notes are read directly from the `.slides` file by both `remote.js` and `remote-mode.js`.
- The **embedded remote mode** makes notes editable — changes are saved back to the `.slides` file via `lucidos.data.edit()` using the slide's JSON path + `.notes` or `.cardNotes`.
- The presenter view ignores `notes` and `cardNotes` entirely — they never appear on screen.
