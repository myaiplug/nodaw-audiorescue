export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_SECONDS = 300;

/** WAV duration from fmt `byteRate` and `data` chunk size. */
export function estimateWavDurationSec(buf) {
  if (buf.byteLength < 44) return null;
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);
  if (
    u8[0] !== 0x52 || u8[1] !== 0x49 || u8[2] !== 0x46 || u8[3] !== 0x46 ||
    u8[8] !== 0x57 || u8[9] !== 0x41 || u8[10] !== 0x56 || u8[11] !== 0x45
  ) {
    return null;
  }

  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buf.byteLength) {
    const id0 = u8[offset];
    const id1 = u8[offset + 1];
    const id2 = u8[offset + 2];
    const id3 = u8[offset + 3];
    const size = view.getUint32(offset + 4, true);
    if (id0 === 0x66 && id1 === 0x6d && id2 === 0x74 && id3 === 0x20) {
      if (size >= 16 && offset + 20 <= buf.byteLength) {
        byteRate = view.getUint32(offset + 16, true);
      }
    } else if (id0 === 0x64 && id1 === 0x61 && id2 === 0x74 && id3 === 0x61) {
      dataSize = size;
    }
    const next = offset + 8 + size + (size & 1);
    if (next <= offset) break;
    offset = next;
  }
  if (byteRate <= 0 || dataSize < 0) return null;
  return dataSize / byteRate;
}

export function validateAudioHeaders(buf, filename) {
  if (buf.byteLength > MAX_BYTES) return { ok: false, error: 'File exceeds 50 MB limit.' };
  const name = filename.toLowerCase();
  const u8 = new Uint8Array(buf);
  const isWav = name.endsWith('.wav') && u8[0]===0x52 && u8[1]===0x49 && u8[2]===0x46 && u8[3]===0x46
    && u8[8]===0x57 && u8[9]===0x41 && u8[10]===0x56 && u8[11]===0x45;
  const isMp3 = name.endsWith('.mp3') && (
    (u8[0]===0x49 && u8[1]===0x44 && u8[2]===0x33) || // ID3
    (u8[0]===0xff && (u8[1] & 0xe0) === 0xe0) // frame sync
  );
  if (isWav) {
    const durationSec = estimateWavDurationSec(buf);
    return { ok: true, format: 'wav', size: buf.byteLength, durationSec };
  }
  if (isMp3) return { ok: true, format: 'mp3', size: buf.byteLength };
  return { ok: false, error: 'Only real MP3 or WAV files are allowed.' };
}
