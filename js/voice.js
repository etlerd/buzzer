// Turns any recording the browser can decode (.mp3, .wav, iPhone .m4a, …)
// into a small 16-bit mono WAV at 22050 Hz, trimmed and level-normalized,
// so every name plays at the same volume.
window.Voice = (function () {
  const RATE = 22050;
  const MAX_SECONDS = 4;

  async function decode(file) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try {
      const buf = await file.arrayBuffer();
      return await new Promise((res, rej) => {
        const p = ctx.decodeAudioData(buf, res, rej);  // callback form for older Safari
        if (p && p.then) p.then(res, rej);
      });
    } finally {
      ctx.close && ctx.close();
    }
  }

  async function toMono22k(audioBuffer) {
    const len = Math.max(1, Math.ceil(audioBuffer.duration * RATE));
    const off = new OfflineAudioContext(1, len, RATE);  // mixes down to mono
    const src = off.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0);
  }

  function trimAndNormalize(data) {
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    if (peak < 0.003) throw new Error('That file is silent.');
    const threshold = peak * 0.06;
    let start = 0;
    let end = data.length - 1;
    while (start < end && Math.abs(data[start]) < threshold) start++;
    while (end > start && Math.abs(data[end]) < threshold) end--;
    const pad = Math.round(RATE * 0.05);
    start = Math.max(0, start - pad);
    end = Math.min(data.length, end + pad, start + RATE * MAX_SECONDS);
    const gain = 0.9 / peak;
    const out = new Float32Array(end - start);
    for (let i = 0; i < out.length; i++) out[i] = data[start + i] * gain;
    // 10 ms fades so clips start and stop without clicks
    const f = Math.min(out.length >> 1, Math.round(RATE * 0.01));
    for (let i = 0; i < f; i++) { out[i] *= i / f; out[out.length - 1 - i] *= i / f; }
    return out;
  }

  function encodeWav(samples) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function convert(file) {
    let decoded;
    try { decoded = await decode(file); } catch (e) { throw new Error('This browser cannot read that audio file. Try .m4a, .mp3 or .wav.'); }
    const mono = await toMono22k(decoded);
    return encodeWav(trimAndNormalize(mono));
  }

  return { convert, encodeWav, trimAndNormalize };
})();
