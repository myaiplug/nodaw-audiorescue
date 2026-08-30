export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_SECONDS = 300;

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
  if (isWav) return { ok: true, format: 'wav', size: buf.byteLength };
  if (isMp3) return { ok: true, format: 'mp3', size: buf.byteLength };
  return { ok: false, error: 'Only real MP3 or WAV files are allowed.' };
}
