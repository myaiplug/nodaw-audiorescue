import { describe, it, expect } from 'vitest';
import { analyzeChannels, hotZoneThreshold, MAX_SECONDS } from '../js/analyze.js';
import { reportHtml } from '../js/report.js';

function sine(n: number, freq: number, sr: number, amp = 0.5) {
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sr;
  for (let i = 0; i < n; i++) out[i] = Math.sin(i * w) * amp;
  return out;
}

describe('analyzeChannels', () => {
  it('returns required AnalysisResult fields for a short sine', () => {
    const sr = 44100;
    const n = sr; // 1s
    const r = analyzeChannels([sine(n, 440, sr, 0.5)], sr, { format: 'wav', filename: 'tone.wav' });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.verdict).toMatch(/Salvageable|Borderline|Re-record/);
    expect(r.duration).toBeCloseTo(1, 3);
    expect(r.format).toBe('wav');
    expect(r.sampleRate).toBe(sr);
    expect(r.channels).toBe(1);
    expect(r.peak).toBeGreaterThan(0.4);
    expect(r.peak).toBeLessThan(0.51);
    expect(r.clipEstimate).toBe(0);
    expect(r.crest).toBeGreaterThan(0);
    expect(r.lufsEst).toBeLessThan(0);
    expect(r.width).toBe(0);
    expect(r.phase).toBe(1);
    expect(r.bands.sub + r.bands.low + r.bands.mid + r.bands.high).toBeCloseTo(1, 5);
    expect(r.bands.mid).toBeGreaterThan(r.bands.sub);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.nextMove).toMatch(/\$19\.50/);
    expect(r.filename).toBe('tone.wav');
  });

  it('counts clips at |s| >= 0.99 and drops the score', () => {
    const sr = 8000;
    const clean = sine(sr, 220, sr, 0.4);
    const clipped = new Float32Array(sr);
    clipped.fill(1);
    const a = analyzeChannels([clean], sr, { format: 'wav' });
    const b = analyzeChannels([clipped], sr, { format: 'wav' });
    expect(b.clipEstimate).toBe(sr);
    expect(b.peak).toBe(1);
    expect(b.score).toBeLessThan(a.score);
    expect(b.findings.some((f) => /clip/i.test(f.title) || /slam/i.test(f.title))).toBe(true);
  });

  it('flags out-of-phase stereo', () => {
    const sr = 8000;
    const L = sine(sr, 200, sr, 0.5);
    const R = new Float32Array(sr);
    for (let i = 0; i < sr; i++) R[i] = -L[i];
    const r = analyzeChannels([L, R], sr, { format: 'wav' });
    expect(r.channels).toBe(2);
    expect(r.phase).toBeLessThan(0);
    expect(r.width).toBeGreaterThan(0.9);
    expect(r.findings.some((f) => /stereo|phase/i.test(f.title))).toBe(true);
  });

  it('emits hotZones on brickwalled material (threshold capped at 0.99)', () => {
    const sr = 8000;
    const clipped = new Float32Array(sr);
    clipped.fill(1);
    const r = analyzeChannels([clipped], sr, { format: 'wav' });
    expect(hotZoneThreshold(r.envelope)).toBeLessThanOrEqual(0.99);
    expect(r.hotZones.length).toBeGreaterThan(0);
    expect(r.hotZones.some((z) => z.kind === 'clip')).toBe(true);
    const span = r.hotZones.reduce((s, z) => s + (z.end - z.start), 0);
    expect(span).toBeGreaterThan(0.5);
  });

  it('rejects duration over 300 seconds', () => {
    const sr = 1000;
    const n = (MAX_SECONDS + 1) * sr;
    expect(() => analyzeChannels([new Float32Array(n)], sr, { format: 'wav' })).toThrow(/5:00/);
  });
});

describe('reportHtml', () => {
  const result = analyzeChannels([sine(8000, 440, 8000, 0.5)], 8000, { format: 'mp3', filename: 'x.mp3' });

  it('renders Dossier with score, verdict chip, meters, findings, deposit CTA', () => {
    const html = reportHtml(result, 'dossier');
    expect(html).toContain('class="report dossier"');
    expect(html).toContain(String(result.score));
    expect(html).toContain('verdict-chip');
    expect(html).toContain('Est. LUFS');
    expect(html).toContain('data-open-deposit');
    expect(html).toContain('/?open=deposit');
    expect(html).toContain('Dossier');
    expect(html).toContain(result.findings[0].title);
  });

  it('renders Full studio with editorial, waveform canvas, checklist, appendix, CTA', () => {
    const html = reportHtml(result, 'studio');
    expect(html).toContain('class="report studio"');
    expect(html).toContain('report-wave');
    expect(html).toContain('Severity checklist');
    expect(html).toContain('Meter appendix');
    expect(html).toContain('data-open-deposit');
    expect(html).toContain('Est. LUFS');
  });
});
