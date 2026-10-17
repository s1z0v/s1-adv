// Decode the device's small mu-law WAV to ordinary PCM WAV before STT.
// Older raw PCM callers and other provider-supported WAVs stay compatible.
export function decodeVoiceUpload(bytes, maxPcmBytes) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return bytes;
  let format, data;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4), start = at + 8;
    if (size > bytes.length - start) throw new Error('invalid_voice_wav_chunk');
    const kind = bytes.toString('ascii', at, at + 4);
    if (kind === 'fmt ') format = bytes.subarray(start, start + size);
    if (kind === 'data') data = bytes.subarray(start, start + size);
    at = start + size + (size & 1);
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 7) return bytes;
  const rate = format.readUInt32LE(4);
  if (!data || format.readUInt16LE(2) !== 1 || format.readUInt16LE(12) !== 1 || format.readUInt16LE(14) !== 8 || rate < 8000 || rate > 48000) throw new Error('invalid_voice_mulaw_format');
  if (data.length * 2 > maxPcmBytes) throw new Error('decoded_voice_too_large');
  const out = Buffer.alloc(44 + data.length * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(data.length * 2, 40);
  for (let i = 0; i < data.length; ++i) {
    const code = (~data[i]) & 255, magnitude = (((code & 15) << 3) + 132) << ((code >> 4) & 7);
    out.writeInt16LE(code & 128 ? 132 - magnitude : magnitude - 132, 44 + i * 2);
  }
  return out;
}
