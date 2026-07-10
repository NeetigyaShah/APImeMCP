// popup.js

const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const counter = document.getElementById('counter');
const nameSection = document.getElementById('nameSection');
const nameInput = document.getElementById('nameInput');
const saveBtn = document.getElementById('saveBtn');
const status = document.getElementById('status');

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

recordBtn.addEventListener('click', () => {
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
  recordBtn.disabled = false;
  saveBtn.disabled = true;
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'STEP_COUNT_UPDATE') {
    setCounter(message.count);
  } else if (message.type === 'RECORDING_SAVED') {
    saveBtn.disabled = false;
    if (message.success) {
      setStatus(
        `Saved. templateId: ${message.templateId} (${message.verified ? 'verified OK' : 'verification failed'})`,
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
