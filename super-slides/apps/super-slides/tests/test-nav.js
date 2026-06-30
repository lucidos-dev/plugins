/* ══════════════════════════════════════════════════════
   Super Slides — Arrow navigation tests
   ══════════════════════════════════════════════════════
   Locks in the traversal rules in SS.navLogic.arrowNav —
   in particular that Left is the exact inverse of Right.

   The historical bug: Left walked back through cards only
   while a card was already focused; once focus dropped it
   jumped whole slides and never entered the previous slide's
   cards. So after one backward boundary crossing, card
   traversal silently stopped — "sometimes traverses cards,
   sometimes jumps to a whole slide".
   ══════════════════════════════════════════════════════ */

/* A tiny synchronous deck model that applies arrowNav action descriptors.
   `cardCounts[i]` = number of focusable cards on slide i (0 or 1 = not
   walkable, >= 2 = multi-card). No DOM, no timers — the deferred focus of
   `goToFocusLast` is applied immediately (transitions don't exist here). */
function makeDeck(cardCounts) {
  const state = { current: 0, focusedCardIndex: -1 };

  function press(direction) {
    const action = SS.navLogic.arrowNav({
      current: state.current,
      slideCount: cardCounts.length,
      focusedCardIndex: state.focusedCardIndex,
      cardCount: cardCounts[state.current] || 0,
      prevSlideCardCount: state.current > 0 ? (cardCounts[state.current - 1] || 0) : 0,
    }, direction);

    switch (action.type) {
      case 'focusCard':
        state.focusedCardIndex = action.index;
        break;
      case 'clearCardFocus':
        state.focusedCardIndex = -1;
        break;
      case 'goTo':
        // Mirror goTo()'s bounds guard: out-of-range is a no-op.
        if (action.index >= 0 && action.index < cardCounts.length && action.index !== state.current) {
          state.current = action.index;
          state.focusedCardIndex = -1;
        }
        break;
      case 'goToFocusLast':
        if (action.index >= 0 && action.index < cardCounts.length && action.index !== state.current) {
          state.current = action.index;
          state.focusedCardIndex = -1;
          // Deferred-in-prod, immediate here:
          state.focusedCardIndex = action.lastCard;
        }
        break;
      case 'none':
        break;
      default:
        throw new Error('unknown action type: ' + action.type);
    }
    return action;
  }

  return {
    state,
    press,
    pos() { return state.current + ':' + state.focusedCardIndex; },
  };
}

suite('Arrow navigation — forward expansion', (t) => {
  t.test('Right walks every card then advances slide', () => {
    const d = makeDeck([3, 2]); // slide 0: 3 cards, slide 1: 2 cards
    assertEqual(d.pos(), '0:-1', 'start');
    d.press('right'); assertEqual(d.pos(), '0:0', '→ card 0');
    d.press('right'); assertEqual(d.pos(), '0:1', '→ card 1');
    d.press('right'); assertEqual(d.pos(), '0:2', '→ card 2 (last)');
    d.press('right'); assertEqual(d.pos(), '1:-1', '→ next slide, no card');
    d.press('right'); assertEqual(d.pos(), '1:0', '→ card 0 of slide 1');
  });

  t.test('Right on a no-card slide jumps straight to next slide', () => {
    const d = makeDeck([0, 3]);
    d.press('right'); assertEqual(d.pos(), '1:-1', 'advanced past empty slide');
  });
});

suite('Arrow navigation — backward is the exact inverse', (t) => {
  t.test('Left enters the previous slide at its LAST card (the bug)', () => {
    const d = makeDeck([3, 2]);
    // Land on slide 1 with no card focused — the state where the old code broke.
    d.press('right'); d.press('right'); d.press('right'); // 0:2
    d.press('right'); assertEqual(d.pos(), '1:-1', 'on slide 1, no card');
    // Left must cross back AND enter slide 0 at its last card (index 2),
    // not jump to slide 0 with no focus.
    d.press('left'); assertEqual(d.pos(), '0:2', 'entered prev slide at last card');
    d.press('left'); assertEqual(d.pos(), '0:1', 'back through cards');
    d.press('left'); assertEqual(d.pos(), '0:0', 'card 0');
    d.press('left'); assertEqual(d.pos(), '0:-1', 'drop focus, stay on slide');
    d.press('left'); assertEqual(d.pos(), '0:-1', 'at first slide: no-op');
  });

  t.test('Right K times then Left K times returns to the exact start', () => {
    // Mixed deck: multi-card, no-card, single-card, multi-card.
    const d = makeDeck([3, 0, 1, 2]);
    const visited = [];
    // Walk all the way forward, recording each position.
    let prev = null;
    for (let i = 0; i < 50; i++) {
      visited.push(d.pos());
      d.press('right');
      if (d.pos() === prev) break; // reached the end (no movement)
      prev = d.pos();
    }
    const forward = visited.slice();
    // Now walk all the way back; positions must reverse exactly.
    const back = [d.pos()];
    for (let i = 0; i < 50; i++) {
      const before = d.pos();
      d.press('left');
      if (d.pos() === before) break;
      back.push(d.pos());
    }
    back.reverse();
    // The backward path (reversed) must equal the forward path.
    assertDeepEqual(back, forward, 'left sequence mirrors right sequence');
    assertEqual(d.pos(), '0:-1', 'ended back at the very start');
  });

  t.test('Left skips a no-card slide cleanly', () => {
    const d = makeDeck([2, 0, 2]);
    // Forward to slide 2, no card.
    d.press('right'); d.press('right'); // 0:0, 0:1
    d.press('right'); assertEqual(d.pos(), '1:-1', 'slide 1 (no cards)');
    d.press('right'); assertEqual(d.pos(), '2:-1', 'slide 2 (cards), arrived via no-card slide');
    d.press('right'); assertEqual(d.pos(), '2:0', 'card 0 of slide 2');
    // Back: walk slide 2 cards, then cross the empty slide 1, into slide 0's last card.
    d.press('left'); assertEqual(d.pos(), '2:-1', 'drop focus on slide 2');
    d.press('left'); assertEqual(d.pos(), '1:-1', 'back to empty slide 1');
    d.press('left'); assertEqual(d.pos(), '0:1', 'into slide 0 at last card');
  });
});
