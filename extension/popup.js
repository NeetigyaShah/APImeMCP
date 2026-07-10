// popup.js

const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const counter = document.getElementById('counter');
const nameSection = document.getElementById('nameSection');
const nameInput = document.getElementById('nameInput');
const saveBtn = document.getElementById('saveBtn');
const status = document.getElementById('status');
const statusDot = document.getElementById('statusDot');

function setCounter(count) {
  counter.textContent = `${count} step${count === 1 ? '' : 's'} captured`;
}

function setStatus(text, kind) {
  status.textContent = text;
  status.className = kind || '';
}

function setRecordingUI(isRecording) {
  recordBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;
  statusDot.classList.toggle('recording', isRecording);
  if (isRecording) {
    nameSection.style.display = 'none';
  }
}

// Reflect current state on popup open, in case it was closed mid-recording.
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (!response) return;
  setRecordingUI(response.recording);
  setCounter(response.stepCount);
});

function originPatternFor(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch (e) {
    return null;
  }
}

recordBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pattern = tab && tab.url ? originPatternFor(tab.url) : null;
  if (!pattern) {
    setStatus('Cannot record this page (not a normal http/https tab).', 'error');
    return;
  }

  // Ask for access to just THIS site, right now, as a direct result of the user's
  // click - Chrome requires a user gesture for permissions.request() and will show
  // its own native "Allow <extension> to read your data on <site>?" prompt. We never
  // hold a standing grant across every site the way host_permissions would.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (e) {
    granted = false;
  }
  if (!granted) {
    setStatus('Permission denied - cannot record this page without it.', 'error');
    return;
  }

  chrome.runtime.sendMessage({ type: 'START_RECORDING' });
  setRecordingUI(true);
  setCounter(0);
  setStatus('');
});

stopBtn.addEventListener('click', () => {
  stopBtn.disabled = true;
  nameSection.style.display = 'block';
  nameInput.focus();
});

saveBtn.addEventListener('click', () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = nameInput.value.trim() || `recording-${timestamp}`;
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING', name });
  setStatus('Saving...', '');
  statusDot.classList.remove('recording');
  recordBtn.disabled = false;
  saveBtn.disabled = true;
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STEP_COUNT_UPDATE') {
    setCounter(message.count);
  } else if (message.type === 'RECORDING_SAVED') {
    saveBtn.disabled = false;
    nameSection.style.display = 'none';
    nameInput.value = '';
    const skipped = message.cookieDomainsSkipped && message.cookieDomainsSkipped.length
      ? ` (no cookie access granted for: ${message.cookieDomainsSkipped.join(', ')})`
      : '';
    if (message.success) {
      setStatus(
        `Saved. templateId: ${message.templateId} (${message.verified ? 'verified OK' : 'verification failed'})${skipped}`,
        'success'
      );
    } else if (message.error) {
      const isConnRefused = /fetch|network|failed to fetch/i.test(message.error);
      setStatus(
        isConnRefused
          ? 'Could not reach APImeMCP at 127.0.0.1:3000 - is it running?'
          : `Save failed: ${message.error}`,
        'error'
      );
    } else {
      setStatus('Save failed.', 'error');
    }
  }
});
