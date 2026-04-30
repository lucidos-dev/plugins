/* ══════════════════════════════════════════════
   Super Slides — Reusable Components
   ══════════════════════════════════════════════
   Pure functions returning HTML strings.
   
   RULE: .slides files contain ZERO CSS.
   All styling is handled here and in styles.css.
   Semantic props (mt, mb, align, color, size, etc.)
   map to utility classes.
   ══════════════════════════════════════════════ */

const SS = {};

// ── Custom component registry ──

SS._customComponents = {};

SS.registerComponent = (name, renderFn) => {
  SS._customComponents[name] = renderFn;
};

// ── Utility: build class list from semantic props ──

SS._classes = (base, node) => {
  const c = Array.isArray(base) ? [...base] : [base];
  if (node.mt) c.push('mt-' + node.mt);
  if (node.mb) c.push('mb-' + node.mb);
  if (node.align) c.push('align-' + node.align);
  if (node.gap) c.push('gap-' + node.gap);
  return c.filter(Boolean).join(' ');
};

// ── Editable wrapper: wraps text in a span with edit data attrs ──

SS._editable = (text, path, prop) => {
  if (!path) return text;
  return `<span class="ss-editable" data-ss-path="${path}" data-ss-prop="${prop}">${text}</span>`;
};

// ── Tags ──

SS.tag = (text, color, path) => {
  const editAttr = path ? ` data-ss-path="${path}" data-ss-prop="text"` : '';
  const editCls = path ? ' ss-editable' : '';
  return `<span class="tag tag-${color}${editCls}"${editAttr}>${text}</span>`;
};

// ── Slide header (tag + h2 + subtitle) ──

SS.slideHeader = (tagHtml, title, subtitle, path) => {
  const titleAttr = path ? ` data-ss-path="${path}" data-ss-prop="title"` : '';
  const titleCls = path ? ' ss-editable' : '';
  const subAttr = path ? ` data-ss-path="${path}" data-ss-prop="subtitle"` : '';
  const subCls = path ? ' ss-editable' : '';
  return `<div class="slide-header">
    ${tagHtml}
    <h2 class="${titleCls}"${titleAttr}>${title}</h2>
    <p class="subtitle${subCls}"${subAttr}>${subtitle}</p>
  </div>`;
};

// ── Cards ──

SS.card = (content, node = {}) => {
  const classes = ['card'];
  if (node.highlight) classes.push('highlight-' + node.highlight);
  if (node.className) classes.push(node.className);
  if (node.mt) classes.push('mt-' + node.mt);
  if (node.mb) classes.push('mb-' + node.mb);
  if (node.align) classes.push('ta-' + node.align);
  return `<div class="${classes.join(' ')}">${content}</div>`;
};

// ── Layout ──

SS.columns = (items, node = {}) =>
  `<div class="${SS._classes('columns', node)}">${items.join('')}</div>`;

SS.threeCol = (items, node = {}) =>
  `<div class="${SS._classes('three-col', node)}">${items.join('')}</div>`;

SS.fourCol = (items, node = {}) =>
  `<div class="${SS._classes('four-col', node)}">${items.join('')}</div>`;

// ── Insight ──

SS.insight = (content, color, path) => {
  const editAttr = path ? ` data-ss-path="${path}" data-ss-prop="text"` : '';
  const editCls = path ? ' ss-editable' : '';
  return `<div class="insight${color ? ' insight-' + color : ''}"><p class="${editCls}"${editAttr}>${content}</p></div>`;
};

// ── Icon ──

SS.icon = (emoji) =>
  `<span class="icon-large">${emoji}</span>`;

// ── Unordered list ──

