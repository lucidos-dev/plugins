/* ══════════════════════════════════════════════════════
   Super Slides: list layout tests
   ══════════════════════════════════════════════════════
   Every slide carries the `center` class. A bare <ul> inherited it,
   so each bullet line was centred and the bullets drifted with the
   text. A list must read like a list: left-aligned, inside the same
   content column as the slide header above it.
   ══════════════════════════════════════════════════════ */

suite('List layout', (t) => {
  function renderSlide() {
    const stage = document.getElementById('stage');
    stage.innerHTML = '<div class="slide center active" data-slide="0">'
      + SS.renderNode({ type: 'slideHeader', tag: { text: 'TAG', color: 'green' }, title: 'A title', subtitle: 'A subtitle' }, 'sections[0].slides[0].content[0]')
      + SS.renderNode({ type: 'list', items: ['A short line', 'A much longer line of text than the first one', 'Mid line'] }, 'sections[0].slides[0].content[1]')
      + '</div>';
    const slide = stage.querySelector('.slide');
    return {
      slide,
      header: slide.querySelector('.slide-header'),
      title: slide.querySelector('.slide-header h2, .slide-header h1, .slide-header .slide-title') || slide.querySelector('.slide-header'),
      ul: slide.querySelector('ul'),
      items: [...slide.querySelectorAll('li')],
    };
  }

  t.test('list items are left-aligned, not centred', () => {
    const { items } = renderSlide();
    items.forEach((li, i) => assertEqual(getComputedStyle(li).textAlign, 'left', 'li ' + i + ' text-align'));
  });

  t.test('every item starts at the same x, whatever its length', () => {
    const { items } = renderSlide();
    const lefts = items.map(li => {
      const r = document.createRange(); r.selectNodeContents(li);
      return Math.round(r.getClientRects()[0].left);
    });
    assertEqual(new Set(lefts).size, 1, 'text start x per item: ' + lefts.join(','));
  });

  t.test('the list sits in the header column', () => {
    const { header, ul } = renderSlide();
    const h = header.getBoundingClientRect(), u = ul.getBoundingClientRect();
    assert(Math.abs(h.left - u.left) <= 1, 'header left ' + h.left + ' vs list left ' + u.left);
  });

  t.test('the list carries its own class', () => {
    const { ul } = renderSlide();
    assert(ul.classList.contains('ss-list'), 'ul class: ' + ul.className);
  });
});
