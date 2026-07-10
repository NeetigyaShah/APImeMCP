// background.js (MV3 service worker) - message hub between popup and content-script.

const RECORDINGS_ENDPOINT = 'http://127.0.0.1:3000/api/recordings';

let recording = false;
let steps = [];
let startUrl = null;
let visitedDomains = new Set();
let recordingTabId = null;

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // ponytail: popup may be closed, sendMessage with no receiver rejects - harmless
  });
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
  } catch (e) {
    // ponytail: injection can fail on chrome:// or other restricted pages - ignore
  }
}

async function startRecording() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  recording = true;
  steps = [];
  startUrl = tab && tab.url ? tab.url : null;
  visitedDomains = new Set();
  recordingTabId = tab ? tab.id : null;

  if (startUrl) {
    try {
      visitedDomains.add(new URL(startUrl).hostname);
    } catch (e) {
      // ignore unparsable url
    }
  }

  if (recordingTabId != null) {
    await injectContentScript(recordingTabId);
  }
}

async function getCookiesForDomains(domains) {
  const all = [];
  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      all.push(...cookies);
    } catch (e) {
      // ponytail: skip domains that error out
    }
  }
  // de-duplicate by name+domain+path
  const seen = new Set();
  const deduped = [];
  for (const c of all) {
    const key = `${c.name}|${c.domain}|${c.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(c);
    }
  }
  return deduped;
}

async function stopRecording(name) {
  recording = false;
  const cookies = await getCookiesForDomains(visitedDomains);

  let result;
  try {
    const res = await fetch(RECORDINGS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, startUrl, steps, cookies }),
    });
    const json = await res.json();
    result = { type: 'RECORDING_SAVED', ...json };
  } catch (err) {
    result = { type: 'RECORDING_SAVED', success: false, error: err.message || String(err) };
  }

  broadcast(result);
}

chrome.webNavigation.onCommitted.addListener((details) => {
  // frameId 0 is the top-level frame; without this check, any iframe on the page
  // (ads, embeds, etc.) navigating would get recorded as a top-level 'navigate' step,
  // and replaying it would page.goto() the whole browser to what was really just an
  // iframe's URL - corrupting the rest of the sequence.
  if (!recording || details.tabId !== recordingTabId || details.frameId !== 0) return;
  steps.push({ type: 'navigate', url: details.url });
  try {
    visitedDomains.add(new URL(details.url).hostname);
  } catch (e) {
    // ignore unparsable url
  }
  broadcast({ type: 'STEP_COUNT_UPDATE', count: steps.length });
  injectContentScript(details.tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'STEP_CAPTURED':
      steps.push(message.step);
      broadcast({ type: 'STEP_COUNT_UPDATE', count: steps.length });
      break;
    case 'GET_STATE':
      sendResponse({ recording, stepCount: steps.length });
      break;
    case 'START_RECORDING':
      startRecording();
      break;
    case 'STOP_RECORDING':
      stopRecording(message.name);
      break;
    default:
      break;
  }
  return true;
});
