import { describe, it, expect } from 'vitest';
import {
  estimateWavDurationSec,
  validateAudioHeaders,
  MAX_BYTES,
} from '../functions/lib/audioValidate';

function wavHeader(dataBytes = 100, byteRate = 44100 * 2 * 2): ArrayBuffer {
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const enc = new TextEncoder();
  enc.encodeInto('RIFF', new Uint8Array(buf, 0, 4));
  v.setUint32(4, 36 + dataBytes, true);
  enc.encodeInto('WAVE', new Uint8Array(buf, 8, 4));
  enc.encodeInto('fmt ', new Uint8Array(buf, 12, 4));
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  enc.encodeInto('data', new Uint8Array(buf, 36, 4));
  v.setUint32(40, dataBytes, true);
  return buf;
}

describe('validateAudioHeaders', () => {
  it('accepts WAV magic', () => {
    const r = validateAudioHeaders(wavHeader(), 'mix.wav');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.format).toBe('wav');
  });

  it('rejects exe renamed as mp3', () => {
    const bytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]); // MZ
    const r = validateAudioHeaders(bytes.buffer, 'hack.mp3');
    expect(r.ok).toBe(false);
  });

  it('rejects oversized', () => {
    const big = new ArrayBuffer(MAX_BYTES + 1);
    const r = validateAudioHeaders(big, 'big.wav');
    expect(r.ok).toBe(false);
  });

  it('rejects MP3 too large to be ≤5:00 at normal bitrates', () => {
    // ~16 MB with ID3 magic — over 320kbps×5:00×1.25 gate, under 50 MB cap
    const bytes = new Uint8Array(16 * 1024 * 1024);
    bytes[0] = 0x49;
    bytes[1] = 0x44;
    bytes[2] = 0x33;
    const r = validateAudioHeaders(bytes.buffer, 'long.mp3');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/5:00|bitrates/i);
  });
});

describe('estimateWavDurationSec', () => {
  it('uses fmt byteRate and data size', () => {
    expect(estimateWavDurationSec(wavHeader(1764, 1764))).toBe(1);
  });

  it('flags a file longer than 5:00', () => {
    const long = wavHeader(301_000, 1000);
    expect(estimateWavDurationSec(long)).toBe(301);
    const r = validateAudioHeaders(long, 'long.wav');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.durationSec).toBe(301);
  });

  it('walks past an extra LIST chunk', () => {
    const dataBytes = 1764;
    const byteRate = 1764;
    const buf = new ArrayBuffer(12 + 24 + 12 + 8 + dataBytes);
    const v = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const enc = new TextEncoder();
    enc.encodeInto('RIFF', u8.subarray(0, 4));
    v.setUint32(4, buf.byteLength - 8, true);
    enc.encodeInto('WAVE', u8.subarray(8, 12));
    enc.encodeInto('fmt ', u8.subarray(12, 16));
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 2, true);
    v.setUint32(24, 44100, true);
    v.setUint32(28, byteRate, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 16, true);
    enc.encodeInto('LIST', u8.subarray(36, 40));
    v.setUint32(40, 4, true);
    enc.encodeInto('data', u8.subarray(48, 52));
    v.setUint32(52, dataBytes, true);
    expect(estimateWavDurationSec(buf)).toBe(1);
  });
});
