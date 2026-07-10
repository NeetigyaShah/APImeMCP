// content-script.js
// Injected on-demand by background.js (NOT declared in manifest.json content_scripts).
// Captures clicks and value changes, sends them to background.js as STEP_CAPTURED messages.
// Security: never uses innerHTML/eval on page-derived data; only reads plain string
// text/attribute values and sends them as data inside chrome.runtime messages.

if (window.__apimemcpRecorderInjected) {
  // no-op: already attached in this document
} else {
  window.__apimemcpRecorderInjected = true;

  function attrSelector(el) {
    // (a) data-testid on the element or a close ancestor (up to 3 levels)
    let node = el;
    for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
      const testId = node.getAttribute && node.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId}"]`;
    }
    return null;
  }

  function idSelector(el) {
    // (b) #id
    if (el.id && el.id.trim()) return `#${el.id.trim()}`;
    return null;
  }

  function textSelector(el) {
    // (c) role+text heuristic: tag:has-text("trimmed text, max 40 chars")
    const text = (el.innerText || '').trim();
    if (text && text.length > 0 && text.length <= 40) {
      const tag = el.tagName.toLowerCase();
      return `${tag}:has-text("${text}")`;
    }
    return null;
  }

  function positionalSelector(el) {
    // (d) walk up to 3 ancestors collecting tag + nth-of-type
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node && node.nodeType === 1; i++, node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      let nth = 1;
      let sibling = node;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === node.tagName) nth++;
      }
      parts.unshift(`${tag}:nth-of-type(${nth})`);
    }
    return parts.join(' > ') || null;
  }

  function buildSelectors(el) {
    const selectors = [];
    const a = attrSelector(el);
    if (a) selectors.push(a);
    const b = idSelector(el);
    if (b) selectors.push(b);
    const c = textSelector(el);
    if (c) selectors.push(c);
    const d = positionalSelector(el);
    if (d) selectors.push(d);
    return selectors;
  }

  function send(step) {
    try {
      chrome.runtime.sendMessage({ type: 'STEP_CAPTURED', step });
    } catch (e) {
      // ponytail: extension context can be invalidated mid-navigation; drop silently
    }
  }

  document.addEventListener(
    'click',
    (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1) return;
      const selectors = buildSelectors(el);
      send({ type: 'click', selectors });
    },
    true
  );

  document.addEventListener(
    'change',
    (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return;
      const selectors = buildSelectors(el);
      const type = tag === 'select' ? 'select' : 'fill';
      send({ type, selectors, value: el.value });
    },
    true
  );
}
