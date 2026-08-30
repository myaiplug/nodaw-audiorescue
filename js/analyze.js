import {
  estimateWavDurationSec,
  MAX_BYTES,
  MAX_SECONDS,
  validateAudioHeaders,
} from './audioValidate.js';

export { MAX_BYTES, MAX_SECONDS };

const CLIP_THRESH = 0.99;
const ENV_COLS = 480;

function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function db(x) {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

function fmtDb(x) {
  const n = db(x);
  return (n > 0 ? '+' : '') + n.toFixed(1);
}

async function decodeToChannels(buf) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio is not available in this browser.');
  const ctx = new AC();
  try {
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const channelData = [];
    for (let c = 0; c < audio.numberOfChannels; c++) {
      channelData.push(audio.getChannelData(c));
    }
    return {
      channelData,
      sampleRate: audio.sampleRate,
      duration: audio.duration,
      length: audio.length,
    };
  } finally {
    try { await ctx.close(); } catch (_) { /* ignore */ }
  }
}

export function hotZoneThreshold(envelope) {
  if (!envelope.length) return CLIP_THRESH;
  const sorted = envelope.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  return Math.min(CLIP_THRESH, Math.max(0.95, median * 1.6));
}

function hotZonesFromEnvelope(envelope) {
  if (!envelope.length) return [];
  const thresh = hotZoneThreshold(envelope);
  const zones = [];
  let start = -1;
  let kind = 'hot';
  for (let i = 0; i <= envelope.length; i++) {
    const v = i < envelope.length ? envelope[i] : 0;
    const hot = i < envelope.length && v >= thresh;
    if (hot) {
      if (start < 0) {
        start = i;
        kind = v >= CLIP_THRESH ? 'clip' : 'hot';
      } else if (v >= CLIP_THRESH) {
        kind = 'clip';
      }
    } else if (start >= 0) {
      zones.push({
        start: start / envelope.length,
        end: i / envelope.length,
        kind,
      });
      start = -1;
    }
  }
  return zones.slice(0, 24);
}

function buildFindings(m) {
  const findings = [];

  if (m.clipEstimate > 0) {
    findings.push({
      severity: m.clipEstimate > 200 ? 'critical' : 'warn',
      title: 'Clipping is eating the transients',
      detail:
        m.clipEstimate.toLocaleString() +
        ' samples sitting at the ceiling (|s| ≥ 0.99). That is distortion, not loudness.',
    });
  }

  const peakDb = db(m.peak);
  if (m.peak >= CLIP_THRESH) {
    findings.push({
      severity: 'critical',
      title: 'The peak is slammed',
      detail:
        'Sample peak is ' +
        fmtDb(m.peak) +
        ' dBFS. There is no headroom left for a rescue pass or a limiter that is not already brickwalling.',
    });
  } else if (peakDb > -1) {
    findings.push({
      severity: 'warn',
      title: 'No headroom',
      detail:
        'Peak is ' +
        fmtDb(m.peak) +
        ' dBFS. A focused pass needs space; this bounce is already at the ceiling.',
    });
  } else if (peakDb < -18) {
    findings.push({
      severity: 'info',
      title: 'This bounce is quiet',
      detail:
        'Peak is ' +
        fmtDb(m.peak) +
        ' dBFS. Either the mix is unfinished or the export is padded. We can work with it — just saying.',
    });
  }

  if (m.crest < 6) {
    findings.push({
      severity: 'critical',
      title: 'Dynamics are crushed',
      detail:
        'Crest is ' +
        m.crest.toFixed(1) +
        ' dB. The mix is already limited into a block. A rescue can clean tone, not invent punch that was squashed out.',
    });
  } else if (m.crest < 8) {
    findings.push({
      severity: 'warn',
      title: 'Punch is running out',
      detail:
        'Crest is ' +
        m.crest.toFixed(1) +
        ' dB. Transients are getting short. A pass can help, but this is already loud-for-loudness-sake.',
    });
  }

  if (m.lufsEst > -9) {
    findings.push({
      severity: 'warn',
      title: 'Hotter than streaming wants',
      detail:
        'Est. LUFS is ' +
        m.lufsEst.toFixed(1) +
        '. Platforms will turn this down. Loud here is not loud on Spotify.',
    });
  } else if (m.lufsEst < -23) {
    findings.push({
      severity: 'info',
      title: 'Quiet against a release target',
      detail:
        'Est. LUFS is ' +
        m.lufsEst.toFixed(1) +
        '. Fine as a mix bounce; not a release master. Guidance only — not a metered spec.',
    });
  }

  if (m.channels > 1 && m.phase < 0) {
    findings.push({
      severity: 'critical',
      title: 'The stereo image is fighting itself',
      detail:
        'L/R correlation is ' +
        m.phase.toFixed(2) +
        '. Mono playback will hollow out. Check flipped tracks, mid/side, or a bass that is not actually centered.',
    });
  } else if (m.channels > 1 && m.phase < 0.3) {
    findings.push({
      severity: 'warn',
      title: 'Phase is loose',
      detail:
        'L/R correlation is ' +
        m.phase.toFixed(2) +
        '. The sides are wide, but the center may collapse in a car or a phone speaker.',
    });
  }

  if (m.channels > 1 && m.width > 0.65) {
    findings.push({
      severity: 'warn',
      title: 'Width is doing too much',
      detail:
        'Side energy is ' +
        Math.round(m.width * 100) +
        '% of the image. Hook and vocal will feel smaller than the bed.',
    });
  }

  if (m.bands.sub > 0.28) {
    findings.push({
      severity: 'warn',
      title: 'Sub is taking the floor',
      detail:
        'Sub band is ' +
        Math.round(m.bands.sub * 100) +
        '% of energy. Kick and bass are smearing — the car test will fail first.',
    });
  }
  if (m.bands.high > 0.38) {
    findings.push({
      severity: 'warn',
      title: 'The top is harsh',
      detail:
        'High band is ' +
        Math.round(m.bands.high * 100) +
        '% of energy. That is the “vocal too sharp” complaint. Ease the air, don’t just turn it down.',
    });
  }
  if (m.bands.mid < 0.18) {
    findings.push({
      severity: 'warn',
      title: 'Mids are missing',
      detail:
        'Mid band is ' +
        Math.round(m.bands.mid * 100) +
        '% of energy. The hook is probably buried. Presence lives here.',
    });
  }

  const rank = { critical: 0, warn: 1, info: 2 };
  findings.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  if (!findings.length) {
    findings.push({
      severity: 'info',
      title: 'No hard holds on the meters',
      detail:
        'The bounce is behaving. Translation, vocal sit, and taste still need ears — meters do not ship records.',
    });
  }
  return findings.slice(0, 8);
}

