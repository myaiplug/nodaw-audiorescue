import {
  estimateWavDurationSec,
  MAX_BYTES,
  MAX_SECONDS,
  validateAudioHeaders,
} from './audioValidate.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const token = (params.get('token') || '').trim();
const caseId = (params.get('case') || '').trim();
const sessionId = (params.get('session_id') || '').trim();

const drop = $('drop');
const fileInput = $('file');
const errorEl = $('error');
const statusEl = $('status');
const successEl = $('success');
const metaEl = $('meta');
const picker = $('picker');

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add('show');
  statusEl.textContent = '';
}

function clearError() {
  errorEl.classList.remove('show');
  errorEl.textContent = '';
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

async function decodeDurationSec(buf) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio is not available in this browser.');
  const ctx = new AC();
  try {
    const audio = await ctx.decodeAudioData(buf.slice(0));
    return audio.duration;
  } finally {
    try { await ctx.close(); } catch (_) { /* ignore */ }
  }
}

if (caseId) {
  $('case-id').textContent = caseId;
  metaEl.hidden = false;
}

if (!token) {
  picker.hidden = true;
  if (sessionId) {
    showError('Payment landed. This page still needs the one-time upload token from your confirmation link (upload.html?token=…).');
  } else {
    showError('Missing upload token. Use the one-time link from your deposit confirmation.');
  }
} else {
  fileInput.disabled = false;
}

function setBusy(busy) {
  drop.classList.toggle('busy', busy);
  fileInput.disabled = busy || !token;
}

drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (token) drop.classList.add('hot');
});
drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('hot');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) void handleFile(file);
});
fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  if (file) void handleFile(file);
  fileInput.value = '';
});

async function handleFile(file) {
  if (!token) return;
  clearError();
  statusEl.textContent = 'Checking file…';
  setBusy(true);
  try {
    if (file.size > MAX_BYTES) {
      showError('File exceeds 50 MB limit.');
      return;
    }
    const bytes = await file.arrayBuffer();
    const header = validateAudioHeaders(bytes, file.name);
    if (!header.ok) {
      showError(header.error);
      return;
    }
    if (header.format === 'wav') {
      const est = header.durationSec ?? estimateWavDurationSec(bytes);
      if (est != null && est > MAX_SECONDS) {
        showError('File is ' + fmtDuration(est) + '. Max is 5:00.');
        return;
      }
    }

    statusEl.textContent = 'Decoding duration…';
    let durationSec;
    try {
      durationSec = await decodeDurationSec(bytes);
    } catch (_) {
      showError('Could not decode audio. Send a real MP3 or WAV.');
      return;
    }
    if (durationSec > MAX_SECONDS) {
      showError('File is ' + fmtDuration(durationSec) + '. Max is 5:00.');
      return;
    }

    statusEl.textContent =
      file.name + ' · ' + fmtSize(file.size) + ' · ' + fmtDuration(durationSec) + ' — uploading…';

    const form = new FormData();
    form.append('file', file);
    form.append('token', token);
    form.append('durationSec', String(durationSec));

    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: form,
    });
    let body = {};
    try { body = await res.json(); } catch (_) { /* ignore */ }
    if (!res.ok) {
      const msg = body && body.error ? body.error : 'Upload failed (' + res.status + ').';
      if (res.status === 401) {
        showError('Upload link expired or already used. Deposit still stands — request a new upload link.');
      } else {
        showError(msg);
      }
      return;
    }

    picker.hidden = true;
    successEl.hidden = false;
    statusEl.textContent = '';
  } catch (err) {
    showError(err && err.message ? err.message : 'Upload failed.');
  } finally {
    setBusy(false);
  }
}
