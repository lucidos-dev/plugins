/* ══════════════════════════════════════════════════════
   Super Slides — Navigation logic (pure)
   ══════════════════════════════════════════════════════
   The arrow-key traversal rules, extracted as a pure
   function with NO DOM and NO timers so engine.js and the
   test suite share one source of truth.

   `arrowNav(state, direction)` returns an ACTION descriptor
   describing what a Left/Right press should do; the caller
   (engine.js) dispatches it against the live DOM/state, and
   the test (test-nav.js) applies it against a tiny model to
   assert the back/forward sequence is a perfect mirror.

   The invariant this guarantees: pressing Right K times then
   Left K times returns to the exact starting (slide, card).
   The historical bug — Left jumped whole slides once no card
   was focused, instead of entering the previous slide at its
   last card — violated that invariant intermittently.
   ══════════════════════════════════════════════════════ */

/* Attach to the existing SS namespace — DO NOT re-declare it.
   components.js declares `const SS = {}` (a top-level lexical binding) and
   loads before this file in index.html. A `var SS = …` here would collide
   with that lexical binding (a var whose name already has a lexical
   declaration in the same global scope is a SyntaxError), so this whole
   file would silently fail to execute and SS.navLogic would never exist —
   breaking every Left/Right keypress. The tests don't load components.js,
   so they never saw the clash. Just reference SS; it is always defined by
   the time this script runs (components.js in the app, an inline shim in
   tests/index.html). */
SS.navLogic = {
  /**
   * Compute the action for an arrow press.
   *
   * state:
   *   current            — current slide index
   *   slideCount         — total slides
   *   focusedCardIndex   — focused card on current slide, or -1 for none
   *   cardCount          — focusable count on the CURRENT slide
   *                        (>= 2 means "multi-card": cards are walkable)
   *   prevSlideCardCount — focusable count on slide (current-1); only
   *                        consulted by Left when crossing a boundary
   * direction: 'right' | 'left'
   *
   * Returns one of:
   *   { type: 'focusCard', index }       — focus a card on the current slide
   *   { type: 'clearCardFocus' }         — drop focus, stay on the slide
   *   { type: 'goTo', index }            — navigate to a slide (no card)
   *   { type: 'goToFocusLast', index, lastCard }
   *                                      — navigate back a slide AND enter it
   *                                        at its last card (Left boundary cross)
   *   { type: 'none' }                   — nothing to do (already at an edge)
   *
   * `goTo`/`goToFocusLast` indices may be out of range; the dispatcher's
   * goTo() guards bounds, mirroring the original inline handler exactly.
   */
  arrowNav: function (state, direction) {
    var current = state.current;
    var focused = state.focusedCardIndex;
    var cardCount = state.cardCount || 0;
    var prevCount = state.prevSlideCardCount || 0;
    var multi = cardCount >= 2;

    if (direction === 'right') {
      // Expand the current slide card-by-card, then fall through to the
      // next slide once the last card is focused.
      if (multi) {
        if (focused === -1) return { type: 'focusCard', index: 0 };
        if (focused < cardCount - 1) return { type: 'focusCard', index: focused + 1 };
        return { type: 'goTo', index: current + 1 };
      }
      return { type: 'goTo', index: current + 1 };
    }

    // direction === 'left' — the exact inverse of Right.
    // 1. Step back through this slide's cards while one is focused.
    if (multi && focused > 0) return { type: 'focusCard', index: focused - 1 };
    // 2. Reverse of the -1 → 0 step: drop focus but stay on the slide.
    if (multi && focused === 0) return { type: 'clearCardFocus' };
    // 3. No card focused (or single/no-card slide): cross to the previous
    //    slide. Enter it at its LAST card when it has cards to walk — this is
    //    the mirror of how Right EXITS a slide via its last card, and the fix
    //    for the "sometimes traverses cards, sometimes jumps a whole slide"
    //    bug. Without it, backward card traversal stopped after one boundary.
    var target = current - 1;
    if (target < 0) return { type: 'none' };
    if (prevCount >= 2) return { type: 'goToFocusLast', index: target, lastCard: prevCount - 1 };
    return { type: 'goTo', index: target };
  },
};
