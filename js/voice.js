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

  async function convert(file) {
    let decoded;
    try { decoded = await decode(file); } catch (e) { throw new Error('This browser cannot read that audio file. Try .m4a, .mp3 or .wav.'); }
    const mono = await toMono22k(decoded);
    return BZ.wavBlob(trimAndNormalize(mono), RATE);
  }

  return { convert };
})();
