// Shared helpers: configuration, MQTT connection, topics, storage, sound.
// All pages talk through one MQTT broker. Topic layout (ROOM = room code):
//   gsbuzz/v1/ROOM/state   retained  host -> everyone   full game state (JSON)
//   gsbuzz/v1/ROOM/voice/… retained  admin -> display    buzzer sounds (see admin.js)
//   gsbuzz/v1/ROOM/hello             player -> host     join + heartbeat {id,name}
//   gsbuzz/v1/ROOM/buzz              player -> host     {id, armId, rt}
(function () {
  const DEFAULT_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
  const PREFIX = 'gsbuzz/v1';
  const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

  const params = new URLSearchParams(location.search);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('gsbuzz.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('gsbuzz.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    },
    del(key) {
      try { localStorage.removeItem('gsbuzz.' + key); } catch (e) { /* ignore */ }
    },
  };

  function brokerUrl() {
    return params.get('broker') || store.get('broker', '') || DEFAULT_BROKER;
  }

  function cleanRoom(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  }

  function newRoomCode(len = 5) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => ROOM_CHARS[b % ROOM_CHARS.length]).join('');
  }

  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function topic(room, sub) {
    return `${PREFIX}/${room}/${sub}`;
  }

  // Stored (retained) messages, i.e. game state and buzzer sounds, expire on the broker after this.
  const EXPIRY_SECONDS = 14 * 24 * 3600;

  // Connect to the broker. onStatus receives 'connecting' | 'online' | 'offline'.
  // Uses MQTT 5 so stored messages can expire; falls back to MQTT 3.1.1 for a
  // broker that refuses version 5 (stored messages then never expire).
  function connect({ role, will, onStatus, onConnect }) {
    const url = brokerUrl();
    const listeners = [];
    let inner = null;
    let version = 5;
    const status = (s) => onStatus && onStatus(s);

    const client = {
      get connected() { return !!(inner && inner.connected); },
      get protocolVersion() { return version; },
      on(ev, fn) { listeners.push([ev, fn]); if (inner) inner.on(ev, fn); return client; },
      subscribe(...args) { return inner.subscribe(...args); },
      end(...args) { return inner.end(...args); },
      publish(t, payload, opts = {}, cb) {
        if (opts.retain && version === 5 && payload && payload.length) {
          opts = Object.assign({}, opts, { properties: { messageExpiryInterval: EXPIRY_SECONDS } });
        }
        return inner.publish(t, payload, opts, cb);
      },
    };

    function start() {
      const opts = {
        clientId: `gsbuzz-${role}-${newId()}`,
        clean: true,
        keepalive: 20,
        reconnectPeriod: 1500,
        connectTimeout: 8000,
        protocolVersion: version,
      };
      const user = params.get('user') || store.get('brokerUser', '');
      const pass = params.get('pass') || store.get('brokerPass', '');
      if (user) { opts.username = user; opts.password = pass; }
      if (will) opts.will = will;

      const c = mqtt.connect(url, opts);
      inner = c;
      c.on('connect', () => { if (inner === c) { status('online'); onConnect && onConnect(); } });
      c.on('reconnect', () => { if (inner === c) status('connecting'); });
      c.on('offline', () => { if (inner === c) status('offline'); });
      c.on('close', () => { if (inner === c) status('offline'); });
      c.on('error', (err) => {
        // CONNACK "unacceptable protocol version" (3.1.1 code 1, MQTT 5 code 132)
        if (version === 5 && err && (err.code === 1 || err.code === 132)) {
          version = 4;
          c.end(true);
          start();
          return;
        }
        console.warn('MQTT error', err && err.message);
      });
      for (const [ev, fn] of listeners) c.on(ev, fn);
    }
    status('connecting');
    start();
    return client;
  }

  // Player colors arrive over the network: accept only #RRGGBB so a forged
  // value cannot load anything (e.g. url(...)) when placed in a style.
  function safeColor(c) {
    return /^#[0-9a-f]{6}$/i.test(String(c)) ? c : '#888888';
  }
  function cleanState(s) {
    if (s && Array.isArray(s.players)) s.players.forEach((p) => { p.color = safeColor(p.color); });
    return s;
  }

  function parse(payload) {
    try {
      const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
      return text ? JSON.parse(text) : null;
    } catch (e) { return null; }
  }

  // Short synthesized sounds; no audio files needed.
  let audioCtx = null;
  function audio() {
    if (!audioCtx) {
      // iOS: count as media playback, so the ring/silent switch does not mute the page (iOS 17+)
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* unsupported */ }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') audioCtx.resume();
    return audioCtx;
  }

  // One shared <audio> element plays recordings. Browsers (iOS especially) only
  // allow sound from an element first started during a tap or click, so it is
  // "unlocked" with a moment of silence on the first one, then reused.
  let mediaEl = null;
  let mediaUnlocked = false;
  // Mono 16-bit WAV from samples in -1…1.
  function wavBlob(samples, rate) {
    const v = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([v.buffer], { type: 'audio/wav' });
  }
  function silentWavUrl() {
    return URL.createObjectURL(wavBlob(new Float32Array(800), 16000));
  }
  function media() {
    if (!mediaEl) {
      mediaEl = new Audio();
      mediaEl.preload = 'auto';
      mediaEl.setAttribute('playsinline', '');
    }
    return mediaEl;
  }
  function unlockMedia() {
    if (mediaUnlocked) return;
    const el = media();
    el.src = silentWavUrl();
    const p = el.play();
    if (p && p.then) p.then(() => { mediaUnlocked = true; }, () => { /* try again on next tap */ });
    else mediaUnlocked = true;
  }
  function playUrl(url) {
    const el = media();
    el.pause();
    el.src = url;
    el.currentTime = 0;
    return el.play();
  }
  function tone(freq, ms, type = 'square', gain = 0.15, delay = 0) {
    const ctx = audio();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay / 1000;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.02);
  }
  const sounds = {
    unlock() { audio(); unlockMedia(); },
    buzz() { tone(220, 450, 'sawtooth', 0.2); tone(110, 450, 'square', 0.12); },
    armed() { tone(880, 90, 'sine', 0.15); tone(1320, 120, 'sine', 0.15, 100); },
    correct() { tone(660, 120, 'triangle', 0.2); tone(880, 120, 'triangle', 0.2, 120); tone(1320, 260, 'triangle', 0.2, 240); },
    wrong() { tone(160, 600, 'sawtooth', 0.2); },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Build a URL for another page in this site, carrying room and custom broker settings.
  function pageUrl(page, room) {
    const url = new URL(page, location.href);
    url.search = '';
    if (room) url.searchParams.set('room', room);
    const b = brokerUrl();
    if (b !== DEFAULT_BROKER) url.searchParams.set('broker', b);
    return url.toString();
  }

  function renderQr(el, text) {
    if (!window.qrcode || !el) return;
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  // File key for a player's name recording: "Mary-Jo O'Neil" -> "maryjooneil"
  function voiceSlug(name) {
    let s = '';
    for (const ch of String(name || '')) {
      if (ch >= 'A' && ch <= 'Z') s += ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) s += ch;
      if (s.length >= 24) break;
    }
    return s;
  }

  // Collects buzzer sounds arriving over MQTT and makes them playable.
  //   voice/<slug>            retained manifest {id, n, bytes, name} (empty = deleted)
  //   voice/<slug>/<id>/<i>   retained WAV bytes, chunk i of n
  // onChange(slug, ready) fires when a sound becomes playable or is removed.
  const MAX_SOUND_BYTES = 1024 * 1024;
  const MAX_SOUND_CHUNKS = 40;
  function voiceStore(room, onChange) {
    const prefix = topic(room, 'voice/');
    const manifests = {};
    const chunks = {};
    const clips = {};

    function validManifest(m) {
      return m && typeof m.id === 'string' && Number.isInteger(m.n) && m.n >= 1 && m.n <= MAX_SOUND_CHUNKS &&
        Number.isInteger(m.bytes) && m.bytes > 44 && m.bytes <= MAX_SOUND_BYTES;
    }

    function assemble(slug) {
      const m = manifests[slug];
      if (!m || (clips[slug] && clips[slug].id === m.id)) return;
      const key = slug + '/' + m.id;
      const list = chunks[key] || [];
      for (let i = 0; i < m.n; i++) if (!list[i]) return;  // still arriving
      const total = list.reduce((a, c) => a + c.length, 0);
      delete chunks[key];
      if (total !== m.bytes) { console.warn('sound size mismatch for', slug); return; }
      const wav = new Uint8Array(total);
      let off = 0;
      for (const c of list) { wav.set(c, off); off += c.length; }
      // cheap check that it is a WAV file; playback itself reports anything worse
      const tag = (o) => String.fromCharCode(...wav.subarray(o, o + 4));
      if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') { console.warn('not a WAV file:', slug); return; }
      if (clips[slug]) URL.revokeObjectURL(clips[slug].url);
      clips[slug] = { id: m.id, url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })) };
      onChange && onChange(slug, true);
    }

    return {
      manifests,
      handle(t, payload) {
        if (!t.startsWith(prefix)) return;
        const parts = t.slice(prefix.length).split('/');
        const slug = parts[0];
        if (parts.length === 1) {
          const m = parse(payload);
          if (validManifest(m)) manifests[slug] = m;
          else {
            delete manifests[slug];
            if (clips[slug]) { URL.revokeObjectURL(clips[slug].url); delete clips[slug]; onChange && onChange(slug, false); }
          }
        } else if (parts.length === 3 && payload.length) {
          const i = Number(parts[2]);
          if (!Number.isInteger(i) || i < 0 || i >= MAX_SOUND_CHUNKS || payload.length > MAX_SOUND_BYTES) return;
          const key = slug + '/' + parts[1];
          (chunks[key] = chunks[key] || [])[i] = new Uint8Array(payload);
        }
        assemble(slug);
      },
      hasSlug(slug) { return !!clips[slug]; },
      pendingSlug(slug) { return !!manifests[slug] && !clips[slug]; },
      ready() { return Object.keys(clips); },
      // [{slug, name, ready}] for every stored recording, by name
      list() {
        return Object.keys(manifests)
          .map((slug) => ({ slug, name: manifests[slug].name || slug, ready: !!clips[slug] }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      // Resolves true when playback starts, false if there is no clip; rejects if the browser blocks it.
      playSlug(slug, delayMs = 0) {
        const clip = clips[slug];
        if (!clip) return Promise.resolve(false);
        const start = () => playUrl(clip.url).then(() => true);
        if (!delayMs) return start();
        return new Promise((res, rej) => setTimeout(() => start().then(res, rej), delayMs));
      },
    };
  }

  function setStatusBadge(el, s) {
    if (!el) return;
    el.dataset.status = s;
    el.textContent = s === 'online' ? 'Connected' : s === 'connecting' ? 'Connecting…' : 'Offline';
  }

  window.BZ = {
    DEFAULT_BROKER, PREFIX, params, store, brokerUrl, cleanRoom, newRoomCode, newId,
    topic, connect, parse, sounds, esc, pageUrl, renderQr, setStatusBadge, voiceSlug, voiceStore, wavBlob, safeColor, cleanState,
  };
})();