function scoreFrom(m) {
  let score = 80;

  if (m.clipEstimate > 10000) score -= 28;
  else if (m.clipEstimate > 1000) score -= 18;
  else if (m.clipEstimate > 50) score -= 10;
  else if (m.clipEstimate > 0) score -= 6;

  const peakDb = db(m.peak);
  if (m.peak >= CLIP_THRESH) score -= 10;
  else if (peakDb > -0.5) score -= 5;
  else if (peakDb < -18) score -= 10;
  else if (peakDb < -12) score -= 4;

  if (m.crest < 6) score -= 14;
  else if (m.crest < 8) score -= 7;
  else if (m.crest > 18) score -= 4;

  if (m.lufsEst > -8) score -= 12;
  else if (m.lufsEst > -11) score -= 5;
  else if (m.lufsEst < -23) score -= 8;
  else if (m.lufsEst >= -16 && m.lufsEst <= -12) score += 4;

  if (m.channels > 1) {
    if (m.phase < 0) score -= 20;
    else if (m.phase < 0.2) score -= 10;
    else if (m.phase < 0.45) score -= 5;
    if (m.width < 0.05) score -= 4;
    if (m.width > 0.65) score -= 6;
  }

  if (m.bands.sub > 0.28) score -= 8;
  if (m.bands.low > 0.42) score -= 6;
  if (m.bands.high > 0.38) score -= 8;
  if (m.bands.mid < 0.18) score -= 6;
  else if (m.bands.mid > 0.28 && m.bands.mid < 0.5) score += 3;

  return clamp(Math.round(score), 0, 100);
}

function verdictFor(score) {
  if (score >= 75) return 'Salvageable. The bones are there.';
  if (score >= 50) return 'Borderline. A focused pass might save it — or it might not.';
  return 'Re-record likely. The source is fighting the mix.';
}

function nextMoveFor(score) {
  if (score >= 75) {
    return 'Open Mix Rescue · $19.50 deposit. A focused pass can land this tonight.';
  }
  if (score >= 50) {
    return 'Open Mix Rescue · $19.50 deposit. We will tell you fit / not a fit before burning a pass.';
  }
  return 'Get the honest call. $19.50 deposit — $14.50 back if it is not a fit.';
}

