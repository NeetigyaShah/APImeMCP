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

  // On-page HUD: the extension's toolbar popup closes the instant you click
  // anywhere on the page (standard browser behavior for action popups), so it
  // can't show live progress while you're actually interacting. This floating
  // panel lives in the page itself instead, and survives that.
  function createHud() {
    const host = document.createElement('div');
    host.id = '__apimemcp_hud_host';
    host.style.cssText = 'all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .panel {
          font-family: ui-monospace, Consolas, Menlo, monospace;
          font-size: 12px;
          width: 240px;
          background: #14100a;
          color: #d8c9a8;
          border: 1px solid #3a2f1f;
          border-radius: 6px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          overflow: hidden;
        }
        .bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #241d14; border-bottom: 1px solid #3a2f1f; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff5f56; animation: pulse 1.4s ease-in-out infinite; flex-shrink: 0; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .title { font-weight: 600; color: #ffb627; }
        .body { padding: 8px 10px; }
        .count { color: #7a6a4e; margin-bottom: 6px; }
        input {
          width: 100%; box-sizing: border-box; padding: 5px 6px; margin-bottom: 6px;
          border-radius: 3px; border: 1px solid #3a2f1f; background: #1e1811; color: #d8c9a8;
          font-family: inherit; font-size: 11px;
        }
        button {
          width: 100%; padding: 6px; border-radius: 3px; cursor: pointer;
          border: 1px solid #7fd858; background: transparent; color: #7fd858;
          font-family: inherit; font-size: 11px; font-weight: 600;
        }
        button:hover { background: #7fd858; color: #14100a; }
        .status { margin-top: 6px; color: #7fd858; }
        .status.error { color: #ff5f56; }
      </style>
      <div class="panel">
        <div class="bar"><span class="dot"></span><span class="title">APImeMCP Recorder</span></div>
        <div class="body">
          <div class="count" id="count">0 steps captured</div>
          <input id="name" type="text" placeholder="Recording name (optional)" />
          <button id="stop">Stop &amp; Save</button>
          <div class="status" id="status"></div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(host);

    const countEl = root.getElementById('count');
    const nameEl = root.getElementById('name');
    const statusEl = root.getElementById('status');
    const stopBtn = root.getElementById('stop');

    stopBtn.addEventListener('click', () => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = nameEl.value.trim() || `recording-${timestamp}`;
      stopBtn.disabled = true;
      statusEl.textContent = 'Saving...';
      statusEl.className = 'status';
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING', name });
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'STEP_COUNT_UPDATE') {
        countEl.textContent = `${message.count} step${message.count === 1 ? '' : 's'} captured`;
      } else if (message.type === 'RECORDING_SAVED') {
        if (message.success) {
          statusEl.textContent = `Saved (templateId: ${message.templateId})`;
          statusEl.className = 'status';
          setTimeout(() => host.remove(), 2500);
        } else {
          statusEl.textContent = message.error || 'Save failed.';
          statusEl.className = 'status error';
          stopBtn.disabled = false;
        }
      }
    });

    // Re-injected after a navigation mid-recording - sync the real count from
    // background instead of starting back at 0.
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      if (response && typeof response.stepCount === 'number') {
        countEl.textContent = `${response.stepCount} step${response.stepCount === 1 ? '' : 's'} captured`;
      }
    });
  }

  createHud();

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
