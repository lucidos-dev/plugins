// Shared component classes and touch-safe hover (workspace audit 2026-10-15):
//
//   badges  a rate card's status chip uses the host's .label tones, not a
//           badge the app draws itself, so it reads like every other chip
//   hover   every :hover rule sits inside @media (hover: hover), so the hover
//           state does not stick after a tap on a phone
import fs from 'fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
let passed = 0, failed = 0;
function check(name, got, want) {
  if (got === want) passed++;
  else { failed++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

// --- badges ------------------------------------------------------------------
check('the app draws no badge of its own', /rate-badge/.test(html), false);
check('in force is a success label', html.includes("'label label-success'"), true);
check('upcoming is a warning label', html.includes("'label label-warning'"), true);
check('an earlier card is a neutral label', html.includes("'label label-neutral'"), true);

// --- chips -------------------------------------------------------------------
// Chips are updated in place, never rebuilt with innerHTML on each render: a
// rebuild swaps the button under the pointer and its hover flickers.
const chipStart = html.indexOf('function renderChips()');
const chipFn = html.slice(chipStart, html.indexOf('\n      }\n', chipStart));
check('chips are not rebuilt on every render', /host\.dataset\.dims\s*!==/.test(chipFn), true);
check('chip state is toggled in place', /classList\.toggle\('on', on\)/.test(chipFn), true);

// --- dropdowns ---------------------------------------------------------------
// The time, producer and currency dropdowns have fixed widths, so a pick never
// resizes them and shoves the row.
for (const sel of ['.date-btn', '#producer-slot', '#currency-slot']) {
  const re = new RegExp(sel.replace('.', '\\.') + '\\s*\\{[^}]*width:\\s*[\\d.]+rem');
  check(`${sel} has a fixed width`, re.test(css), true);
}

// --- time range --------------------------------------------------------------
// Presets fill two free date inputs; editing a date flips the range to Custom.
for (const v of ['1', 'wtd', '7', 'mtd', '30', 'lastmonth', '90', 'qtd', 'ytd', '365', '0', 'custom']) {
  check(`range offers ${v}`, html.includes(`<option value="${v}"`), true);
}
check('a from date value', /<input type="hidden" id="range-from"/.test(html), true);
check('a to date value', /<input type="hidden" id="range-to"/.test(html), true);
check('Apply range commits Custom', /commit\('custom'/.test(html), true);
// The native date popup ignores the theme (2026-10-20), so the app draws its own.
check('no native date input in the range picker', /<input type="date" id="range-/.test(html), false);
check('two months side by side', /id="cal-grid-b"/.test(html), true);
check('a themed calendar', /id="cal-pop"/.test(html), true);

// --- hover -------------------------------------------------------------------
// Walk the stylesheet with a stack of block preludes. A :hover selector is safe
// only when some enclosing block is @media (hover: hover).
const stack = [];
let prelude = '', hovers = 0, exposed = [];
for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
  if (ch === '{') {
    const p = prelude.trim();
    if (p.includes(':hover')) {
      hovers++;
      if (!stack.some(s => /^@media\s*\(\s*hover\s*:\s*hover\s*\)/.test(s))) exposed.push(p);
    }
    stack.push(p);
    prelude = '';
  } else if (ch === '}') {
    stack.pop();
    prelude = '';
  } else if (ch === ';' ) {
    prelude = '';
  } else {
    prelude += ch;
  }
}
check('the stylesheet has hover rules to check', hovers > 0, true);
check('every :hover rule is inside @media (hover: hover)', exposed.join(' | '), '');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
