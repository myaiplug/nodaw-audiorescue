export const VIEW_KEY = 'nodawReportView';

export function readStoredView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'studio' || v === 'dossier') return v;
  } catch (_) { /* private mode */ }
  return 'dossier';
}

export function writeStoredView(view) {
  const v = view === 'studio' ? 'studio' : 'dossier';
  try { localStorage.setItem(VIEW_KEY, v); } catch (_) { /* ignore */ }
  return v;
}

function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function dbfs(x) {
  const n = 20 * Math.log10(Math.max(Number(x) || 0, 1e-12));
  return (n > 0 ? '+' : '') + n.toFixed(1);
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function fmtSr(sr) {
  if (!Number.isFinite(sr)) return '—';
  if (sr >= 1000) return (sr / 1000).toFixed(sr % 1000 === 0 ? 0 : 1) + ' kHz';
  return Math.round(sr) + ' Hz';
}

function chLabel(n) {
  if (n === 1) return 'Mono';
  if (n === 2) return 'Stereo';
  return String(n) + ' ch';
}

function pct(x) {
  return Math.round((Number(x) || 0) * 100) + '%';
}

function scoreTone(score) {
  if (score >= 75) return 'good';
  if (score >= 50) return 'mid';
  return 'bad';
}

function depositCta() {
  return '<a class="button" data-open-deposit href="/?open=deposit">Open Mix Rescue · $19.50 deposit ↗</a>';
}

function viewToggle(view) {
  return (
    '<div class="view-toggle" role="tablist" aria-label="Report view">' +
      '<button type="button" role="tab" data-view="dossier" aria-selected="' + (view === 'dossier' ? 'true' : 'false') + '"' +
        (view === 'dossier' ? ' class="on"' : '') + '>Dossier</button>' +
      '<button type="button" role="tab" data-view="studio" aria-selected="' + (view === 'studio' ? 'true' : 'false') + '"' +
        (view === 'studio' ? ' class="on"' : '') + '>Full studio</button>' +
    '</div>'
  );
}

function meterCell(k, v, tone) {
  return (
    '<div class="meter-cell">' +
      '<span class="k">' + esc(k) + '</span>' +
      '<span class="v' + (tone ? ' ' + tone : '') + '">' + esc(v) + '</span>' +
    '</div>'
  );
}

function meters(result) {
  const peakTone = result.peak >= 0.99 ? 'bad' : result.peak >= 0.95 ? 'mid' : 'good';
  const clipTone = result.clipEstimate > 0 ? 'bad' : 'good';
  const lufsTone = result.lufsEst > -9 ? 'bad' : result.lufsEst < -23 ? 'mid' : '';
  const phaseTone = result.channels > 1 && result.phase < 0 ? 'bad' : result.channels > 1 && result.phase < 0.3 ? 'mid' : '';
  return (
    meterCell('Duration', fmtDuration(result.duration)) +
    meterCell('Format', String(result.format || '').toUpperCase()) +
    meterCell('Sample rate', fmtSr(result.sampleRate)) +
    meterCell('Channels', chLabel(result.channels)) +
    meterCell('Est. LUFS', (Number(result.lufsEst) || 0).toFixed(1), lufsTone) +
    meterCell('Peak', dbfs(result.peak) + ' dBFS', peakTone) +
    meterCell('Clip hits', Number(result.clipEstimate || 0).toLocaleString(), clipTone) +
    meterCell('Crest', (Number(result.crest) || 0).toFixed(1) + ' dB') +
    meterCell('Width', pct(result.width)) +
    meterCell('Phase', (Number(result.phase) || 0).toFixed(2), phaseTone) +
    meterCell('Sub', pct(result.bands && result.bands.sub)) +
    meterCell('Low', pct(result.bands && result.bands.low)) +
    meterCell('Mid', pct(result.bands && result.bands.mid)) +
    meterCell('High', pct(result.bands && result.bands.high))
  );
}

function findingsList(result, mode) {
  const items = (result.findings || []).map((f) => {
    const sev = f.severity === 'critical' || f.severity === 'warn' || f.severity === 'info' ? f.severity : 'info';
    if (mode === 'check') {
      return (
        '<li class="check ' + sev + '">' +
          '<span class="box" aria-hidden="true"></span>' +
          '<div><b>' + esc(f.title) + '</b><p>' + esc(f.detail) + '</p></div>' +
        '</li>'
      );
    }
    return (
      '<li class="finding ' + sev + '">' +
        '<span class="sev">' + esc(sev) + '</span>' +
        '<div><b>' + esc(f.title) + '</b><p>' + esc(f.detail) + '</p></div>' +
      '</li>'
    );
  });
  return '<ul class="' + (mode === 'check' ? 'checks' : 'findings') + '">' + items.join('') + '</ul>';
}

function studioHeadline(result) {
  const top = result.findings && result.findings[0];
  if (top && top.severity === 'critical') return top.title;
  if (result.score >= 75) return 'This mix can still be a record.';
  if (result.score >= 50) return 'Close. Not released.';
  return 'The source is the problem.';
}

export function reportHtml(result, view) {
  const v = view === 'studio' ? 'studio' : 'dossier';
  const tone = scoreTone(result.score);
  const name = result.filename ? esc(result.filename) : 'UNTITLED BOUNCE';
  const footnote =
    '<p class="est-note">LUFS, peak, and clip hits are in-browser estimates from decoded samples — not an ITU-R BS.1770 meter. File never left this device.</p>';

  if (v === 'studio') {
    return (
      '<section class="report studio">' +
        viewToggle(v) +
        '<p class="kicker">CoProducer // full studio</p>' +
        '<p class="file-line mono">' + name + ' · ' + esc(fmtDuration(result.duration)) + ' · ' + esc(chLabel(result.channels)) + '</p>' +
        '<h2 class="editorial">' + esc(studioHeadline(result)) + '</h2>' +
        '<p class="verdict-line ' + tone + '">' + esc(result.verdict) + ' <span class="score-inline">' + esc(String(result.score)) + '</span></p>' +
        '<div class="wave-host">' +
          '<canvas id="report-wave" aria-label="Waveform with hot zones"></canvas>' +
        '</div>' +
        '<p class="section-label">Severity checklist</p>' +
        findingsList(result, 'check') +
        '<p class="section-label">Meter appendix</p>' +
        '<div class="meter-grid appendix">' + meters(result) + '</div>' +
        '<p class="next">' + esc(result.nextMove) + '</p>' +
        depositCta() +
        footnote +
      '</section>'
    );
  }

  return (
    '<section class="report dossier">' +
      viewToggle(v) +
      '<p class="kicker">CoProducer // dossier</p>' +
      '<div class="score-row">' +
        '<div class="score-block">' +
          '<span class="k">Score</span>' +
          '<span class="score ' + tone + '">' + esc(String(result.score)) + '</span>' +
        '</div>' +
        '<span class="verdict-chip ' + tone + '">' + esc(result.verdict) + '</span>' +
      '</div>' +
      '<div class="meter-grid">' + meters(result) + '</div>' +
      '<p class="section-label">Holds</p>' +
      findingsList(result, 'list') +
      '<p class="next">' + esc(result.nextMove) + '</p>' +
      depositCta() +
      footnote +
    '</section>'
  );
}

function drawWave(canvas, result) {
  if (!canvas || !result.envelope || !result.envelope.length) return;
  const wrap = canvas.parentElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = wrap.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round((rect.height || 140) * dpr));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#0a0b0b';
  ctx.fillRect(0, 0, w, h);

  const zones = result.hotZones || [];
  for (const z of zones) {
    const x = z.start * w;
    const zw = Math.max(2, (z.end - z.start) * w);
    ctx.fillStyle = z.kind === 'clip' ? 'rgba(255,92,27,.28)' : 'rgba(255,92,27,.14)';
    ctx.fillRect(x, 0, zw, h);
  }

  const env = result.envelope;
  const cols = env.length;
  const cx = w / cols;
  for (let i = 0; i < cols; i++) {
    const mag = Math.max(0, Math.min(1, env[i]));
    const bh = mag * h * 0.86;
    const hot = mag >= 0.95;
    ctx.fillStyle = hot ? '#ff5c1b' : '#d8ff35';
    ctx.globalAlpha = hot ? 0.9 : 0.55;
    ctx.fillRect(Math.round(i * cx), (h - bh) / 2, Math.max(1, cx - 1), bh);
  }
  ctx.globalAlpha = 1;
}

export function renderReport(root, result, view) {
  if (!root) return;
  const v = view === 'studio' || view === 'dossier' ? view : readStoredView();
  root.innerHTML = reportHtml(result, v);
  root.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = writeStoredView(btn.getAttribute('data-view'));
      renderReport(root, result, next);
    });
  });
  root._nodawResult = result;
  if (v === 'studio') {
    drawWave(root.querySelector('#report-wave'), result);
    if (!root._nodawOnResize) {
      root._nodawOnResize = () => {
        const c = root.querySelector('#report-wave');
        if (c) drawWave(c, root._nodawResult);
      };
      window.addEventListener('resize', root._nodawOnResize);
    }
  }
}
