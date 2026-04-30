/* ══════════════════════════════════════════════════════
   Super Slides — Inline Editing
   ══════════════════════════════════════════════════════
   Click any text to edit it. Changes are saved back
   to the .slides JSON file directly via the Lucidos SDK.
   Disabled in fullscreen mode.

   Composite elements (containing spans, br, etc.) are
   NOT editable as a whole. Instead, each text-bearing
   child becomes its own editable node. On save, the
   entire composite's innerHTML is reconstructed and
   persisted.
   ══════════════════════════════════════════════════════ */

SS.initEditing = function () {
  let activeEditor = null;
  let isFullscreen = false;

  // Detect fullscreen (native + pseudo) — must check parent since app runs in iframe
  const parentDoc = window.parent !== window ? window.parent.document : document;

  function checkFullscreen() {
    isFullscreen = !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      parentDoc.fullscreenElement ||
      parentDoc.webkitFullscreenElement ||
      parentDoc.documentElement.hasAttribute('data-pseudo-fullscreen')
    );
    document.body.classList.toggle('ss-editing-disabled', isFullscreen);
  }

  document.addEventListener('fullscreenchange', checkFullscreen);
  document.addEventListener('webkitfullscreenchange', checkFullscreen);
  parentDoc.addEventListener('fullscreenchange', checkFullscreen);
  parentDoc.addEventListener('webkitfullscreenchange', checkFullscreen);
  new MutationObserver(checkFullscreen).observe(parentDoc.documentElement, {
    attributes: true, attributeFilter: ['data-pseudo-fullscreen']
  });
  checkFullscreen();

  // ── Activation: long-press (touch) / single click (desktop) ──

  let longPressTimer = null;
  let longPressTarget = null;
  let longPressReady = null; // Set to element when long-press detected, activated on touchend
  let longPressTouchX = 0, longPressTouchY = 0;
  let lastTouchTime = 0; // Suppress synthetic click after touch interactions
  const LONG_PRESS_MOVE_THRESHOLD = 15; // px — ignore micro-jitter during hold

  document.addEventListener('touchstart', (e) => {
    if (isFullscreen) return;
    const el = e.target.closest('.ss-editable');
    if (!el || el === activeEditor) return;
    longPressTarget = el;
    longPressReady = null;
    longPressTouchX = e.touches[0].clientX;
    longPressTouchY = e.touches[0].clientY;
    longPressTimer = setTimeout(() => {
      if (longPressTarget === el) {
        // Mark as ready — actual activation happens on touchend
        // so iOS treats focus() as a user gesture and opens the keyboard
        longPressReady = el;
        longPressTarget = null;
      }
    }, 500);
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', (e) => {
    if (!longPressTarget && !longPressReady) return;
    const dx = e.touches[0].clientX - longPressTouchX;
    const dy = e.touches[0].clientY - longPressTouchY;
    if (Math.abs(dx) > LONG_PRESS_MOVE_THRESHOLD || Math.abs(dy) > LONG_PRESS_MOVE_THRESHOLD) {
      clearTimeout(longPressTimer);
      longPressTarget = null;
      longPressReady = null;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    clearTimeout(longPressTimer);
    lastTouchTime = Date.now();
    if (longPressReady) {
      // Activate now — touchend is a user gesture, so iOS will open the keyboard
      e.preventDefault();
      e.stopPropagation();
      const el = longPressReady;
      longPressReady = null;
      longPressTarget = null;
      activateEditor(el);
      return;
    }
    // If actively editing, suppress touchend from reaching nav
    if (e.target.closest('.ss-editing')) {
      e.stopPropagation();
    }
    longPressTarget = null;
  }, { capture: true });

  // Desktop: single click to edit (suppressed on touch devices — use long-press)
  document.addEventListener('click', (e) => {
    if (isFullscreen) return;
    // Ignore synthetic clicks fired after touch events (within 500ms)
    if (Date.now() - lastTouchTime < 500) return;
    const el = e.target.closest('.ss-editable');
    if (!el || el === activeEditor) return;
    e.stopPropagation();
    e.preventDefault();
    activateEditor(el);
  }, true);

  // Check if element contains complex HTML that shouldn't be edited as a single block.
  // Only simple formatting (strong, em, code) is allowed for whole-element editing.
  function hasComplexHtml(el) {
    const children = el.querySelectorAll('*');
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      if (tag !== 'strong' && tag !== 'em' && tag !== 'code') return true;
    }
    return false;
  }

  // Walk up through (possibly nested) composite parents to find the root
  // composite — the one that actually has data-ss-path and data-ss-prop.
  function findRootComposite(el) {
    let parent = el.closest('[data-ss-composite]');
    while (parent) {
      if (parent.dataset.ssPath && parent.dataset.ssProp) return parent;
      parent = parent.parentElement?.closest('[data-ss-composite]');
    }
    return null;
  }

  function activateEditor(el) {
    // Close any existing editor first
    if (activeEditor) commitEdit(activeEditor);

    let path = el.dataset.ssPath;
    let prop = el.dataset.ssProp;

    // Check if this is a fragment inside a composite element
    const compositeParent = findRootComposite(el);

    if (!path || !prop) {
      // No path on this element — must be a fragment child of a composite
      if (compositeParent) {
        path = compositeParent.dataset.ssPath;
        prop = compositeParent.dataset.ssProp;
      } else {
        return; // No path and no composite parent — can't edit
      }
    } else if (hasComplexHtml(el)) {
      // Element has its own path but contains complex HTML —
      // it should have been set up as a composite. Don't edit as a whole.
      return;
    }

    // Store resolved path/prop and original content
    el.dataset.ssResPath = path;
    el.dataset.ssResProp = prop;
    el.dataset.ssOriginal = el.innerHTML;
    el.dataset.ssOriginalText = el.innerText;

    if (compositeParent) {
      el.dataset.ssIsFragment = 'true';
    }

    // Make contenteditable
    el.contentEditable = 'true';
    el.classList.add('ss-editing');
    el.focus();
    activeEditor = el;

    // Select all text
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    // Handle keyboard
    el.addEventListener('keydown', onEditorKey);
    el.addEventListener('blur', onEditorBlur);
  }

  function onEditorKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.target.blur(); // triggers commit via blur
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit(e.target);
    }
    // Stop arrow keys from navigating slides while editing
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) {
      e.stopPropagation();
    }
  }

  function onEditorBlur(e) {
    const el = e.target;
    // Small delay to let click-on-another-editable work
    setTimeout(() => {
      if (el === activeEditor) {
        commitEdit(el);
      }
    }, 100);
  }

  function cancelEdit(el) {
    if (el.dataset.ssOriginal !== undefined) {
      el.innerHTML = el.dataset.ssOriginal;
    }
    cleanupEditor(el);
  }

  function cleanupEditor(el) {
    el.contentEditable = 'false';
    el.classList.remove('ss-editing');
    el.removeEventListener('keydown', onEditorKey);
    el.removeEventListener('blur', onEditorBlur);
    delete el.dataset.ssOriginal;
    delete el.dataset.ssOriginalText;
    delete el.dataset.ssResPath;
    delete el.dataset.ssResProp;
    delete el.dataset.ssIsFragment;
    if (activeEditor === el) activeEditor = null;
  }

  function commitEdit(el) {
    const path = el.dataset.ssResPath;
    const prop = el.dataset.ssResProp;
    const originalText = el.dataset.ssOriginalText;
    const newText = el.innerText;
    const isFragment = el.dataset.ssIsFragment === 'true';
    const compositeParent = isFragment ? findRootComposite(el) : null;

    cleanupEditor(el);

    // No change — skip
    if (newText === originalText) return;

    // If a fragment was emptied, remove its surrounding element entirely
    if (isFragment && newText.trim() === '') {
      el.remove();
      // Also clean up any orphaned <br> tags that were adjacent separators
      if (compositeParent) {
        // Remove leading/trailing <br>s and consecutive <br>s
        const kids = Array.from(compositeParent.childNodes);
        for (let i = kids.length - 1; i >= 0; i--) {
          const k = kids[i];
          if (k.nodeName === 'BR') {
            const prev = kids[i - 1];
            const next = kids[i + 1];
            // Remove if first, last, or next to another BR
            if (!prev || !next || prev.nodeName === 'BR' || next.nodeName === 'BR') {
              k.remove();
            }
          }
        }
      }
    }

    // Build the full JSON path
    let fullPath;
    if (prop.includes('[')) {
      fullPath = `${path}.${prop}`;
    } else {
      fullPath = `${path}.${prop}`;
    }

    // Determine the value to save
    let newValue;
    if (compositeParent) {
      // Fragment edit: save the entire composite parent's innerHTML,
      // but strip any editing artifacts we added (classes, attributes)
      const clone = compositeParent.cloneNode(true);
      clone.querySelectorAll('.ss-editable, .ss-editing, .ss-saved').forEach(c => {
        c.classList.remove('ss-editable', 'ss-editing', 'ss-saved');
        c.removeAttribute('contenteditable');
      });
      // Clean up empty class attributes left behind
      clone.querySelectorAll('[class=""]').forEach(c => c.removeAttribute('class'));
      newValue = clone.innerHTML;
    } else {
      // Simple element: save the plain text
      newValue = newText;
    }

    // Flash save indicator
    el.classList.add('ss-saved');
    setTimeout(() => el.classList.remove('ss-saved'), 800);

    // Get current presentation info
    const pres = SS._currentPres;
    if (!pres || !pres.sourceFile) {
      console.warn('No source file for current presentation');
      return;
    }

    // Save via Lucidos events API
    saveEdit(pres.sourceFile, fullPath, newValue);
  }

  async function saveEdit(sourceFile, jsonPath, newValue) {
    try {
      await lucidos.data.edit(sourceFile, [
        { json_path: jsonPath, json_value: newValue }
      ]);
      console.log(`[SS Edit] Saved: ${jsonPath} = "${String(newValue).substring(0, 50)}..."`);
    } catch (err) {
      console.error('[SS Edit] Failed to save:', err);
    }
  }

  // ── Composite element setup ──
  // After each render, find elements with complex HTML (spans, br, etc.)
  // and set them up as composites: the parent becomes non-editable, and
  // each text-bearing child becomes its own editable node.

  function setupCompositeEditables() {
    document.querySelectorAll('.ss-editable').forEach(el => {
      if (hasComplexHtml(el)) {
        // Remove editable from the parent — it shouldn't be edited as a whole
        el.classList.remove('ss-editable');
        // Mark as composite so children can find their path/prop
        el.setAttribute('data-ss-composite', '');
        // Make each text-bearing child individually editable
        makeChildrenEditable(el);
      }
    });
    // Also process any new composites that haven't had children wired up yet
    // (e.g. after a presentation switch that re-rendered the DOM)
    document.querySelectorAll('[data-ss-composite]').forEach(el => {
      if (!el.querySelector('.ss-editable')) {
        makeChildrenEditable(el);
      }
    });
  }

  function makeChildrenEditable(composite) {
    // First pass: wrap bare text nodes in <span> so they become elements
    const childNodes = Array.from(composite.childNodes);
    for (const node of childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) {
        const wrapper = document.createElement('span');
        wrapper.textContent = node.textContent;
        node.replaceWith(wrapper);
      }
    }
    // Second pass: make all element children (except <br>) editable
    for (const child of composite.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'br') continue;
      if (child.textContent.trim().length > 0) {
        child.classList.add('ss-editable');
      }
    }
  }

  // Run on structural DOM changes (presentation load/switch) and initial load.
  // Only watches childList — attribute changes (class toggles, styles) are ignored.
  let compositeTimer = null;
  new MutationObserver((mutations) => {
    // Only process if actual nodes were added (not just class/attr changes)
    const hasNewNodes = mutations.some(m => m.addedNodes.length > 0);
    if (!hasNewNodes) return;
    if (compositeTimer) clearTimeout(compositeTimer);
    compositeTimer = setTimeout(() => {
      compositeTimer = null;
      setupCompositeEditables();
    }, 150);
  }).observe(document.getElementById('app') || document.body, {
    childList: true, subtree: true
  });
  setupCompositeEditables();

  // ── Public API ──

  SS.isEditing = () => activeEditor !== null;
  SS.cancelEditing = () => { if (activeEditor) cancelEdit(activeEditor); };
};