SS.list = (items, path) => {
  if (path) {
    return `<ul>${items.map((item, i) =>
      `<li class="ss-editable" data-ss-path="${path}" data-ss-prop="items[${i}]">${item}</li>`
    ).join('')}</ul>`;
  }
  return `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
};

// ── Skill chips ──

SS.skillChips = (chips, path) => {
  if (path) {
    return `<div class="skill-chips">${chips.map((c, i) =>
      `<span class="skill-chip ss-editable" data-ss-path="${path}" data-ss-prop="chips[${i}]">${c}</span>`
    ).join('')}</div>`;
  }
  return `<div class="skill-chips">${chips.map(c => `<span class="skill-chip">${c}</span>`).join('')}</div>`;
};

// ── Pipeline ──

SS.pipeline = (steps) =>
  `<div class="pipeline">${steps.join('')}</div>`;

SS.pipelineStep = (icon, label, ownerClass, ownerLabel, sub, path) =>
  `<div class="pipeline-step">
    <span class="step-icon">${SS._editable(icon, path, 'icon')}</span>
    <span class="step-label">${SS._editable(label, path, 'label')}</span>
    <span class="step-owner ${ownerClass}">${SS._editable(ownerLabel, path, 'ownerLabel')}</span>
    <span class="step-sub">${SS._editable(sub, path, 'sub')}</span>
  </div>`;

// ── Takeaways ──

SS.takeawayList = (items) =>
  `<div class="takeaway-list">${items.join('')}</div>`;

SS.takeawayItem = (num, title, body, path) =>
  `<div class="takeaway-item">
    <span class="takeaway-num">${SS._editable(num, path, 'num')}</span>
    <div><h3>${SS._editable(title, path, 'title')}</h3><p>${SS._editable(body, path, 'body')}</p></div>
  </div>`;

// ── Event Sourcing flow ──

SS.esFlow = (events, path) => {
  if (path) {
    return `<div class="es-flow">${events.map((e, i) =>
      (i > 0 ? '<span class="es-arrow">→</span>' : '') +
      `<span class="es-event ss-editable" data-ss-path="${path}" data-ss-prop="events[${i}]">${e}</span>`
    ).join('')}</div>`;
  }
  return `<div class="es-flow">${events.map((e, i) =>
    (i > 0 ? '<span class="es-arrow">→</span>' : '') +
    `<span class="es-event">${e}</span>`
  ).join('')}</div>`;
};

// ── Tree / code block ──

SS.tree = (content) =>
  `<div class="tree">${content}</div>`;

// ── Team badge ──

SS.teamBadge = (text, path) => {
  const inner = SS._editable(text, path, 'text');
  return `<div class="team-badge"><div class="dot"></div><span>${inner}</span></div>`;
};

// ── VS label ──

SS.vsLabel = (text, path, color) => {
  const editAttr = path ? ` data-ss-path="${path}" data-ss-prop="text"` : '';
  const editCls = path ? ' ss-editable' : '';
  const colorCls = color ? ` c-${color}` : '';
  return `<p class="vs-label${colorCls}${editCls}"${editAttr}>${text}</p>`;
};

// ── Arch diagram (SVG wrapper) ──

SS.archDiagram = (svgContent) =>
  `<div class="arch-diagram">${svgContent}</div>`;

// ── Heading ──

SS.heading = (node, path) => {
  const tag = `h${node.level || 2}`;
  const classes = [];
  if (node.color) classes.push('c-' + node.color);
  if (node.size) classes.push('sz-' + node.size);
  if (node.mt) classes.push('mt-' + node.mt);
  if (node.mb) classes.push('mb-' + node.mb);
  const cls = classes.length ? ` class="${classes.join(' ')}"` : '';

  let content;
  if (node.sub) {
    // Wrap text and sub separately for independent editing
    content = SS._editable(node.text || '', path, 'text');
    content += ` <span class="heading-sub${node.subColor ? ' c-' + node.subColor : ''}">${SS._editable(node.sub, path, 'sub')}</span>`;
  } else if (path) {
    // No sub — make the whole heading editable
    content = node.text || '';
    // Add editable attrs to the heading tag itself
    const editCls = classes.length ? classes.join(' ') + ' ss-editable' : 'ss-editable';
    return `<${tag} class="${editCls}" data-ss-path="${path}" data-ss-prop="text">${content}</${tag}>`;
  } else {
    content = node.text || '';
  }

  return `<${tag}${cls}>${content}</${tag}>`;
};

// ── Text ──

SS.text = (node, path) => {
  const classes = [];
  if (node.color) classes.push('c-' + node.color);
  if (node.align) classes.push('ta-' + node.align);
  if (node.size) classes.push('sz-' + node.size);
  if (node.font === 'mono') classes.push('font-mono');
  if (node.weight) classes.push('fw-' + node.weight);
  if (node.mt) classes.push('mt-' + node.mt);
  if (node.mb) classes.push('mb-' + node.mb);
  if (node.leading) classes.push('leading-' + node.leading);
  if (path) classes.push('ss-editable');
  const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
  const editAttr = path ? ` data-ss-path="${path}" data-ss-prop="text"` : '';
  return `<p${cls}${editAttr}>${node.text || ''}</p>`;
};

// ── Stat ──

SS.stat = (node, path) => {
  const colorCls = node.color ? ' stat-' + node.color : '';
  let html = `<div class="stat-block${colorCls}">`;
  html += `<p class="stat-value${path ? ' ss-editable' : ''}"${path ? ` data-ss-path="${path}" data-ss-prop="value"` : ''}>${node.value}</p>`;
  if (node.label) html += `<p class="stat-label${path ? ' ss-editable' : ''}"${path ? ` data-ss-path="${path}" data-ss-prop="label"` : ''}>${node.label}</p>`;
  if (node.sublabel) html += `<p class="stat-sublabel${path ? ' ss-editable' : ''}"${path ? ` data-ss-path="${path}" data-ss-prop="sublabel"` : ''}>${node.sublabel}</p>`;
  html += '</div>';
  return html;
};

// ── Spacer ──

SS.spacer = (size) =>
  `<div class="spacer spacer-${size || 'md'}"></div>`;

// ── Node renderer (walks JSON trees → HTML) ──
// path: JSON path string for this node (e.g. "sections[0].slides[1].content[2]")

SS.renderNode = (node, path) => {
  if (!node) return '';

  // Check custom registry first
  if (SS._customComponents[node.type]) {
    return SS._customComponents[node.type](node, path);
  }

  const children = (node.children || []).map((child, i) =>
    SS.renderNode(child, path ? `${path}.children[${i}]` : null)
  );

  switch (node.type) {
    case 'slideHeader':
      return SS.slideHeader(
        SS.tag(node.tag.text, node.tag.color, path ? `${path}.tag` : null),
        node.title, node.subtitle, path
      );
    case 'card':
      return SS.card(children.join(''), node);
    case 'columns':
      return SS.columns(children, node);
    case 'threeCol':
      return SS.threeCol(children, node);
    case 'fourCol':
      return SS.fourCol(children, node);
    case 'insight':
      return SS.insight(node.text, node.color, path);
    case 'icon':
      return SS.icon(node.emoji);
    case 'list':
      return SS.list(node.items, path);
    case 'skillChips':
      return SS.skillChips(node.chips, path);
    case 'pipeline':
      return SS.pipeline(children);
    case 'pipelineStep':
      return SS.pipelineStep(node.icon, node.label, node.ownerClass, node.ownerLabel, node.sub, path);
    case 'takeawayList':
      return SS.takeawayList(children);
    case 'takeawayItem':
      return SS.takeawayItem(node.num, node.title, node.body, path);
    case 'esFlow':
      return SS.esFlow(node.events, path);
    case 'tree':
      return SS.tree(node.content);
    case 'teamBadge':
      return SS.teamBadge(node.text, path);
    case 'vsLabel':
      return SS.vsLabel(node.text, path, node.color);
    case 'archDiagram':
      return SS.archDiagram(node.content);
    case 'group': {
      const cls = SS._classes('group', node);
      return `<div class="${cls}">${children.join('')}</div>`;
    }

    // Semantic components
    case 'heading':
      return SS.heading(node, path);
    case 'text':
      return SS.text(node, path);
    case 'stat':
      return SS.stat(node, path);
    case 'spacer':
      return SS.spacer(node.size);
    case 'include':
      return node._resolved || `<!-- include not loaded: ${node.src} -->`;

    // Escape hatch — should be rare
    case 'html':
      return node.content;

    default:
      console.warn('Unknown node type:', node.type);
      return `<div class="ss-render-error">Unknown node type: <strong>${node.type || '(empty)'}</strong></div>`;
  }
};

// ── Error display ──

SS.showError = (title, message, detail, source) => {
  const app = document.getElementById('app');
  const overlay = document.createElement('div');
  overlay.className = 'ss-error-overlay';
  overlay.innerHTML = `
    <div class="ss-error-box">
      <span class="ss-error-icon">⚠</span>
      <h2>${title}</h2>
      <p class="ss-error-message">${message}</p>
      ${detail ? `<pre class="ss-error-detail">${detail}</pre>` : ''}
      ${source ? `<p class="ss-error-source">${source}</p>` : ''}
    </div>`;
  (app || document.body).appendChild(overlay);
};

// ── Presentation registry ──

window._superSlidesRegistry = [];

SS.registerPresentation = (presentation) => {
  window._superSlidesRegistry.push(presentation);
};

// ── Resolve include nodes (async, called during load) ──

SS._resolveIncludes = async (data, baseDir) => {
  const promises = [];

  function walk(nodes) {
    if (!nodes) return;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type === 'include' && node.src) {
        const idx = i;
        const arr = nodes;
        promises.push(
          lucidos.data.read(`${baseDir}/${node.src}`)
            .then(html => { arr[idx]._resolved = html; })
            .catch(() => { arr[idx]._resolved = `<!-- include not found: ${node.src} -->`; })
        );
      }
      if (node.children) walk(node.children);
    }
  }

  if (data.sections) {
    data.sections.forEach(sec => sec.slides.forEach(s => walk(s.content)));
  } else if (data.slides) {
    data.slides.forEach(s => walk(s.content));
  }

  await Promise.all(promises);
};

// ── Load custom components & styles for a presentation ──

SS._loadCustomAssets = async (presId, baseDir) => {
  // Clean up previous custom assets
  document.querySelectorAll('style[data-ss-custom]').forEach(el => el.remove());
  SS._customComponents = {};

  const presDir = `${baseDir}/${presId}`;

  // Load custom styles
  try {
    const css = await lucidos.data.read(`${presDir}/styles.css`);
    const el = document.createElement('style');
    el.dataset.ssCustom = presId;
    el.textContent = css;
    document.head.appendChild(el);
  } catch (e) { /* no custom styles */ }

  // Load custom components
  try {
    const js = await lucidos.data.read(`${presDir}/components.js`);
    new Function(js)();
  } catch (e) { /* no custom components */ }
};

// ── Load a JSON presentation file ──

SS.loadPresentation = async (path) => {
  let raw;
  try {
    raw = await lucidos.data.read(path);
  } catch (err) {
    SS.showError(
      'Failed to Load',
      `Could not read presentation file.`,
      err.message,
      path
    );
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const match = err.message.match(/position (\d+)/);
    let detail = err.message;
    if (match) {
      const pos = parseInt(match[1]);
      const snippet = raw.substring(Math.max(0, pos - 60), pos + 60);
      const arrow = ' '.repeat(Math.min(60, pos)) + '^^^';
      detail = err.message + '\n\n' + snippet + '\n' + arrow;
    }
    SS.showError(
      'Invalid JSON',
      'The presentation file contains malformed JSON.',
      detail,
      path
    );
    throw err;
  }

  // Resolve base directory for includes and custom assets
  const baseDir = path.substring(0, path.lastIndexOf('/'));

  // Artifact path for editing — already in SDK format
  const sourceFile = path;

  // Resolve include nodes
  await SS._resolveIncludes(data, `${baseDir}/${data.id}`);

  // Load custom components & styles
  await SS._loadCustomAssets(data.id, baseDir);

  // Build flat slide list with JSON path threading
  let flatSlides = [];
  let sections = null;

  if (data.sections && data.sections.length) {
    sections = [];
    data.sections.forEach((sec, secIdx) => {
      const startIndex = flatSlides.length;
      const rendered = sec.slides.map((s, slideIdx) => ({
        html: s.content ? s.content.map((n, i) =>
          SS.renderNode(n, `sections[${secIdx}].slides[${slideIdx}].content[${i}]`)
        ).join('') : '',
        hero: s.hero || false,
        title: s.title || undefined,
        notes: s.notes || '',
        cardNotes: Array.isArray(s.cardNotes) ? s.cardNotes.slice() : undefined,
        path: `sections[${secIdx}].slides[${slideIdx}]`,
      }));
      flatSlides.push(...rendered);
      sections.push({
        title: sec.title,
        color: sec.color || 'accent',
        startIndex,
        endIndex: flatSlides.length - 1,
        count: rendered.length,
      });
    });
  } else if (data.slides) {
    flatSlides = data.slides.map((s, slideIdx) => ({
      html: s.content ? s.content.map((n, i) =>
        SS.renderNode(n, `slides[${slideIdx}].content[${i}]`)
      ).join('') : '',
      hero: s.hero || false,
      title: s.title || undefined,
      notes: s.notes || '',
      cardNotes: Array.isArray(s.cardNotes) ? s.cardNotes.slice() : undefined,
      path: `slides[${slideIdx}]`,
    }));
  }

  const pres = {
    id: data.id,
    title: data.title,
    subtitle: data.subtitle,
    titleScroller: data.titleScroller,
    slides: flatSlides,
    sections: sections,
    sourceFile: sourceFile,
    rawData: data,
    sourceUrl: path,
  };

  SS.registerPresentation(pres);
  return pres;
};