/** Channel arrays in, AnalysisResult out. Used by tests and analyzeFile. */
export function analyzeChannels(channelData, sampleRate, meta) {
  if (!channelData || !channelData.length || !channelData[0] || !channelData[0].length) {
    throw new Error('Could not decode audio. Send a real MP3 or WAV.');
  }
  const sr = Number(sampleRate);
  if (!Number.isFinite(sr) || sr <= 0) {
    throw new Error('Could not decode audio. Send a real MP3 or WAV.');
  }

  const channels = channelData.length;
  const n = channelData[0].length;
  const duration = n / sr;
  if (duration > MAX_SECONDS) {
    throw new Error('File is ' + fmtDuration(duration) + '. Max is 5:00.');
  }

  const left = channelData[0];
  const right = channels > 1 ? channelData[1] : null;
  const stereo = !!right;

  let peak = 0;
  let clipEstimate = 0;
  let sumSq = 0;
  let sumLR = 0;
  let sumL2 = 0;
  let sumR2 = 0;
  let midE = 0;
  let sideE = 0;

  const envCols = Math.min(ENV_COLS, n);
  const envPer = Math.ceil(n / envCols);
  const envelope = new Array(envCols).fill(0);

  let lp60 = 0;
  let lp250 = 0;
  let lp4k = 0;
  let eSub = 0;
  let eLow = 0;
  let eMid = 0;
  let eHigh = 0;
  const a60 = Math.exp((-2 * Math.PI * 60) / sr);
  const a250 = Math.exp((-2 * Math.PI * 250) / sr);
  const a4k = Math.exp((-2 * Math.PI * 4000) / sr);
  const b60 = 1 - a60;
  const b250 = 1 - a250;
  const b4k = 1 - a4k;

  for (let i = 0; i < n; i++) {
    const L = left[i];
    const R = stereo ? right[i] : L;
    const aL = L < 0 ? -L : L;
    const aR = R < 0 ? -R : R;
    if (aL > peak) peak = aL;
    if (aR > peak) peak = aR;
    if (aL >= CLIP_THRESH) clipEstimate++;
    if (stereo && aR >= CLIP_THRESH) clipEstimate++;

    sumSq += L * L + (stereo ? R * R : 0);
    sumL2 += L * L;
    sumR2 += R * R;
    sumLR += L * R;

    const mid = 0.5 * (L + R);
    const side = 0.5 * (L - R);
    midE += mid * mid;
    sideE += side * side;

    const envI = (i / envPer) | 0;
    if (envI < envCols) {
      const m = aL > aR ? aL : aR;
      if (m > envelope[envI]) envelope[envI] = m;
    }

    lp60 = a60 * lp60 + b60 * mid;
    lp250 = a250 * lp250 + b250 * mid;
    lp4k = a4k * lp4k + b4k * mid;
    const sub = lp60;
    const low = lp250 - lp60;
    const midBand = lp4k - lp250;
    const high = mid - lp4k;
    eSub += sub * sub;
    eLow += low * low;
    eMid += midBand * midBand;
    eHigh += high * high;
  }

  const sampleCount = n * (stereo ? 2 : 1);
  const meanSq = sumSq / sampleCount;
  const rms = Math.sqrt(Math.max(meanSq, 0));
  const crest = db(peak) - db(rms);
  const lufsEst = -0.691 + 10 * Math.log10(Math.max(meanSq, 1e-12));
  const width = stereo ? sideE / Math.max(midE + sideE, 1e-12) : 0;
  const denom = Math.sqrt(sumL2 * sumR2);
  const phase = stereo ? (denom > 0 ? clamp(sumLR / denom, -1, 1) : 1) : 1;

  const bandSum = eSub + eLow + eMid + eHigh;
  const bands = bandSum > 0
    ? { sub: eSub / bandSum, low: eLow / bandSum, mid: eMid / bandSum, high: eHigh / bandSum }
    : { sub: 0, low: 0, mid: 0, high: 0 };

  const format = meta && meta.format ? meta.format : 'wav';
  const metrics = {
    peak,
    clipEstimate,
    crest,
    lufsEst,
    width,
    phase,
    bands,
    channels,
  };
  const score = scoreFrom(metrics);
  const verdict = verdictFor(score);
  const findings = buildFindings(metrics);

  return {
    score,
    verdict,
    duration,
    format,
    sampleRate: sr,
    channels,
    lufsEst,
    peak,
    clipEstimate,
    crest,
    width,
    phase,
    bands,
    findings,
    nextMove: nextMoveFor(score),
    rms,
    envelope,
    hotZones: hotZonesFromEnvelope(envelope),
    filename: (meta && meta.filename) || '',
  };
}

export async function analyzeFile(file) {
  if (!file) throw new Error('Choose an MP3 or WAV.');
  if (file.size > MAX_BYTES) throw new Error('File exceeds 50 MB limit.');

  const bytes = await file.arrayBuffer();
  const header = validateAudioHeaders(bytes, file.name);
  if (!header.ok) throw new Error(header.error);

  if (header.format === 'wav') {
    const est = header.durationSec ?? estimateWavDurationSec(bytes);
    if (est != null && est > MAX_SECONDS) {
      throw new Error('File is ' + fmtDuration(est) + '. Max is 5:00.');
    }
  }

  let decoded;
  try {
    decoded = await decodeToChannels(bytes);
  } catch (err) {
    if (err && /5:00/.test(err.message)) throw err;
    throw new Error('Could not decode audio. Send a real MP3 or WAV.');
  }

  if (!decoded || !Number.isFinite(decoded.duration) || decoded.length < 32) {
    throw new Error('Could not decode audio. Send a real MP3 or WAV.');
  }
  if (decoded.duration > MAX_SECONDS) {
    throw new Error('File is ' + fmtDuration(decoded.duration) + '. Max is 5:00.');
  }

  return analyzeChannels(decoded.channelData, decoded.sampleRate, {
    format: header.format,
    filename: file.name,
  });
}
